/**
 * Gasless vault activation — the ONLY bootstrap path for an owner with no gas. The owner signs an
 * Activation (against the FACTORY's EIP-712 domain); the relayer deploys + activates the vault and
 * takes the fee from what was deposited to it: a stable coin, or — from v1.0.3 — ETH, paid as WETH. A fresh activated vault already relays, so
 * no separate setStableCoinAsGas is needed — activation IS "turning stablecoin-as-gas on".
 *
 * Ported from web `activateByStablecoin`. The fee is priced from live gas + ETH/USD and SIGNED, so the
 * server accepts it within a band (see core/activation-fee).
 */
import {encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {
  apiUrl,
  CHAIN_ID,
  publicClientFor,
  type Network,
} from '@/core/chain';
import {ACTIVATION_TYPES, GUARD_IMPL_ABI, IMPLEMENTATION_VAULT, PRICE_FEED_ABI} from '@/core/abi';
import {API_VERSION, VAULT_FACTORY, VAULT_GUARD} from '@/core/vault-contracts';
import {ACTIVATION_GAS, activationFeeUnits, relayFeeUnits} from '@/core/activation-fee';
// One copy of the ETH/USD feeds: the fee shown before signing and the fee actually signed must be
// priced from the same source, or the two disagree for no reason the user can see.
import {ETH_USD_FEED} from './fee-quote';
import {fetchPrices} from '@/core/prices';
import {sendFromOwner} from './direct';


/** Is the vault deployed (activated)? A counterfactual vault has no code until activation. */
export async function isActivated(vault: Address, network: Network): Promise<boolean> {
  const client = publicClientFor(network);
  const code = await client.getBytecode({address: vault}).catch(() => undefined);
  return !!code && code !== '0x';
}

const GUARD_CONFIG_ABI = parseAbi(['function getAddress(bytes32 key) view returns (address)']);
const VAULT_VERSION_ABI = parseAbi(['function vaultVersion() view returns (uint256)']);
const FACTORY_VAULT_ABI = parseAbi(['function vaultAddress(address owner) view returns (address)']);
const BALANCE_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** WETH pays relay fees from vault v1.0.2, and activation itself from v1.0.3. */
export const WETH_GAS_VERSION = BigInt(1_000_002);
const WETH_ACTIVATION_VERSION = BigInt(1_000_003);

/**
 * What a vault not deployed yet will be born on: the guard's latest vault implementation's version,
 * and the WETH the factory will hand it (the guard's `bitty.gasWrapped`). The factory deploys onto
 * that latest implementation, so this is the vault's real starting point, not a guess. Null when the
 * chain cannot be read.
 */
export async function bornVault(network: Network): Promise<{version: bigint; weth: Address} | null> {
  try {
    const client = publicClientFor(network);
    const guard = VAULT_GUARD;
    const impl = await client.readContract({
      address: guard,
      abi: GUARD_IMPL_ABI,
      functionName: 'latestImplementation',
      args: [IMPLEMENTATION_VAULT],
    });
    const [version, weth] = await Promise.all([
      client.readContract({address: impl, abi: VAULT_VERSION_ABI, functionName: 'vaultVersion'}) as Promise<bigint>,
      client.readContract({
        address: guard,
        abi: GUARD_CONFIG_ABI,
        functionName: 'getAddress',
        args: [keccak256(stringToHex('bitty.gasWrapped'))],
      }),
    ]);
    return /^0x0+$/.test(weth) ? null : {version, weth};
  } catch {
    return null;
  }
}

/**
 * The coin activation is paid in: the caller's stablecoin when the vault holds any of it, otherwise
 * the vault's WETH when it will be born able to take it and holds ETH or WETH to pay with — ETH sent
 * to the address before it exists is wrapped at activation, before the fee is taken. Falls back to
 * the stablecoin, so an unfunded vault still gets the server's "insufficient balance" answer.
 */
async function activationCoin(network: Network, vault: Address, stableCoin: Address): Promise<{coin: Address; weth: boolean}> {
  const client = publicClientFor(network);
  const stable = await client
    .readContract({address: stableCoin, abi: BALANCE_ABI, functionName: 'balanceOf', args: [vault]})
    .catch(() => BigInt(0));
  if (stable > BigInt(0)) return {coin: stableCoin, weth: false};
  const born = await bornVault(network);
  if (!born || born.version < WETH_ACTIVATION_VERSION) return {coin: stableCoin, weth: false};
  const [eth, wrapped] = await Promise.all([
    client.getBalance({address: vault}).catch(() => BigInt(0)),
    client
      .readContract({address: born.weth, abi: BALANCE_ABI, functionName: 'balanceOf', args: [vault]})
      .catch(() => BigInt(0)),
  ]);
  return eth + wrapped > BigInt(0) ? {coin: born.weth, weth: true} : {coin: stableCoin, weth: false};
}

/**
 * How long a v1.0.0 activation signature stays spendable — the same window a relayed write gets, or
 * the signer's own when its signature takes longer to collect (a multi-owner Safe).
 */
const ACTIVATION_DEADLINE_SECONDS = 600;

const DECIMALS_ABI = parseAbi(['function decimals() view returns (uint8)']);

// What the signed path costs over a plain activateVault from the owner: the factory's signature check
// plus the fee transfer. Must match the server's figure (web activateExec), which quotes the same way.
const SIGNED_ACTIVATION_OVERHEAD_GAS = BigInt(80_000);
const ACTIVATE_ESTIMATE_ABI = parseAbi([
  'function activateVault(bool allowlistEnabled, bytes[] calls) returns (address vault)',
]);

export async function activateVault(o: {
  account: Signer;
  network: Network;
  stableCoin: Address;
  allowlistEnabled: boolean;
  /** The owner's first vault operations, run during init ("activate and call"). Empty = plain activation. */
  calls?: readonly Hex[];
}): Promise<{hash: Hex; vault: Address; feeAmount: bigint}> {
  const client = publicClientFor(o.network);
  const factory = VAULT_FACTORY;
  const vault = await client.readContract({
    address: factory,
    abi: FACTORY_VAULT_ABI,
    functionName: 'vaultAddress',
    args: [o.account.address],
  });
  const {coin, weth} = await activationCoin(o.network, vault, o.stableCoin);

  const feedAddress = ETH_USD_FEED[o.network];
  const [gasPrice, ethUsd, decimals] = await Promise.all([
    client.getGasPrice(),
    // Chainlink where the chain has a feed; otherwise the same price service the app quotes with
    // (Robinhood Chain has no feed).
    feedAddress
      ? (client.readContract({address: feedAddress, abi: PRICE_FEED_ABI, functionName: 'latestRoundData'}) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>).then((feed) => Number(feed[1]) / 1e8)
      : fetchPrices(['ETH'], o.network).then((p) => {
          const usd = p.get('ETH');
          if (!usd) throw new Error('ETH price unavailable');
          return usd;
        }),
    client.readContract({
      address: coin,
      abi: DECIMALS_ABI,
      functionName: 'decimals',
    }) as Promise<number>,
  ]);

  // TODO(base): add the OP Stack L1 data fee for exact Base pricing (0 undercharges slightly there).
  const l1FeeWei = BigInt(0);
  const calls = (o.calls ?? []) as Hex[];
  // A batch is priced from a live estimate of the owner's own entry point, as the server prices it.
  // The flat ACTIVATION_GAS covers a bare deploy only: signed under a send that costs more, it fell
  // below the server's floor and was refused `fee-too-low`.
  const gasUnits =
    calls.length > 0
      ? (await client.estimateContractGas({
          abi: ACTIVATE_ESTIMATE_ABI,
          address: factory,
          functionName: 'activateVault',
          args: [o.allowlistEnabled, calls],
          account: o.account.address,
        })) + SIGNED_ACTIVATION_OVERHEAD_GAS
      : null;
  // In WETH the fee is the gas cost itself, in wei, with no margin — as the server quotes it.
  const feeAmount = weth
    ? (gasUnits ?? ACTIVATION_GAS) * gasPrice + l1FeeWei
    : gasUnits !== null
      ? relayFeeUnits(gasUnits, gasPrice, ethUsd, Number(decimals), l1FeeWei)
      : activationFeeUnits(gasPrice, ethUsd, Number(decimals), l1FeeWei);

  const domain = {
    name: 'BittyV1VaultFactory',
    version: '1',
    chainId: CHAIN_ID[o.network],
    verifyingContract: factory,
  } as const;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (o.account.approvalWindowSeconds ?? ACTIVATION_DEADLINE_SECONDS));
  const signature = await o.account.signTypedData({
    domain,
    types: ACTIVATION_TYPES,
    primaryType: 'Activation',
    message: {
      owner: o.account.address,
      stableCoinAddress: coin,
      feeAmount,
      restrictToOwnAllowList: o.allowlistEnabled,
      calls,
      deadline,
    },
  });

  const {hash} = await submitActivation({
    network: o.network,
    factory,
    owner: o.account.address,
    stableCoin: coin,
    feeAmount,
    allowlistEnabled: o.allowlistEnabled,
    calls,
    // The factory refuses the activation after it.
    deadline,
    signature,
  });
  return {hash, vault, feeAmount};
}

/**
 * Activate with the network fee paid by the OWNER: the factory's plain `activateVault`, called from
 * the owner key, deploys the caller's vault and runs `calls` during its init. No signature to check
 * and no fee taken from the vault — the owner's ETH pays the gas, so the vault need hold nothing.
 */
export async function activateVaultDirect(o: {
  account: Signer;
  network: Network;
  allowlistEnabled: boolean;
  calls?: readonly Hex[];
}): Promise<{hash: Hex}> {
  return sendFromOwner({
    account: o.account,
    network: o.network,
    to: VAULT_FACTORY,
    data: encodeFunctionData({
      abi: ACTIVATE_ESTIMATE_ABI,
      functionName: 'activateVault',
      args: [o.allowlistEnabled, (o.calls ?? []) as Hex[]],
    }),
  });
}

/**
 * Hand a signed activation to the relayer. Split from {activateVault} so an activation whose
 * signature was collected later — a multi-owner Safe's (see ./safe-finish) — goes the same way.
 */
export async function submitActivation(o: {
  network: Network;
  factory: Address;
  owner: Address;
  stableCoin: Address;
  feeAmount: bigint;
  allowlistEnabled: boolean;
  calls: readonly Hex[];
  deadline: bigint;
  signature: Hex;
}): Promise<{hash: Hex; vault: Address}> {
  const res = await fetch(apiUrl('/api/ethereum/vaults/activate', o.network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      owner: o.owner,
      stableCoinAddress: o.stableCoin,
      feeAmount: o.feeAmount.toString(),
      signature: o.signature,
      version: API_VERSION,
      factory: o.factory,
      allowlistEnabled: o.allowlistEnabled,
      calls: o.calls,
      deadline: o.deadline.toString(),
    }),
  });

  const json = (await res.json().catch(() => null)) as
    | {ok?: boolean; hash?: Hex; vault?: Address; reason?: string; error?: string}
    | null;

  if (json?.ok && json.hash && json.vault) return {hash: json.hash, vault: json.vault};
  throw new Error(json?.reason ?? json?.error ?? `Activation failed (${res.status})`);
}

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
import {ACTIVATION_GAS, SIGNED_ACTIVATION_OVERHEAD_GAS, relayFeeUnits} from '@/core/activation-fee';
// One copy of the ETH/USD feeds: the fee shown before signing and the fee actually signed must be
// priced from the same source, or the two disagree for no reason the user can see.
import {ETH_USD_FEED} from './fee-quote';
import {fetchPrices} from '@/core/prices';
import {knownAssets} from '@/core/assets';
import {sendFromOwner} from './direct';
import {nameRevert} from './vault-abi';
import {REVERT_REASON} from './capabilities';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';


/** Is the vault deployed (activated)? A counterfactual vault has no code until activation. */
export async function isActivated(vault: Address, network: Network): Promise<boolean> {
  const key = `${network}:${vault.toLowerCase()}`;
  // Deployed is for good: once seen, never asked again.
  if (deployed.has(key)) return true;
  const client = publicClientFor(network);
  /**
   * A read that FAILS is not an empty address.
   *
   * It used to be: `getBytecode(...).catch(() => undefined)` turned a timed-out or rate-limited RPC
   * into "no code", and every write on a long-active vault then set off to ACTIVATE it — which
   * failed, and told the user to fund a vault that had been running for weeks ("your vault needs to
   * be activated first; the network fee is paid from…"), with nothing ever reaching the relayer.
   * So a failed read is retried, and if the chain still cannot be reached the write stops and says
   * that instead.
   */
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const code = await client.getBytecode({address: vault});
      const live = !!code && code !== '0x';
      if (live) deployed.add(key);
      return live;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw new Error(
    `${translate(useLanguage.getState().language, 'mobile.actions.network_unreachable')}\n\n${String((lastErr as Error)?.message ?? lastErr).slice(0, 120)}`,
  );
}
const deployed = new Set<string>();

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
 * The coin activation is paid in: the caller's stablecoin when the vault holds any of it, else
 * whichever other stablecoin it holds the most of, otherwise the vault's WETH when it will be born
 * able to take it and holds ETH or WETH to pay with — ETH sent to the address before it exists is
 * wrapped at activation, before the fee is taken. Falls back to the stablecoin, so an unfunded vault
 * still gets the server's "insufficient balance" answer.
 *
 * Every stablecoin, not just the caller's: screens hand over the catalog's first one (USDC), so a
 * vault funded with USDT alone was billed in a coin it did not hold, and the activation — with the
 * operation riding on it — was refused as though the vault were empty.
 */
async function activationCoin(network: Network, vault: Address, stableCoin: Address): Promise<{coin: Address; weth: boolean}> {
  const client = publicClientFor(network);
  const stables = [
    {address: stableCoin, decimals: knownAssets(network).find((a) => a.address.toLowerCase() === stableCoin.toLowerCase())?.decimals ?? 6},
    ...knownAssets(network)
      .filter((a) => a.kind === 'stable' && a.address.toLowerCase() !== stableCoin.toLowerCase())
      .map((a) => ({address: a.address as Address, decimals: a.decimals})),
  ];
  const held = await Promise.all(
    stables.map((c) =>
      client
        .readContract({address: c.address, abi: BALANCE_ABI, functionName: 'balanceOf', args: [vault]})
        .then((raw) => Number(raw) / 10 ** c.decimals, () => 0),
    ),
  );
  if (held[0] > 0) return {coin: stableCoin, weth: false};
  const most = held.reduce((best, v, i) => (v > held[best] ? i : best), 0);
  if (held[most] > 0) return {coin: stables[most].address, weth: false};
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

/**
 * The gas the chain BILLS for a call (after refunds), from eth_simulateV1 — what the server prices
 * by (web lib/billed-gas). Null where the node cannot simulate; the caller then estimates.
 */
async function billedGas(
  client: {request: (args: never) => Promise<unknown>},
  from: `0x${string}`,
  to: `0x${string}`,
  data: `0x${string}`,
): Promise<bigint | null> {
  try {
    const res = (await client.request({
      method: 'eth_simulateV1',
      params: [{blockStateCalls: [{calls: [{from, to, data, gas: '0x4c4b40'}]}], validation: false, traceTransfers: false}, 'latest'],
    } as never)) as {calls?: {status?: string; gasUsed?: string}[]}[];
    const call = res?.[0]?.calls?.[0];
    if (!call?.gasUsed || call.status !== '0x1') return null;
    const used = BigInt(call.gasUsed);
    return used > BigInt(0) ? used : null;
  } catch {
    return null;
  }
}

const ACTIVATE_ESTIMATE_ABI = parseAbi([
  'function activateVault(bool allowlistEnabled, bytes[] calls) returns (address vault)',
]);

/**
 * The operation riding on activation reverts on its own — the estimate, before anything is signed.
 *
 * Not a fee problem, so not told as one: it used to come back as "your vault needs to be activated
 * first; send some USDC or ETH", over a vault that already held the coin. And it was unreadable on
 * top: the estimate decoded the revert against an ABI with no errors in it, so the user saw viem's
 * "unable to decode signature 0x…" instead of what the vault objected to. The revert is named here
 * from every vault ABI the device has (see {nameRevert}), in the words the screens use for it.
 */
export class ActivationCallReverted extends Error {}

/** The revert data in a viem error: the first `data` down its cause chain, or a selector in its text. */
export function revertData(e: unknown): string | undefined {
  for (let x = e as {data?: unknown; cause?: unknown} | undefined, i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    const d = typeof x.data === 'string' ? x.data : typeof (x.data as {data?: unknown})?.data === 'string' ? (x.data as {data: string}).data : undefined;
    if (d && /^0x[0-9a-fA-F]{8}/.test(d)) return d;
  }
  return String((e as Error)?.message ?? e).match(/(?:signature|data)\W+(0x[0-9a-fA-F]{8})/)?.[1];
}

function activationReverted(e: unknown): ActivationCallReverted {
  const t = (key: string) => translate(useLanguage.getState().language, key);
  const data = revertData(e);
  const name = data ? nameRevert(data.slice(0, 10)) : undefined;
  const sentence = name && REVERT_REASON[name] ? t(`vault.gate.${REVERT_REASON[name]}`) : t('mobile.actions.relay_refused');
  const detail = name ?? String((e as {shortMessage?: string})?.shortMessage ?? (e as Error)?.message ?? e).slice(0, 160);
  return new ActivationCallReverted(`${sentence}\n\n${detail}`);
}

/**
 * The most a vault pays for one operation, activation included: the contract's SYSTEM_MAX_FEE_PER_OP,
 * checked again on chain in `payActivationFee` (FeeExceedsPerOpCap), and by the server before that.
 */
export const ACTIVATION_FEE_CAP_USD = 10;

/**
 * Activation would cost the vault more than {ACTIVATION_FEE_CAP_USD}: gas is high, and nothing about
 * the vault can change that. It used to reach the user as "your vault needs to be activated first;
 * send some USDC or ETH", over a vault holding twelve thousand dollars. The message says what it is —
 * the fee now, and the cap — and the relay offers the owner's ETH, which no cap applies to.
 */
export class ActivationFeeTooHigh extends Error {
  constructor(readonly feeUsd: number) {
    super(
      translate(useLanguage.getState().language, 'mobile.fees.gas_high_activation', {
        fee: `$${feeUsd.toFixed(2)}`,
        cap: `$${ACTIVATION_FEE_CAP_USD}`,
      }),
    );
  }
}

/**
 * The relayer cannot cover the gas for this send just now. Ours to fix, not the user's: nothing was
 * sent and nothing charged, and it used to read as "your vault needs to be activated first".
 */
/**
 * A request whose answer never arrived ("Network request failed"): it may have been sent, so it is
 * reported as unknown, in the user's language, and never dressed up as some other failure.
 */
export class ConnectionLost extends Error {
  constructor() {
    super(translate(useLanguage.getState().language, 'mobile.actions.relay_connection_lost'));
    this.name = 'ConnectionLost';
  }
}

export class RelayerUnfunded extends Error {
  constructor() {
    super(translate(useLanguage.getState().language, 'mobile.fees.relayer_unfunded'));
  }
}

/**
 * From this release the vault writes its own starting risk at creation: regular sends off ($0) and
 * a market-trade loss allowance of {NEW_VAULT_LOSS_ALLOWANCE}, below the $10,000 ceiling. Every
 * network's guard now creates vaults on it, so activation adds nothing of its own.
 */
export const NEW_VAULT_DEFAULTS_VERSION = BigInt(1_000_009);
export const NEW_VAULT_LOSS_ALLOWANCE = BigInt(1_000);

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
  // Priced from this exact activation, calls or none, as the server prices it: the owner's own entry
  // point by the gas the chain BILLS (eth_simulateV1), or its estimate where the node cannot simulate,
  // plus the signed path's overhead. A bare activation used to be a flat figure over twice its gas.
  const activateData = encodeFunctionData({
    abi: ACTIVATE_ESTIMATE_ABI,
    functionName: 'activateVault',
    args: [o.allowlistEnabled, calls],
  });
  const gasUnits =
    ((await billedGas(client, o.account.address, factory, activateData)) ??
      (await client.estimateGas({account: o.account.address, to: factory, data: activateData}).catch((e) => {
        if (calls.length > 0) throw activationReverted(e);
        return ACTIVATION_GAS - SIGNED_ACTIVATION_OVERHEAD_GAS;
      }))) + SIGNED_ACTIVATION_OVERHEAD_GAS;
  // In WETH the fee is the gas cost itself, in wei, with no margin — as the server quotes it.
  const feeAmount = weth
    ? gasUnits * gasPrice + l1FeeWei
    : relayFeeUnits(gasUnits, gasPrice, ethUsd, Number(decimals), l1FeeWei);

  // Over the vault's per-operation cap the activation cannot be paid, however the vault is funded:
  // said now, in dollars, before anything is signed — not as the relayer's refusal afterwards.
  const feeUsd = weth ? (Number(feeAmount) / 1e18) * ethUsd : Number(feeAmount) / 10 ** Number(decimals);
  if (feeUsd > ACTIVATION_FEE_CAP_USD) throw new ActivationFeeTooHigh(feeUsd);

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
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/ethereum/vaults/activate', o.network), {
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
  } catch {
    // The connection dropped mid-request: the activation may or may not have been sent.
    throw new ConnectionLost();
  }

  const json = (await res.json().catch(() => null)) as
    | {ok?: boolean; hash?: Hex; vault?: Address; reason?: string; error?: string}
    | null;

  if (json?.ok && json.hash && json.vault) return {hash: json.hash, vault: json.vault};
  if (json?.reason === 'relayer-unfunded') throw new RelayerUnfunded();
  throw new Error(json?.reason ?? json?.error ?? `Activation failed (${res.status})`);
}

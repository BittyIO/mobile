/**
 * Gasless vault activation — the ONLY bootstrap path for a no-ETH owner. The owner
 * signs an Activation (against the FACTORY's EIP-712 domain); the relayer deploys + activates the
 * vault and takes the fee from the deposited stable coin. A fresh activated vault already relays, so
 * no separate setGasless is needed — activation IS "turning gasless on".
 *
 * Ported from web `activateByStablecoin`. The fee is priced from live gas + ETH/USD and SIGNED, so the
 * server accepts it within a band (see core/activation-fee).
 */
import {parseAbi, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {
  apiUrl,
  CHAIN_ID,
  DEFAULT_VAULT_VERSION,
  FACTORY_ADDRESS,
  publicClientFor,
  type Network,
} from '@/core/chain';
import {ACTIVATION_TYPES, PRICE_FEED_ABI} from '@/core/abi';
import {activationFeeUnits} from '@/core/activation-fee';
// One copy of the ETH/USD feeds: the fee shown before signing and the fee actually signed must be
// priced from the same source, or the two disagree for no reason the user can see.
import {ETH_USD_FEED} from './fee-quote';
import {fetchPrices} from '@/core/prices';


/** Is the vault deployed (activated)? A counterfactual vault has no code until activation. */
export async function isActivated(vault: Address, network: Network): Promise<boolean> {
  const client = publicClientFor(network);
  const code = await client.getBytecode({address: vault}).catch(() => undefined);
  return !!code && code !== '0x';
}

const DECIMALS_ABI = parseAbi(['function decimals() view returns (uint8)']);

export async function activateVault(o: {
  account: Signer;
  network: Network;
  stableCoin: Address;
  allowlistEnabled: boolean;
  /** The owner's first vault operations, run during init ("activate and call"). Empty = plain activation. */
  calls?: readonly Hex[];
}): Promise<{hash: Hex; vault: Address; feeAmount: bigint}> {
  const client = publicClientFor(o.network);
  const factory = FACTORY_ADDRESS[o.network];

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
      address: o.stableCoin,
      abi: DECIMALS_ABI,
      functionName: 'decimals',
    }) as Promise<number>,
  ]);

  // TODO(base): add the OP Stack L1 data fee for exact Base pricing (0 undercharges slightly there).
  const l1FeeWei = BigInt(0);
  const feeAmount = activationFeeUnits(gasPrice, ethUsd, Number(decimals), l1FeeWei);

  const calls = (o.calls ?? []) as Hex[];

  const signature = await o.account.signTypedData({
    domain: {
      name: 'BittyV1VaultFactory',
      version: '1',
      chainId: CHAIN_ID[o.network],
      verifyingContract: factory,
    },
    types: ACTIVATION_TYPES,
    primaryType: 'Activation',
    message: {
      owner: o.account.address,
      stableCoinAddress: o.stableCoin,
      feeAmount,
      allowlistEnabled: o.allowlistEnabled,
      calls,
    },
  });

  const res = await fetch(apiUrl('/api/ethereum/vaults/activate', o.network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      owner: o.account.address,
      stableCoinAddress: o.stableCoin,
      feeAmount: feeAmount.toString(),
      signature,
      version: DEFAULT_VAULT_VERSION,
      factory,
      allowlistEnabled: o.allowlistEnabled,
      calls,
    }),
  });

  const json = (await res.json().catch(() => null)) as
    | {ok?: boolean; hash?: Hex; vault?: Address; reason?: string; error?: string}
    | null;

  if (json?.ok && json.hash && json.vault) {
    return {hash: json.hash, vault: json.vault, feeAmount};
  }
  throw new Error(json?.reason ?? json?.error ?? `Activation failed (${res.status})`);
}

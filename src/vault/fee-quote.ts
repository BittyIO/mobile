/**
 * What a relayed operation will cost the vault, quoted before the user signs.
 *
 * Every write in this app is relayed: the user signs, a relayer pays the chain, and the vault
 * reimburses it in a stable coin. That charge was invisible until it appeared in the history, so
 * this prices it up front from live gas and shows it beside the confirm button.
 *
 * It is an ESTIMATE and says so on screen. The server prices the real thing from a simulation of
 * the exact call (see relayExec), which this cannot do without the signature it is trying to
 * inform. What it can do is use the same inputs — current gas price, current ETH price, a margin —
 * against a measured gas figure, which lands in the right place for a number whose job is to stop
 * a fee being a surprise.
 */
import type {Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {PRICE_FEED_ABI} from '@/core/abi';
import {fetchPrices} from '@/core/prices';

/**
 * Gas a relayed operation burns, broken into the parts an operation is actually built from.
 *
 * Fitted to measured transactions rather than guessed, and to gas USED after the EVM's storage
 * refunds, because that is what the relayer pays and therefore what the vault is billed:
 *
 *   mainnet swap funded by two withdrawals   418,808   overhead + swap + 2 x withdraw = 470,000
 *   Base Aave supply, repeat                 393,318   overhead + supply             = 390,000
 *   Base Aave supply, first of that asset    632,813   overhead + supply + setup     = 620,000
 *
 * The model runs a little high on the swap, which is the right direction for a number a user reads
 * before agreeing to pay it.
 */
export const RELAY_GAS = {
  /** Forwarder, signature check, vault dispatch, and the fee transfer that ends every relay. */
  overhead: BigInt(120_000),
  /** One market swap through the AMM adapter. */
  swap: BigInt(170_000),
  /** One position unwound in the same transaction — a Sky redemption or an Aave withdrawal. */
  withdraw: BigInt(90_000),
  /** One deposit into a yield or lending route. */
  supply: BigInt(270_000),
  /** First use of an asset or adapter: allowlisting it, and registering or cloning the adapter. */
  setup: BigInt(230_000),
  /** A plain ERC-20 send. */
  transfer: BigInt(55_000),
};

/** Gas for an operation made of these parts, overhead included once. */
export function relayGasFor(parts: {
  swap?: number;
  withdraw?: number;
  supply?: number;
  transfer?: number;
  setup?: boolean;
}): bigint {
  let g = RELAY_GAS.overhead;
  g += RELAY_GAS.swap * BigInt(parts.swap ?? 0);
  g += RELAY_GAS.withdraw * BigInt(parts.withdraw ?? 0);
  g += RELAY_GAS.supply * BigInt(parts.supply ?? 0);
  g += RELAY_GAS.transfer * BigInt(parts.transfer ?? 0);
  if (parts.setup) g += RELAY_GAS.setup;
  return g;
}

/** A single relayed write, for a caller that has nothing more specific to say. */
export const TYPICAL_RELAY_GAS = relayGasFor({transfer: 1});

/**
 * The relayer's own margin over the gas it prices, kept in step with GAS_MARGIN_BPS in relayExec.
 * The user is charged the padded figure, so the padded figure is what to show them.
 */
const RELAY_MARGIN_BPS = 1500;
const BPS = 10000;

// Chainlink ETH/USD feeds, answer at 8 decimals. Shared with the activation quote, which prices the
// same way; Robinhood Chain has no feed and falls back to the app's own price service.
export const ETH_USD_FEED: Partial<Record<Network, Address>> = {
  mainnet: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  base: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  sepolia: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
  arbitrum: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
};

export async function ethUsd(network: Network): Promise<number> {
  const feed = ETH_USD_FEED[network];
  if (feed) {
    const r = (await publicClientFor(network).readContract({
      address: feed,
      abi: PRICE_FEED_ABI,
      functionName: 'latestRoundData',
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    return Number(r[1]) / 1e8;
  }
  const p = await fetchPrices(['ETH'], network);
  const usd = p.get('ETH');
  if (!usd) throw new Error('ETH price unavailable');
  return usd;
}

/**
 * Estimated relay fee in US dollars, or null when gas or the price cannot be read.
 *
 * Deliberately NOT rounded up to whole cents the way the signed activation fee is. Rounding made
 * every operation on an L2 read "$0.01" whatever it did, which hid exactly the difference this
 * line exists to show: on Base a swap and a swap-plus-two-withdrawals are both under a cent, but
 * one is twice the other.
 */
export async function quoteRelayFeeUsd(network: Network, gasUnits = TYPICAL_RELAY_GAS): Promise<number | null> {
  try {
    const [gasPrice, usd] = await Promise.all([publicClientFor(network).getGasPrice(), ethUsd(network)]);
    const wei = (gasUnits * gasPrice * BigInt(BPS + RELAY_MARGIN_BPS)) / BigInt(BPS);
    return (Number(wei) / 1e18) * usd;
  } catch {
    return null;
  }
}

/**
 * The forwarder's share of {@link RELAY_GAS.overhead} — signature check, ERC-2771 suffix and the fee
 * transfer that ends a relay. A transaction the owner sends itself skips all three and pays the
 * flat 21,000 every transaction does instead.
 */
const RELAY_ONLY_GAS = RELAY_GAS.overhead - BigInt(21_000);

/**
 * Estimated network fee in wei when the OWNER pays (see vault/direct), or null when gas cannot be
 * read. Same measured figures as the relay quote, less what only a relay spends, and no relayer
 * margin — the owner pays the chain, not a relayer.
 */
export async function quoteOwnerFeeWei(network: Network, gasUnits = TYPICAL_RELAY_GAS): Promise<bigint | null> {
  try {
    const gasPrice = await publicClientFor(network).getGasPrice();
    const gas = gasUnits > RELAY_ONLY_GAS + BigInt(21_000) ? gasUnits - RELAY_ONLY_GAS : BigInt(21_000);
    return gas * gasPrice;
  } catch {
    return null;
  }
}

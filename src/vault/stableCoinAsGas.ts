/**
 * StableCoinAsGas config — which stable coins the vault may be charged in for relayed ops. Ported from web
 * getStableCoinAsGasConfig / setStableCoinAsGas / toggleGasCoin. An EMPTY allowlist means "any guard-registered coin"
 * (the un-narrowed default); naming coins restricts to those; naming none turns relaying off.
 *
 * Changing the config is itself a relayed (gasless) write — a fresh activated vault already relays.
 */
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_STABLE_COIN_AS_GAS_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';
import type {Address, Hex} from 'viem';
import {gasReserveCoin, gasReserveSize, RESERVE_NONE} from '@/core/prefs';
import {stableCoinAsGasFunctionNames} from './manage';

/**
 * `dailyLimit` and `maxFeePerOp` are whole dollars (the contract's uint64: 100 = $100/day, 10 = $10 per
 * operation; the vault reports the system default when the owner has not set a value). `remaining` and
 * `usedToday` are 18-decimal dollar amounts for the current UTC day.
 */
export type StableCoinAsGasConfig = {
  stableCoins: string[]; // allowlist; empty = any coin allowed
  dailyLimit: bigint;
  maxFeePerOp: bigint;
  remaining: bigint;
  usedToday: bigint;
  configured: boolean; // relaying actually on (dailyLimit > 0)
};

/** The contract's ceilings for the two caps (Constants.sol SYSTEM_DAILY_MAX_GAS_BUDGET / SYSTEM_MAX_FEE_PER_OP). */
export const STABLE_COIN_AS_GAS_MAX_DAILY = 100;
export const STABLE_COIN_AS_GAS_MAX_PER_OP = 10;

/**
 * What a relay actually costs, measured rather than guessed: an L2 relay runs to cents and a
 * mainnet one about 0.84 USDC. Kept as a note, not as a constant — what an operation LEAVES
 * BEHIND is the owner's setting now, which is a different question and a larger number. See
 * {reserveAgainst} and {gasReserve}.
 */

export async function getStableCoinAsGasConfig(
  vault: Address,
  network: Network,
): Promise<StableCoinAsGasConfig | null> {
  try {
    const client = publicClientFor(network);
    const names = stableCoinAsGasFunctionNames();
    let cfg: readonly [readonly Address[], bigint, bigint];
    let remaining: bigint;
    try {
      [cfg, remaining] = await client.multicall({
        contracts: [
          {address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: names.config},
          {address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: 'gasBudgetRemaining'},
        ] as const,
        allowFailure: false,
      });
    } catch {
      [cfg, remaining] = await Promise.all([
        client.readContract({address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: names.config}),
        client.readContract({address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: 'gasBudgetRemaining'}),
      ]);
    }
    const [stableCoins, dailyLimit, maxFeePerOp] = cfg;
    const limit18 = dailyLimit * BigInt(10) ** BigInt(18);
    return {
      stableCoins: [...stableCoins],
      dailyLimit,
      maxFeePerOp,
      remaining,
      usedToday: remaining >= limit18 ? BigInt(0) : limit18 - remaining,
      configured: dailyLimit > BigInt(0),
    };
  } catch {
    return null; // not activated / never configured
  }
}

/** Set the stable-coin allowlist (empty = any coin). Keeps the existing daily/per-op limits. */
export async function setStableCoinAsGasCoins(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  coins: Address[];
  dailyLimit: bigint;
  maxFeePerOp: bigint;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_STABLE_COIN_AS_GAS_ABI,
    functionName: stableCoinAsGasFunctionNames().set,
    args: [o.coins, o.dailyLimit, o.maxFeePerOp],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Turn relaying off entirely. */
export async function disableStableCoinAsGas(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_STABLE_COIN_AS_GAS_ABI,
    functionName: stableCoinAsGasFunctionNames().disable,
    args: [],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Set the daily budget and the per-operation cap (whole dollars), keeping the coin allowlist as is. */
export async function setStableCoinAsGasLimits(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  coins: Address[];
  dailyLimit: number;
  maxFeePerOp: number;
  stableCoin: Address;
}): Promise<Hex> {
  return setStableCoinAsGasCoins({...o, dailyLimit: BigInt(o.dailyLimit), maxFeePerOp: BigInt(o.maxFeePerOp)});
}

/** Tried in this order when the owner has not chosen: the relayer's own first choice, then the rest. */
const PREFERRED = ['USDT', 'USDC', 'USDG'];

/**
 * Which stablecoin holds the fee float, and how much of it this operation must leave behind.
 *
 * The relayer bills its fee to a vault stablecoin AFTER the call runs, so an operation that spends
 * the last of the coin it will be billed in reverts at the charge with nothing wrong with the
 * operation itself — `fee-leg-failed`, and a long afternoon working out why.
 *
 * The coin is the owner's choice (see {gasReserveCoin}) because the app's own guess was not
 * answerable: it used to hold back whichever stablecoin happened to be funded last, which moved as
 * balances moved and could never be named on screen.
 *
 * Unset, it picks for them: the first coin in {PREFERRED} holding at least the reserve, then any
 * coin that does, then nothing. Only a coin the vault actually HOLDS enough of can hold the float,
 * so the guess cannot land on a reserve that does not exist.
 *
 * Returns the coin either way, so a caller can SAY which one it is rather than only subtract it.
 */
export function resolveFeeReserve(opts: {
  network: string;
  vault: string | null | undefined;
  /** Every stablecoin the vault could hold, with what it holds of each. */
  heldStables: {symbol: string; amount: number}[];
  /** The coin this operation is spending, when there is one. */
  spendSymbol?: string;
}): {coin: string | null; size: number; keep: number} {
  const size = gasReserveSize(opts.network, opts.vault);
  const chosen = gasReserveCoin(opts.network, opts.vault);
  const auto =
    PREFERRED.map(
      (p) => opts.heldStables.find((h) => h.symbol.toUpperCase() === p && h.amount >= size)?.symbol,
    ).find(Boolean) ?? opts.heldStables.find((h) => h.amount >= size)?.symbol;
  const coin = chosen === RESERVE_NONE ? null : (chosen ?? auto ?? null);
  if (!coin || !(size > 0)) return {coin, size, keep: 0};
  const keep = opts.spendSymbol && opts.spendSymbol.toUpperCase() === coin.toUpperCase() ? size : 0;
  return {coin, size, keep};
}

/**
 * What the reserve actually holds back of a balance — never more than the balance itself.
 *
 * {resolveFeeReserve} reports the SIZE the owner asked for, which is the right figure for the
 * arithmetic: a balance below it leaves nothing to spend either way, and `max(0, balance - size)`
 * says so. It is the wrong figure to PRINT. A vault holding 4 USDC against a 10 USDC float had a
 * row reading "10 USDC reserved", which is a claim about 6 USDC that does not exist, under an
 * Available of nothing — so the two numbers on screen did not add up to the balance above them.
 */
export const reserveHeld = (keep: number, balance: number): number =>
  Math.max(0, Math.min(keep, balance));

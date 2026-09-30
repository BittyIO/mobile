/**
 * Gasless config — which stable coins the vault may be charged in for relayed ops. Ported from web
 * getGaslessConfig / setGasless / toggleGasCoin. An EMPTY allowlist means "any guard-registered coin"
 * (the un-narrowed default); naming coins restricts to those; naming none turns relaying off.
 *
 * Changing the config is itself a relayed (gasless) write — a fresh activated vault already relays.
 */
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_GASLESS_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';
import type {Address, Hex} from 'viem';

/**
 * `dailyLimit` and `maxFeePerOp` are whole dollars (the contract's uint64: 100 = $100/day, 10 = $10 per
 * operation; the vault reports the system default when the owner has not set a value). `remaining` and
 * `usedToday` are 18-decimal dollar amounts for the current UTC day.
 */
export type GaslessConfig = {
  stableCoins: string[]; // allowlist; empty = any coin allowed
  dailyLimit: bigint;
  maxFeePerOp: bigint;
  remaining: bigint;
  usedToday: bigint;
  configured: boolean; // relaying actually on (dailyLimit > 0)
};

/** The contract's ceilings for the two caps (Constants.sol SYSTEM_DAILY_MAX_GAS_BUDGET / SYSTEM_MAX_FEE_PER_OP). */
export const GASLESS_MAX_DAILY = 100;
export const GASLESS_MAX_PER_OP = 10;

/**
 * Free stablecoin an operation must LEAVE BEHIND, in whole tokens, so the relayer can be paid.
 *
 * The fee is charged after the operation runs, not before: executeWithFee performs the call and
 * then transfers the fee out of the vault. So an order that spends every last unit of the coin it
 * will be billed in passes every check, runs, and then reverts at the charge. The relayer answers
 * `fee-leg-failed`, which reads as a mystery because the trade itself was fine.
 *
 * Measured against real fees rather than guessed: an L2 relay costs cents, and a mainnet one ran
 * about 0.84 USDC after the pricing fix. Each figure here is a wide multiple of that and still far
 * under the vault's own $10 per-operation ceiling, so it never becomes the binding constraint.
 */
export const FEE_RESERVE: Record<Network, number> = {
  mainnet: 3,
  base: 0.5,
  sepolia: 0.5,
  robinhood: 0.5,
};

export async function getGaslessConfig(
  vault: Address,
  network: Network,
): Promise<GaslessConfig | null> {
  try {
    const client = publicClientFor(network);
    const [cfg, remaining] = (await Promise.all([
      client.readContract({address: vault, abi: VAULT_GASLESS_ABI, functionName: 'gaslessConfig'}),
      client.readContract({address: vault, abi: VAULT_GASLESS_ABI, functionName: 'gasBudgetRemaining'}),
    ])) as [readonly [readonly Address[], bigint, bigint], bigint];
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
export async function setGaslessCoins(o: {
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
    abi: VAULT_GASLESS_ABI,
    functionName: 'setGasless',
    args: [o.coins, o.dailyLimit, o.maxFeePerOp],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Turn relaying off entirely. */
export async function disableGasless(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_GASLESS_ABI,
    functionName: 'disableGasless',
    args: [],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Set the daily budget and the per-operation cap (whole dollars), keeping the coin allowlist as is. */
export async function setGaslessLimits(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  coins: Address[];
  dailyLimit: number;
  maxFeePerOp: number;
  stableCoin: Address;
}): Promise<Hex> {
  return setGaslessCoins({...o, dailyLimit: BigInt(o.dailyLimit), maxFeePerOp: BigInt(o.maxFeePerOp)});
}

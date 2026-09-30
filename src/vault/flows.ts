/**
 * Lifetime earned overlay. The server ledgers every stake/unstake (stake-flows) and supply/withdraw
 * (supply-flows); earned = current position + total unstaked − total staked. Hidden when ≤ 0 (a fresh
 * or net-withdrawn position hasn't earned yet). Ported from web use-stake-flows / use-supply-flows.
 */
import {apiUrl, type Network} from '@/core/chain';
import type {Position} from './positions';

type Totals = {staked: bigint; unstaked: bigint};
/**
 * Keyed by `${protocol}:${asset}` (lowercased), matching the server's byProtocol keys.
 *
 * `staked` / `unstaked` are the generic in / out totals: for a lending position they hold what the
 * supply ledger calls supplied and withdrawn.
 */
export type FlowMap = Map<string, Totals>;
export type Flows = {stake: FlowMap; supply: FlowMap};

/** Tolerant BigInt: a missing or malformed total counts as zero rather than losing the whole map. */
const big = (v: unknown): bigint => {
  try {
    return typeof v === 'string' || typeof v === 'number' ? BigInt(v) : BigInt(0);
  } catch {
    return BigInt(0);
  }
};

/**
 * One flow ledger.
 *
 * The two endpoints name their totals differently — stake-flows answers `staked`/`unstaked`, and
 * supply-flows answers `supplied`/`withdrawn` — so both spellings are read here. Taking only the
 * staking pair meant every supply row parsed as BigInt(undefined), which threw, and the catch below
 * turned that into an empty map. Flexible Lend therefore never showed what it had earned, silently
 * and on every vault.
 */
async function fetchOne(path: string, vault: string, network: Network): Promise<FlowMap> {
  const m: FlowMap = new Map();
  try {
    const res = await fetch(apiUrl(`${path}?vault=${vault}`, network));
    if (!res.ok) return m;
    const j = (await res.json()) as {
      data?: {
        byProtocol?: Record<
          string,
          {staked?: string; unstaked?: string; supplied?: string; withdrawn?: string}
        >;
      };
    };
    for (const [k, v] of Object.entries(j?.data?.byProtocol ?? {})) {
      m.set(k.toLowerCase(), {staked: big(v.staked ?? v.supplied), unstaked: big(v.unstaked ?? v.withdrawn)});
    }
  } catch {
    /* empty on failure — earned just won't show */
  }
  return m;
}

export async function fetchFlows(vault: string, network: Network): Promise<Flows> {
  const [stake, supply] = await Promise.all([
    fetchOne('/api/ethereum/vaults/stake-flows', vault, network),
    fetchOne('/api/ethereum/vaults/supply-flows', vault, network),
  ]);
  return {stake, supply};
}

/**
 * Earned above this share of the recorded principal is not yield, it is a hole in the ledger.
 *
 * The ledger is written by whichever client sent the deposit, so anything that never reported one
 * leaves the principal understated and the difference then reads as profit. A measured case: a Base
 * vault supplied 40 USDC to Aave with only 10 of it recorded, which would have shown "+30.00
 * earned" on a position that had actually made a seventh of a cent. These routes pay single-digit
 * percent, so a fifth of principal is years of yield and is far likelier to be a missing deposit.
 * Failing closed costs a real earner nothing but a hidden line; failing open prints a fiction.
 */
const MAX_PLAUSIBLE_EARNED_BPS = BigInt(2000); // 20% of principal
const BPS = BigInt(10000);

/** Earned for a position in its asset's raw units, or null when there's nothing (positive) to show. */
export function earnedRaw(pos: Position, flows: Flows): bigint | null {
  const map = pos.kind === 'staked' ? flows.stake : flows.supply;
  const t = map.get(`${pos.protocol.toLowerCase()}:${pos.asset.toLowerCase()}`);
  if (!t) return null;
  const earned = pos.raw + t.unstaked - t.staked;
  if (earned <= BigInt(0)) return null;
  const principal = t.staked - t.unstaked;
  if (principal <= BigInt(0)) return null; // nothing recorded going in: no basis to call this yield
  if (earned * BPS > principal * MAX_PLAUSIBLE_EARNED_BPS) return null;
  return earned;
}

/**
 * Tell the server about a deposit or withdrawal, so `earned` has a principal to measure against.
 *
 * The vault contract emits no Supply/Stake events, so these ledgers are written by the client that
 * sent the transaction and by nothing else. The app read them from the start but never wrote to
 * them, so every deposit made from the phone was invisible and the principal drifted further below
 * the position with each one. Best-effort on purpose: a failed write must not fail the deposit, and
 * the POST is idempotent per (tx, direction, asset), so a retry cannot double-count.
 */
export async function recordFlow(o: {
  vault: string;
  network: Network;
  protocol: string;
  asset: string;
  kind: 'stake' | 'supply';
  direction: 'in' | 'out';
  /** Raw units, as sent on chain. */
  amount: bigint;
  txHash: string;
}): Promise<void> {
  if (o.amount <= BigInt(0)) return;
  const path = o.kind === 'stake' ? '/api/ethereum/vaults/stake-flows' : '/api/ethereum/vaults/supply-flows';
  // Each endpoint names its own directions; sending the other's is rejected as an invalid payload.
  const direction =
    o.kind === 'stake' ? (o.direction === 'in' ? 'stake' : 'unstake') : o.direction === 'in' ? 'supply' : 'withdraw';
  try {
    // The network tag matters on the WRITE as much as the read: without it the row lands under the
    // server's default chain and the position's own chain never sees it.
    await fetch(apiUrl(path, o.network), {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        vault: o.vault,
        protocol: o.protocol,
        asset: o.asset,
        direction,
        amount: o.amount.toString(),
        txHash: o.txHash,
      }),
    });
  } catch {
    /* best-effort ledger write */
  }
}

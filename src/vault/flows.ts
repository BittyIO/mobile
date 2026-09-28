/**
 * Lifetime earned overlay. The server ledgers every stake/unstake (stake-flows) and supply/withdraw
 * (supply-flows); earned = current position + total unstaked − total staked. Hidden when ≤ 0 (a fresh
 * or net-withdrawn position hasn't earned yet). Ported from web use-stake-flows / use-supply-flows.
 */
import {apiUrl, type Network} from '@/core/chain';
import type {Position} from './positions';

type Totals = {staked: bigint; unstaked: bigint};
/** Keyed by `${protocol}:${asset}` (lowercased), matching the server's byProtocol keys. */
export type FlowMap = Map<string, Totals>;
export type Flows = {stake: FlowMap; supply: FlowMap};

async function fetchOne(path: string, vault: string, network: Network): Promise<FlowMap> {
  const m: FlowMap = new Map();
  try {
    const res = await fetch(apiUrl(`${path}?vault=${vault}`, network));
    if (!res.ok) return m;
    const j = (await res.json()) as {
      data?: {byProtocol?: Record<string, {staked: string; unstaked: string}>};
    };
    for (const [k, v] of Object.entries(j?.data?.byProtocol ?? {})) {
      m.set(k.toLowerCase(), {staked: BigInt(v.staked), unstaked: BigInt(v.unstaked)});
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

/** Earned for a position in its asset's raw units, or null when there's nothing (positive) to show. */
export function earnedRaw(pos: Position, flows: Flows): bigint | null {
  const map = pos.kind === 'staked' ? flows.stake : flows.supply;
  const t = map.get(`${pos.protocol.toLowerCase()}:${pos.asset.toLowerCase()}`);
  if (!t) return null;
  const earned = pos.raw + t.unstaked - t.staked;
  return earned > BigInt(0) ? earned : null;
}

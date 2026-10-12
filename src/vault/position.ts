/**
 * One asset's position and P&L, computed on the SERVER from the vault's swap history — see
 * `/api/ethereum/vaults/position/[vault]`. The accounting (average cost, realized/unrealized,
 * today's 24h move) lives there so every client reads the same figures; this is just the fetch.
 */
import {apiFetch, apiUrl, type Network} from '@/core/chain';

export type Position = {
  symbol: string;
  /** Live on-chain balance of the asset, in human units. */
  amount: number;
  /** Current USD spot, or null when unpriceable. */
  price: number | null;
  marketValue: number | null;
  /** Trade-derived average cost per unit, null when nothing was ever bought. */
  avgPrice: number | null;
  costBasis: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number;
  /** Total-return percentage: (unrealized + realized) / cost basis. */
  pnlPct: number | null;
  /** 24h value move on the held amount. */
  todayPnl: number | null;
  change24h: number | null;
};

/** The position for `symbol` in `vault`, or null if the server could not price it. Best-effort. */
export async function fetchPosition(
  vault: string,
  network: Network,
  symbol: string,
): Promise<Position | null> {
  try {
    const url = `${apiUrl(`/api/ethereum/vaults/position/${vault}`, network)}&symbol=${encodeURIComponent(symbol)}`;
    const res = await apiFetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<Position> & {error?: string};
    if (j.error || typeof j.amount !== 'number') return null;
    return j as Position;
  } catch {
    return null;
  }
}

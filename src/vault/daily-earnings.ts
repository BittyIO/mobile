import {useCallback, useEffect, useState} from 'react';
import {apiFetch, apiUrl, type Network} from '@/core/chain';

/**
 * What one Earn position made each day, from the server (GET /api/ethereum/vaults/earnings).
 *
 * Days are UTC for everyone — the server's calendar, not the phone's — so the same day shows the
 * same figure on every device and on the web, and a trip across time zones never splits or doubles
 * one. The server reads the position's balance at each day's last block and takes out what was
 * deposited or withdrawn that day; see web dailyEarnings.ts.
 */
export type DailyEarning = {
  /** YYYY-MM-DD, UTC. */
  day: string;
  /** Raw units of the asset. Null for a day the server cannot tell from a missing deposit record. */
  earned: bigint | null;
  /** The position at the day's close — for today, now. */
  balance: bigint;
};

export type DailyEarnings = {today: string; days: DailyEarning[]};

export async function fetchDailyEarnings(
  vault: string,
  network: Network,
  protocol: string,
  asset: string,
): Promise<DailyEarnings> {
  const base = apiUrl(`/api/ethereum/vaults/earnings/${vault}`, network);
  // The first visit to a long-held position reads a year of past balances on the server: give it time.
  const res = await apiFetch(`${base}&protocol=${protocol}&asset=${asset}`, undefined, 60_000);
  if (!res.ok) throw new Error(`earnings ${res.status}`);
  const j = (await res.json()) as {data?: {today?: string; days?: {day: string; earned: string | null; balance: string}[]}};
  const days = (j.data?.days ?? []).map((d) => ({
    day: d.day,
    earned: d.earned == null ? null : BigInt(d.earned),
    balance: BigInt(d.balance),
  }));
  return {today: j.data?.today ?? new Date().toISOString().slice(0, 10), days};
}

/** The position's daily earnings, loaded on mount and again whenever `nonce` changes (a pull). */
export function useDailyEarnings(vault: string | null | undefined, network: Network, protocol: string, asset: string, nonce = 0) {
  const [data, setData] = useState<DailyEarnings | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!vault) return;
    setLoading(true);
    try {
      setData(await fetchDailyEarnings(vault, network, protocol, asset));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [vault, network, protocol, asset]);
  useEffect(() => {
    setData(null);
  }, [vault, network, protocol, asset]);
  useEffect(() => {
    void load();
  }, [load, nonce]);
  return {data, error, loading};
}

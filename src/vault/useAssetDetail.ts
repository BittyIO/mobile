import {useEffect, useState} from 'react';
import {API_BASE, apiFetch, type Network} from '@/core/chain';

/**
 * What the detail page knows about an asset beyond its price and its contract.
 *
 * The same shape the server sends, which is CoinGecko's per-coin answer trimmed to what a phone
 * shows — see /api/prices/detail. Every field is nullable on purpose: an asset the catalog has no
 * CoinGecko id for has none of this, and a row with nothing to say is left out rather than
 * printed as a zero.
 */
export type AssetDetail = {
  description: string | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  circulating: number | null;
  maxSupply: number | null;
  rank: number | null;
  ath: number | null;
  athDate: string | null;
  change: {h24: number | null; d7: number | null; d30: number | null; y1: number | null};
  website: string | null;
};

/**
 * Cached for the life of the process, keyed by network and symbol.
 *
 * The page is pushed and popped — from the pair screen's ⓘ, from the Trade menu — and the answer
 * is a description and a handful of slow aggregates. Re-reading it on every open would spend a
 * metered call to redraw the same paragraph, and the server holds its own copy for half an hour
 * anyway, so a second fetch would not even be a newer one.
 */
const cache = new Map<string, AssetDetail | null>();
const inflight = new Map<string, Promise<AssetDetail | null>>();

async function load(network: Network, symbol: string): Promise<AssetDetail | null> {
  const url = `${API_BASE}/api/prices/detail?network=${network}&symbol=${encodeURIComponent(symbol)}`;
  try {
    const res = await apiFetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as {detail?: AssetDetail | null};
    return j?.detail ?? null;
  } catch {
    return null;
  }
}

export function useAssetDetail(network: Network, symbol: string): AssetDetail | null {
  const key = `${network}:${symbol.toUpperCase()}`;
  const [detail, setDetail] = useState<AssetDetail | null>(() => cache.get(key) ?? null);

  useEffect(() => {
    let live = true;
    const known = cache.get(key);
    if (known !== undefined) {
      setDetail(known);
      return;
    }
    const task = inflight.get(key) ?? load(network, symbol).finally(() => inflight.delete(key));
    inflight.set(key, task);
    void task.then((d) => {
      // Cached even when null: an asset with no CoinGecko id will not grow one while the app is
      // open, and asking again on every visit is a request that can only fail the same way.
      cache.set(key, d);
      if (live) setDetail(d);
    });
    return () => {
      live = false;
    };
  }, [key, network, symbol]);

  return detail;
}

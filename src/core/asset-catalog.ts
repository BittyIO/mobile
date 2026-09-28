import {useEffect, useState} from 'react';
import {ASSETS, type Asset, type AssetKind, type AssetCategory} from '@/core/assets';
import type {Network} from '@/core/chain';
import type {Address} from 'viem';

/**
 * The asset catalog now lives in the DB and is served by the web app's /api/ethereum/assets. Mobile
 * fetches it and falls back to the bundled ASSETS list (offline, or before the fetch resolves, or if the
 * host is unset). Icons come back as absolute URLs (see TokenIcon's `uri`).
 *
 * Set CATALOG_API_BASE to the web app host for your environment. Empty = bundled assets only (today's
 * behavior), so shipping this before the host is configured changes nothing.
 */
export const CATALOG_API_BASE = ''; // e.g. 'https://app.bitty.io'

type ApiItem = {
  symbol: string;
  address: string;
  decimals: number;
  kind?: string;
  category?: string;
  company?: string;
  icon?: string;
};

// In-memory cache so screens don't refetch on every mount; the catalog changes rarely.
const cache = new Map<string, Asset[]>();

function toAsset(it: ApiItem): Asset {
  return {
    symbol: it.symbol,
    address: it.address as Address,
    decimals: it.decimals,
    kind: (it.kind as AssetKind) ?? 'crypto',
    category: it.category as AssetCategory | undefined,
    company: it.company,
    icon: it.icon,
  };
}

/** Fetch the catalog for a network; null if the host is unset or the request fails. */
export async function fetchCatalog(network: Network): Promise<Asset[] | null> {
  if (!CATALOG_API_BASE) return null;
  try {
    const res = await fetch(
      `${CATALOG_API_BASE}/api/ethereum/assets?network=${encodeURIComponent(network)}`,
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {assets?: ApiItem[]; stableCoins?: ApiItem[]};
    const list = [...(j.assets ?? []), ...(j.stableCoins ?? [])].map(toAsset);
    if (list.length === 0) return null;
    cache.set(network, list);
    return list;
  } catch {
    return null;
  }
}

/** The best catalog we have right now: cached DB rows, else the bundled list. */
export function currentCatalog(network: Network): Asset[] {
  return cache.get(network) ?? ASSETS[network];
}

/** Reactive catalog for a network — bundled/cached immediately, refreshed from the API. */
export function useAssetCatalog(network: Network): Asset[] {
  const [list, setList] = useState<Asset[]>(() => currentCatalog(network));
  useEffect(() => {
    let live = true;
    setList(currentCatalog(network));
    fetchCatalog(network).then((r) => {
      if (live && r) setList(r);
    });
    return () => {
      live = false;
    };
  }, [network]);
  return list;
}

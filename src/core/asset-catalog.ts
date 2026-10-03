import {useEffect, useState} from 'react';
import {ASSETS, RECEIPT_TOKENS, assetCategory, type Asset, type AssetKind} from '@/core/assets';
import {isAddress} from 'viem';
import {apiFetch} from '@/core/chain';
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

// The API keeps icons relative (same-origin for the web); mobile has no same origin, so prepend the
// configured base to make them absolute for remote <Image> loading.
function iconUrl(icon?: string): string | undefined {
  if (!icon) return undefined;
  if (/^https?:\/\//.test(icon)) return icon;
  return `${CATALOG_API_BASE}${icon}`;
}

function toAsset(it: ApiItem): Asset {
  return {
    symbol: it.symbol,
    address: it.address as Address,
    decimals: it.decimals,
    kind: (it.kind as AssetKind) ?? 'crypto',
    category: assetCategory(it.category),
    company: it.company,
    icon: iconUrl(it.icon),
  };
}

/** Fetch the catalog for a network; null if the host is unset or the request fails. */
export async function fetchCatalog(network: Network): Promise<Asset[] | null> {
  if (!CATALOG_API_BASE) return null;
  try {
    const res = await apiFetch(
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

/**
 * Every contract address the app knows to be a token on this network.
 *
 * The catalog's own rows plus the receipt tokens positions are held in — aTokens, sUSDS, stETH —
 * since those are ERC-20s too and just as fatal to send to.
 */
function tokenAddresses(network: Network): Set<string> {
  const out = new Set<string>();
  for (const a of currentCatalog(network)) out.add(a.address.toLowerCase());
  for (const a of ASSETS[network]) out.add(a.address.toLowerCase());
  for (const addr of Object.keys(RECEIPT_TOKENS[network] ?? {})) out.add(addr.toLowerCase());
  return out;
}

/**
 * A well-formed address that is safe to send funds to.
 *
 * Rejects the token contracts themselves. Sending USDC to the USDC contract is a real and
 * unrecoverable mistake — the transfer succeeds, the tokens are owned by a contract with no way
 * to move them, and nothing about the address looks wrong. It is one paste away whenever someone
 * copies a "token address" from an explorer or a listing page, so the one list the app already
 * keeps of every token it touches is worth checking a recipient against.
 *
 * Only addresses the app can be sure about: an unknown contract is still allowed, because the
 * alternative is refusing to pay a multisig or another vault.
 */
export function isPayableAddress(value: string, network: Network): boolean {
  if (!isAddress(value)) return false;
  return !tokenAddresses(network).has(value.toLowerCase());
}

/** True when the address is one of our known tokens — for telling the user WHY it was refused. */
export function isTokenAddress(value: string, network: Network): boolean {
  return isAddress(value) && tokenAddresses(network).has(value.toLowerCase());
}

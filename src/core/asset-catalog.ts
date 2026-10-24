import {useEffect, useState, useSyncExternalStore} from 'react';
import {ASSETS, RECEIPT_TOKENS, assetCategory, knownAssets, registerCatalogAssets, type Asset, type AssetKind} from '@/core/assets';
import {isAddress} from 'viem';
import {apiFetch, API_BASE} from '@/core/chain';
import type {Network} from '@/core/chain';
import type {Address} from 'viem';
import {API_VERSION} from '@/core/vault-contracts';
import {registerServedProtocols} from '@/core/protocols';

/**
 * The asset catalog now lives in the DB and is served by the web app's /api/ethereum/assets. Mobile
 * fetches it and falls back to the bundled ASSETS list (offline, or before the fetch resolves, or if the
 * host is unset). Icons come back as absolute URLs (see TokenIcon's `uri`).
 *
 * Set CATALOG_API_BASE to the web app host for your environment. Empty = bundled assets only (today's
 * behavior), so shipping this before the host is configured changes nothing.
 */
// The same host mobile already uses for every other API call. Set, so the asset catalog is fetched
// from the DB-backed /api/ethereum/assets (with the bundled ASSETS list as the offline fallback) —
// which is what lets a new asset added server-side appear in mobile WITHOUT an app release.
export const CATALOG_API_BASE = API_BASE;

type ApiItem = {
  symbol: string;
  address: string;
  decimals: number;
  kind?: string;
  category?: string;
  tokenName?: string;
  icon?: string;
  /** Known to the vault, never offered to the user. See the filter in {fetchCatalog}. */
  hidden?: boolean;
  /** The row's category on the guard. See {isAmmLiquid}. */
  guardCategory?: number;
  /** Whether the guard has a price feed for it. See {isAmmLiquid}. */
  priced?: boolean;
};

// In-memory cache so screens don't refetch on every mount; the catalog changes rarely. Keyed by
// network.
const cache = new Map<string, Asset[]>();
// One request per network at a time: eight screens call the hook and they all mount at once.
const inflight = new Map<string, Promise<Asset[] | null>>();

/**
 * Bumped when a network's rows actually change, so code that is NOT a catalog consumer can still
 * notice that they did.
 *
 * The balance reader is the one that matters. It asks the chain for a balance per catalogued
 * token, and it runs on mount — which, on a cold launch, is before the catalog has answered. Six
 * assets were added to the DB after this build shipped (SKY, LINK, MORPHO, ARB, ENA, SNDK) and
 * none of them could ever hold a balance here, because the read that would have found one had
 * already gone out against the bundled list.
 */
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Re-renders when any network's catalog changes; pair it with `currentCatalog` in an effect. */
export const useCatalogVersion = (): number => useSyncExternalStore(subscribe, () => version);

/**
 * The catalog version as a plain value, for non-React code that has to tell whether the rows it
 * read against are still current — the balance reader starts before the catalog lands and must not
 * reuse a read taken against the smaller, pre-fetch token set. See {useVaultBalances}.
 */
export const catalogVersionNow = (): number => version;

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
    tokenName: it.tokenName,
    icon: iconUrl(it.icon),
    guardCategory: it.guardCategory,
    priced: it.priced,
  };
}

/** Fetch the catalog for a network; null if the host is unset or the request fails. */
export async function fetchCatalog(network: Network): Promise<Asset[] | null> {
  if (!CATALOG_API_BASE) return null;
  const running = inflight.get(network);
  if (running) return running;
  const task = loadCatalog(network).finally(() => inflight.delete(network));
  inflight.set(network, task);
  return task;
}

async function loadCatalog(network: Network): Promise<Asset[] | null> {
  try {
    const res = await apiFetch(
      `${CATALOG_API_BASE}/api/ethereum/assets?network=${encodeURIComponent(network)}` +
        `&version=${encodeURIComponent(API_VERSION)}`,
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      assets?: ApiItem[];
      stableCoins?: ApiItem[];
      protocols?: {address: string; category: string; name?: string}[];
    };
    // Absent from a server older than the field; the vendored table stands in until it ships.
    if (j.protocols) registerServedProtocols(network, j.protocols);
    /**
     * Two kinds of row the catalog carries and the user must never see.
     *
     * `hidden` is the catalog's own word for it, and the one that matters: sUSDS is served under
     * STABLE COINS on mainnet and Base, flagged hidden, because the vault holds the Sky savings
     * share and has to know its decimals. This client ignored the flag and put it on the Overview
     * as a coin of its own — beside the USDC it represents, wearing USDC's icon, which reads as
     * the balance being there twice. The web has always honoured it.
     *
     * The receipt-token check behind it is this app's own invariant rather than a second guess at
     * the server's: an aToken or a savings share is never an asset here, whether or not a row
     * somewhere remembered to say so.
     */
    const receipts = RECEIPT_TOKENS[network] ?? {};
    const list = [...(j.assets ?? []), ...(j.stableCoins ?? [])]
      .filter((it) => !it.hidden && !receipts[it.address.toLowerCase()])
      .map(toAsset);
    if (list.length === 0) return null;
    const before = cache.get(network);
    cache.set(network, list);
    // So `assetMeta`/`isKnownAsset` can name a token this build does not bundle. See {knownAssets}.
    registerCatalogAssets(network, list);
    if (
      !before ||
      before.length !== list.length ||
      before.some((a, i) => a.address !== list[i].address || a.guardCategory !== list[i].guardCategory || a.priced !== list[i].priced)
    ) {
      version++;
      for (const fn of listeners) fn();
    }
    return list;
  } catch {
    return null;
  }
}

/**
 * The best catalog we have right now.
 *
 * `knownAssets` rather than the raw rows, so one list answers for both halves: the catalog's
 * fields where it has them — names above all, which the bundled table has let drift — and the
 * bundled row for anything it has not got, or for everything before it has answered.
 */
export function currentCatalog(network: Network): Asset[] {
  return knownAssets(network);
}

/** Reactive catalog for a network — bundled/cached immediately, refreshed from the API. */
export function useAssetCatalog(network: Network): Asset[] {
  // Subscribe to the global catalog version, so a consumer re-reads when ANY screen's fetch changed
  // the rows — not only when its OWN fetch did. Without this a tab mounted before the change (the
  // Overview, which stays mounted while the asset list is visited and adds a new asset) kept the old
  // list until the app was relaunched: its effect below only re-runs on a network switch, and its
  // own fetch had already resolved against the smaller list.
  const version = useCatalogVersion();
  const [list, setList] = useState<Asset[]>(() => currentCatalog(network));
  useEffect(() => {
    let live = true;
    // The merged view, not the raw rows: see {currentCatalog}.
    fetchCatalog(network).then((r) => {
      if (live && r) setList(currentCatalog(network));
    });
    return () => {
      live = false;
    };
  }, [network]);
  // Resync to the global catalog on a network switch and on every version bump (a fetch anywhere
  // found new rows). currentCatalog hands back a fresh merged list, so this reflects additions the
  // moment they land, in every mounted consumer at once.
  useEffect(() => {
    setList(currentCatalog(network));
  }, [network, version]);
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

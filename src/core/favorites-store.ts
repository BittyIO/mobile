import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import {ASSETS} from '@/core/assets';
import type {Network} from '@/core/chain';

/**
 * The assets the Overview lists, chosen by the user.
 *
 * The Overview answers "what do I hold", and on a network with two dozen tokenized stocks that is
 * a page of empty rows unless the user says which ones they care about. Browsing the full catalog
 * is the Trade tab's job; starring one there is what puts it here.
 *
 * Defaults are the assets any vault is expected to hold: the dollars it is funded in and the two
 * crypto majors. They are a DEFAULT and not a floor — a network with nothing starred shows an
 * empty list, because the user said so.
 */
const DEFAULTS = ['USDC', 'USDT', 'USDG', 'WETH', 'cbBTC', 'WBTC'];

const store = new MMKV({id: 'bitty.favorites'});
const key = (n: Network) => `fav:${n}`;
const orderKey = (n: Network) => `order:${n}`;

/** The stored list, or the defaults narrowed to what this network actually has. */
function load(network: Network): string[] {
  const raw = store.getString(key(network));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      /* corrupt entry: fall through to the defaults */
    }
  }
  const have = new Set(ASSETS[network].map((a) => a.symbol));
  return DEFAULTS.filter((s) => have.has(s));
}

const NETWORKS = Object.keys(ASSETS) as Network[];

function loadOrder(network: Network): string[] {
  const raw = store.getString(orderKey(network));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

type State = {
  /** Per network, because the catalogs differ and a star on one says nothing about another. */
  sets: Record<string, string[]>;
  /**
   * The order the user dragged the Overview into, by symbol.
   *
   * Empty until they move something. A symbol missing from it — a newly starred asset, or one that
   * arrived with the catalog — sorts after everything listed, so a new row appears at the bottom
   * rather than somewhere arbitrary in the middle.
   */
  order: Record<string, string[]>;
  toggle: (network: Network, symbol: string) => void;
  setOrder: (network: Network, symbols: string[]) => void;
};

export const useFavorites = create<State>((set, get) => ({
  sets: Object.fromEntries(NETWORKS.map((n) => [n, load(n)])),
  order: Object.fromEntries(NETWORKS.map((n) => [n, loadOrder(n)])),
  toggle: (network, symbol) => {
    const current = get().sets[network] ?? [];
    const next = current.includes(symbol) ? current.filter((s) => s !== symbol) : [...current, symbol];
    store.set(key(network), JSON.stringify(next));
    set({sets: {...get().sets, [network]: next}});
  },
  setOrder: (network, symbols) => {
    store.set(orderKey(network), JSON.stringify(symbols));
    set({order: {...get().order, [network]: symbols}});
  },
}));

/** Sort by the user's order; anything they have never moved keeps its place at the end. */
export function useAssetOrder(network: Network): {
  sort: <T extends {symbol: string}>(items: T[]) => T[];
  save: (symbols: string[]) => void;
  /**
   * The order as one string, for a memo to depend on.
   *
   * `sort` is a new function on every render and so cannot be a dependency, and the array behind
   * it is a new reference too. Without something stable that CHANGES when the order does, a list
   * memoised on its rows keeps the arrangement it was built with — which is why a drag appeared
   * to do nothing until the next refresh rebuilt it.
   */
  key: string;
} {
  const order = useFavorites((s) => s.order[network]);
  const setOrder = useFavorites((s) => s.setOrder);
  const rank = new Map((order ?? []).map((sym, i) => [sym, i]));
  return {
    sort: (items) =>
      [...items].sort((a, b) => (rank.get(a.symbol) ?? Infinity) - (rank.get(b.symbol) ?? Infinity)),
    save: (symbols) => setOrder(network, symbols),
    key: (order ?? []).join(','),
  };
}

/** Is this asset starred on this network? Subscribes, so a star toggles the Overview immediately. */
export function useIsFavorite(network: Network, symbol: string | undefined): boolean {
  return useFavorites((s) => (symbol ? (s.sets[network] ?? []).includes(symbol) : false));
}

/** The starred symbols for a network, as a set for filtering a list. */
export function useFavoriteSet(network: Network): Set<string> {
  const list = useFavorites((s) => s.sets[network]);
  return new Set(list ?? []);
}

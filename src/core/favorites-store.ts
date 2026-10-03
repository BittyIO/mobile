import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import {ASSETS} from '@/core/assets';
import type {Network} from '@/core/chain';

/**
 * The watch lists the Overview shows, and what is on each.
 *
 * The Overview answers "what do I hold", and on a network with two dozen tokenized stocks that is
 * a page of empty rows unless the user says which ones they care about. Browsing the full catalog
 * is the Trade tab's job; starring one there is what puts it on the list in front.
 *
 * There can be SEVERAL lists per network — "Stables", "Majors", whatever the user needs — with one
 * of them in front at a time. A star always acts on the list in front, so every hook here reads
 * through the active list and the screens that call them did not have to learn about the rest.
 *
 * Defaults are the assets any vault is expected to hold: the dollars it is funded in and the two
 * crypto majors. They are a DEFAULT and not a floor — a list the user has emptied stays empty.
 */
const DEFAULTS = ['USDC', 'USDT', 'USDG', 'WETH', 'cbBTC', 'WBTC'];

export type WatchList = {
  id: string;
  /** What the user called it. Empty means "not named", and the UI falls back to "Watch list". */
  name: string;
  symbols: string[];
};

const store = new MMKV({id: 'bitty.favorites'});
const listsKey = (n: Network) => `lists:${n}`;
const activeKey = (n: Network) => `active:${n}`;
const orderKey = (n: Network, id: string) => `order:${n}:${id}`;
// Pre-multi-list storage, read once so an existing install keeps its stars and its arrangement.
const legacyKey = (n: Network) => `fav:${n}`;
const legacyOrderKey = (n: Network) => `order:${n}`;

/**
 * The first list is not a list the user curated — it is the vault itself.
 *
 * It shows everything held whether or not it has been starred, so a balance can never go missing
 * because of how someone arranged their lists, and it cannot be renamed or deleted: every other
 * list is a deliberate subset, and there has to be one view that is not.
 */
export const DEFAULT_LIST_ID = 'default';
export const isAssetsList = (id: string | undefined) => id === DEFAULT_LIST_ID;

const parseArray = (raw: string | undefined): string[] | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : null;
  } catch {
    return null;
  }
};

/** The stored lists, migrating a single pre-existing list, then falling back to the defaults. */
function loadLists(network: Network): WatchList[] {
  const raw = store.getString(listsKey(network));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length) return parsed as WatchList[];
    } catch {
      /* corrupt entry: fall through */
    }
  }
  const have = new Set(ASSETS[network].map((a) => a.symbol));
  const legacy = parseArray(store.getString(legacyKey(network)));
  return [{id: DEFAULT_LIST_ID, name: '', symbols: legacy ?? DEFAULTS.filter((s) => have.has(s))}];
}

function loadOrder(network: Network, id: string): string[] {
  const own = parseArray(store.getString(orderKey(network, id)));
  if (own) return own;
  // The arrangement from before there were lists belongs to the one that inherited its symbols.
  return id === DEFAULT_LIST_ID ? parseArray(store.getString(legacyOrderKey(network))) ?? [] : [];
}

const NETWORKS = Object.keys(ASSETS) as Network[];
const okey = (network: Network, id: string) => `${network}:${id}`;

type State = {
  /** Per network, because the catalogs differ and a star on one says nothing about another. */
  lists: Record<string, WatchList[]>;
  /** Which list is in front, per network. */
  active: Record<string, string>;
  /**
   * The order the user dragged a list into, by symbol, keyed `${network}:${listId}`.
   *
   * Empty until they move something. A symbol missing from it — a newly starred asset, or one that
   * arrived with the catalog — sorts after everything listed, so a new row appears at the bottom
   * rather than somewhere arbitrary in the middle.
   */
  order: Record<string, string[]>;
  /** Star or unstar, on the list in front. */
  toggle: (network: Network, symbol: string) => void;
  setOrder: (network: Network, symbols: string[]) => void;
  select: (network: Network, id: string) => void;
  /** Append an empty list and put it in front. Returns its id. */
  add: (network: Network, name: string) => string;
  rename: (network: Network, id: string, name: string) => void;
  /** Delete a list. The last one is never removed — there has to be something to star onto. */
  remove: (network: Network, id: string) => void;
};

const persist = (network: Network, lists: WatchList[]) => store.set(listsKey(network), JSON.stringify(lists));

export const useFavorites = create<State>((set, get) => {
  const lists = Object.fromEntries(NETWORKS.map((n) => [n, loadLists(n)]));
  const active = Object.fromEntries(
    NETWORKS.map((n) => {
      const saved = store.getString(activeKey(n));
      const has = (lists[n] as WatchList[]).some((l) => l.id === saved);
      return [n, has && saved ? saved : (lists[n] as WatchList[])[0].id];
    }),
  );
  const order: Record<string, string[]> = {};
  for (const n of NETWORKS) for (const l of lists[n] as WatchList[]) order[okey(n, l.id)] = loadOrder(n, l.id);

  const activeList = (network: Network): WatchList => {
    const all = get().lists[network] ?? [];
    return all.find((l) => l.id === get().active[network]) ?? all[0];
  };

  return {
    lists,
    active,
    order,

    toggle: (network, symbol) => {
      const cur = activeList(network);
      if (!cur) return;
      const symbols = cur.symbols.includes(symbol)
        ? cur.symbols.filter((s) => s !== symbol)
        : [...cur.symbols, symbol];
      const next = (get().lists[network] ?? []).map((l) => (l.id === cur.id ? {...l, symbols} : l));
      persist(network, next);
      set({lists: {...get().lists, [network]: next}});
    },

    setOrder: (network, symbols) => {
      const cur = activeList(network);
      if (!cur) return;
      store.set(orderKey(network, cur.id), JSON.stringify(symbols));
      set({order: {...get().order, [okey(network, cur.id)]: symbols}});
    },

    select: (network, id) => {
      store.set(activeKey(network), id);
      set({active: {...get().active, [network]: id}});
    },

    add: (network, name) => {
      const id = `l${Date.now().toString(36)}`;
      const next = [...(get().lists[network] ?? []), {id, name: name.trim(), symbols: []}];
      persist(network, next);
      store.set(activeKey(network), id);
      set({
        lists: {...get().lists, [network]: next},
        active: {...get().active, [network]: id},
        order: {...get().order, [okey(network, id)]: []},
      });
      return id;
    },

    rename: (network, id, name) => {
      // Enforced here, not only by hiding the control: "Assets" is a view of the vault, and a
      // renamed one would stop being recognisable as the list that cannot lose a balance.
      if (isAssetsList(id)) return;
      const next = (get().lists[network] ?? []).map((l) => (l.id === id ? {...l, name: name.trim()} : l));
      persist(network, next);
      set({lists: {...get().lists, [network]: next}});
    },

    remove: (network, id) => {
      const all = get().lists[network] ?? [];
      if (all.length <= 1 || isAssetsList(id)) return;
      const next = all.filter((l) => l.id !== id);
      persist(network, next);
      store.delete(orderKey(network, id));
      const nextActive = get().active[network] === id ? next[0].id : get().active[network];
      store.set(activeKey(network), nextActive);
      set({lists: {...get().lists, [network]: next}, active: {...get().active, [network]: nextActive}});
    },
  };
});

/** The label to show: what the user named it, or the generic one. */
export const watchListLabel = (l: WatchList | undefined, fallback: string) => l?.name || fallback;

/**
 * The number an unnamed list is shown as — "Watch list #2".
 *
 * Counted among the user's OWN lists, so "Assets" does not take the number 1: it is never shown
 * numbered, and letting it occupy a place would make the first list anyone creates number 2.
 * Positional rather than stored, so deleting a list renumbers the rest instead of leaving a gap.
 */
export const watchListNumber = (lists: WatchList[], id: string): number =>
  lists.filter((l) => !isAssetsList(l.id)).findIndex((l) => l.id === id) + 1;

/** Every list on this network, and the controls for them. */
export function useWatchLists(network: Network) {
  const lists = useFavorites((s) => s.lists[network]) ?? [];
  const activeId = useFavorites((s) => s.active[network]);
  return {
    lists,
    activeId,
    active: lists.find((l) => l.id === activeId) ?? lists[0],
    select: useFavorites((s) => s.select),
    add: useFavorites((s) => s.add),
    rename: useFavorites((s) => s.rename),
    remove: useFavorites((s) => s.remove),
  };
}

/** The symbols on ONE list, as a set for filtering — defaults to the one in front. */
export function useWatchListSet(network: Network, listId?: string): Set<string> {
  const list = useFavorites((s) => {
    const all = s.lists[network] ?? [];
    return all.find((l) => l.id === (listId ?? s.active[network])) ?? all[0];
  });
  return new Set(list?.symbols ?? []);
}

/** The symbols on the list in front. */
export const useFavoriteSet = (network: Network): Set<string> => useWatchListSet(network);

/**
 * Sort by the user's order for one list; anything never moved keeps its place at the end.
 *
 * `listId` names the list when a caller renders more than one at a time (the Overview's pager);
 * omitted, it is the list in front.
 */
export function useAssetOrder(
  network: Network,
  listId?: string,
): {
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
  const id = useFavorites((s) => listId ?? s.active[network]);
  const order = useFavorites((s) => s.order[okey(network, id)]);
  const setOrder = useFavorites((s) => s.setOrder);
  const rank = new Map((order ?? []).map((sym, i) => [sym, i]));
  return {
    sort: (items) =>
      [...items].sort((a, b) => (rank.get(a.symbol) ?? Infinity) - (rank.get(b.symbol) ?? Infinity)),
    save: (symbols) => setOrder(network, symbols),
    key: (order ?? []).join(','),
  };
}

/** Is this asset on the list in front? Subscribes, so a star toggles the Overview immediately. */
export function useIsFavorite(network: Network, symbol: string | undefined): boolean {
  return useFavorites((s) => {
    if (!symbol) return false;
    const all = s.lists[network] ?? [];
    const cur = all.find((l) => l.id === s.active[network]) ?? all[0];
    return (cur?.symbols ?? []).includes(symbol);
  });
}

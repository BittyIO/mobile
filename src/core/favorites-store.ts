import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import {ASSETS} from '@/core/assets';
import {useVaults} from '@/core/vault-store';
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
 * Per network and PER VAULT. A vault is a separate portfolio with its own holdings and its own
 * reason to exist — a trading one and a savings one hold different things — so the rows someone
 * arranged for one said nothing about the other, and starring an asset on either edited both.
 * The scope is the vault's BIP-44 index, which is local, stable and needs no address derived to
 * read, and switching vault re-reads every list from disk ({State.reload}).
 *
 * Defaults are the assets any vault is expected to hold: the dollars it is funded in and the two
 * crypto majors. They are a DEFAULT and not a floor — a list the user has emptied stays empty.
 */
const DEFAULTS = ['USDC', 'USDT', 'USDG', 'WETH', 'cbBTC', 'WBTC', 'WTRX'];

export type WatchList = {
  id: string;
  /** What the user called it. Empty means "not named", and the UI falls back to "Watch list". */
  name: string;
  symbols: string[];
  /**
   * A list the app made (see {seedStocks}). Unnamed, it is called what it is in the language on
   * screen — "Stocks", "股票" — and only a name the owner types is stored.
   */
  preset?: 'stocks';
};

const store = new MMKV({id: 'bitty.favorites'});
const listsKey = (n: Network, v: number) => `lists:${n}:v${v}`;
const activeKey = (n: Network, v: number) => `active:${n}:v${v}`;
const orderKey = (n: Network, v: number, id: string) => `order:${n}:${id}:v${v}`;
/**
 * Storage from before the lists were per vault, read by VAULT 0 only.
 *
 * Index 0 is the vault that existed before there was more than one, so its lists are the ones
 * already on the device: inheriting them there keeps an upgrading install exactly as it was,
 * while a second vault starts from the defaults rather than from someone else's arrangement.
 */
const sharedListsKey = (n: Network) => `lists:${n}`;
const sharedActiveKey = (n: Network) => `active:${n}`;
const sharedOrderKey = (n: Network, id: string) => `order:${n}:${id}`;
// Pre-multi-list storage, read once so an existing install keeps its stars and its arrangement.
const legacyKey = (n: Network) => `fav:${n}`;
const legacyOrderKey = (n: Network) => `order:${n}`;
// Set once the Stocks list has been offered, so a list the owner deleted is never put back.
const stocksSeededKey = (n: Network, v: number) => `seeded:stocks2:${n}:v${v}`;

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

/**
 * What this device has WRITTEN DOWN for a vault, with no defaults filled in.
 *
 * The distinction matters for one caller: importing a list from another vault. Through
 * {loadLists} a vault nobody has ever opened answers with the default list, which would offer
 * "Vault 2 · Assets" for a vault that has no lists at all — six tickers this device invented,
 * presented as something the user put there.
 */
export function storedLists(network: Network, vault: number): WatchList[] {
  const raw =
    store.getString(listsKey(network, vault)) ?? (vault === 0 ? store.getString(sharedListsKey(network)) : undefined);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length ? (parsed as WatchList[]) : [];
  } catch {
    return [];
  }
}

/** The stored lists, migrating a single pre-existing list, then falling back to the defaults. */
function loadLists(network: Network, vault: number): WatchList[] {
  const stored = storedLists(network, vault);
  if (stored.length) return stored;
  const have = new Set(ASSETS[network].map((a) => a.symbol));
  const legacy = vault === 0 ? parseArray(store.getString(legacyKey(network))) : null;
  return [{id: DEFAULT_LIST_ID, name: '', symbols: legacy ?? DEFAULTS.filter((s) => have.has(s))}];
}

function loadOrder(network: Network, vault: number, id: string): string[] {
  const own = parseArray(store.getString(orderKey(network, vault, id)));
  if (own) return own;
  if (vault !== 0) return [];
  const shared = parseArray(store.getString(sharedOrderKey(network, id)));
  if (shared) return shared;
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
  /**
   * Re-read every list from disk, for the vault that is now in front.
   *
   * Called when the active vault changes — see the subscription below the store. The maps stay
   * keyed by NETWORK rather than by (network, vault): only one vault is ever on screen, so a
   * screen asking "the lists for mainnet" means the vault it is showing, and keying by both would
   * have put the vault into every signature in this file and every call site of them.
   */
  reload: (vault: number) => void;
  /**
   * Add a list of stocks, once per network and vault, behind the lists already there.
   *
   * A network that trades tokenized stocks says so nowhere on the Overview until someone opens the
   * Trade tab's Stocks page, so the largest of them arrive as a list of their own. Once: deleted, it
   * stays deleted, and the Assets list in front is left as it was.
   */
  seedStocks: (network: Network, symbols: string[]) => void;
  /**
   * Undo a Stocks list seeded with another network's tickers.
   *
   * The first build seeded during a network switch, before the Overview's catalog had caught up, so
   * a network with no stocks (Arbitrum) got the last one's — none of which trade there, so the list
   * read empty. Tickers this network does not have are dropped, and a list left with none is
   * removed and may be seeded again once the network has stocks of its own.
   */
  repairStocks: (network: Network, have: Set<string>) => void;
};

/** Which vault's lists are loaded and written. Read at call time, never captured. */
const vaultIndex = () => useVaults.getState().activeIndex;

const persist = (network: Network, lists: WatchList[]) =>
  store.set(listsKey(network, vaultIndex()), JSON.stringify(lists));

/** Every network's lists for ONE vault, as the store holds them. */
function loadAll(vault: number): {
  lists: Record<string, WatchList[]>;
  active: Record<string, string>;
  order: Record<string, string[]>;
} {
  const lists = Object.fromEntries(NETWORKS.map((n) => [n, loadLists(n, vault)]));
  const active = Object.fromEntries(
    NETWORKS.map((n) => {
      const saved =
        store.getString(activeKey(n, vault)) ?? (vault === 0 ? store.getString(sharedActiveKey(n)) : undefined);
      const has = (lists[n] as WatchList[]).some((l) => l.id === saved);
      return [n, has && saved ? saved : (lists[n] as WatchList[])[0].id];
    }),
  );
  const order: Record<string, string[]> = {};
  for (const n of NETWORKS)
    for (const l of lists[n] as WatchList[]) order[okey(n, l.id)] = loadOrder(n, vault, l.id);
  return {lists, active, order};
}

export const useFavorites = create<State>((set, get) => {
  const {lists, active, order} = loadAll(vaultIndex());

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
      store.set(orderKey(network, vaultIndex(), cur.id), JSON.stringify(symbols));
      set({order: {...get().order, [okey(network, cur.id)]: symbols}});
    },

    select: (network, id) => {
      store.set(activeKey(network, vaultIndex()), id);
      set({active: {...get().active, [network]: id}});
    },

    add: (network, name) => {
      const id = `l${Date.now().toString(36)}`;
      const next = [...(get().lists[network] ?? []), {id, name: name.trim(), symbols: []}];
      persist(network, next);
      store.set(activeKey(network, vaultIndex()), id);
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
      store.delete(orderKey(network, vaultIndex(), id));
      const nextActive = get().active[network] === id ? next[0].id : get().active[network];
      store.set(activeKey(network, vaultIndex()), nextActive);
      set({lists: {...get().lists, [network]: next}, active: {...get().active, [network]: nextActive}});
    },

    reload: (vault) => set(loadAll(vault)),

    repairStocks: (network, have) => {
      const all = get().lists[network] ?? [];
      const bad = all.filter((l) => l.preset === 'stocks' && l.symbols.some((x) => !have.has(x)));
      if (!bad.length) return;
      let next = all.map((l) => (bad.includes(l) ? {...l, symbols: l.symbols.filter((x) => have.has(x))} : l));
      const emptied = next.filter((l) => l.preset === 'stocks' && l.symbols.length === 0).map((l) => l.id);
      if (emptied.length) {
        next = next.filter((l) => !emptied.includes(l.id));
        for (const id of emptied) store.delete(orderKey(network, vaultIndex(), id));
        store.delete(stocksSeededKey(network, vaultIndex()));
      }
      persist(network, next);
      const activeNow = get().active[network];
      const nextActive = next.some((l) => l.id === activeNow) ? activeNow : next[0].id;
      store.set(activeKey(network, vaultIndex()), nextActive);
      set({lists: {...get().lists, [network]: next}, active: {...get().active, [network]: nextActive}});
    },

    seedStocks: (network, symbols) => {
      const flag = stocksSeededKey(network, vaultIndex());
      if (!symbols.length || store.getBoolean(flag)) return;
      const id = `l${Date.now().toString(36)}`;
      const next = [...(get().lists[network] ?? []), {id, name: '', symbols, preset: 'stocks' as const}];
      persist(network, next);
      store.set(flag, true);
      set({lists: {...get().lists, [network]: next}, order: {...get().order, [okey(network, id)]: []}});
    },
  };
});

/**
 * A vault switch is a different set of lists, so the store re-reads them.
 *
 * Here rather than in a screen, because the lists are read by three of them and the Overview is
 * not always the one on top when the vault changes. Synchronous, so the first render after the
 * switch already has the new vault's rows — nothing briefly shows the old vault's arrangement.
 */
useVaults.subscribe((s, prev) => {
  if (s.activeIndex !== prev.activeIndex) useFavorites.getState().reload(s.activeIndex);
});

/** The label to show: what the user named it, or the generic one. */
export const watchListLabel = (l: WatchList | undefined, fallback: string) => l?.name || fallback;

/**
 * What a list is called while it has no name of its own: "Assets", a preset's own name, or
 * "Watch list #2". The placeholder of the title field, and the label wherever the list is shown.
 */
export function unnamedListLabel(lists: WatchList[], l: WatchList | undefined, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (isAssetsList(l?.id)) return t('mobile.home.all_assets');
  if (l?.preset === 'stocks') return t('mobile.home.stocks_list');
  return t('mobile.home.watch_list_n', {n: watchListNumber(lists, l?.id ?? '')});
}

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
 * The symbols on the list in front — unless that list is the app's own Stocks preset.
 *
 * The seeded Stocks list is what the app chose to show, not something the owner picked, so a picker
 * asking "what does this user care about" must not read seven stocks they never touched as theirs.
 */
export function useChosenSet(network: Network): Set<string> {
  const list = useFavorites((s) => {
    const all = s.lists[network] ?? [];
    return all.find((l) => l.id === s.active[network]) ?? all[0];
  });
  return new Set(list && list.preset !== 'stocks' ? list.symbols : []);
}

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

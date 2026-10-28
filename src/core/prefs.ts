import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

/**
 * Small UI preferences that should survive a relaunch.
 *
 * Not settings — nothing here has a row in Settings. These are the choices a user makes in passing
 * and would be annoyed to make again, like leaving a filter switched on. Kept apart from the
 * stores that hold real state so a stray preference can never look like data.
 */
const store = new MMKV({id: 'bitty.prefs'});

export function getFlag(key: string, fallback = false): boolean {
  const v = store.getBoolean(key);
  return v === undefined ? fallback : v;
}

export function setFlag(key: string, value: boolean): void {
  store.set(key, value);
}

/** Show every order on the trade page, not just the pair in front of you. Off until asked for. */
export const SHOW_OTHER_ORDERS = 'trade.showOthers';

/** Keep assets with nothing in them off the Overview. Off, so a starred asset still shows at zero. */

/**
 * The eye above the total: every figure that is the user's own is masked.
 *
 * Persisted because the reason for turning it on — being somewhere the screen can be read over a
 * shoulder — outlasts the app being open, and an app that forgets shows the balance at launch,
 * which is the one moment the user had asked it not to.
 */
export const HIDE_BALANCES = 'overview.hideBalances';

/** The pair the Trade tab reopens on, as "BASE/QUOTE". */
export const LAST_PAIR = 'trade.lastPair';

export function getPref(key: string): string | undefined {
  return store.getString(key);
}

export function setPref(key: string, value: string): void {
  store.set(key, value);
}

/**
 * The stablecoin float the vault is asked to keep for relay fees — on/off, and how much.
 *
 * Keyed by NETWORK AND VAULT, because that is what it is about: a mainnet vault paying the better
 * part of a dollar a relay wants a different float from one on Base paying cents, and two vaults
 * on the same chain are two different pots of money. One global figure meant setting 1000 on
 * mainnet and finding 1000 waiting on every other chain, where the picker does not even offer it.
 *
 * Here rather than in a store of its own: two keys in the preferences file that is already open
 * at launch need no module, no subscription and nothing initialised on a render path.
 *
 * LOCAL, and not on chain: a guard rail this client draws for its owner, not a rule the vault
 * enforces — nothing stops the same vault being emptied from the web, and nothing should.
 */
const RESERVE_AMOUNT = 'fees.reserveAmount';
const FEE_COIN_ORDER = 'fees.coinOrder';

/**
 * What the reserve is unless the owner says otherwise, in whole dollars: five on mainnet, where a
 * relay costs the better part of a dollar, and one on a layer 2, where it costs cents.
 */
export const defaultGasReserve = (network: string): number => (network === 'mainnet' ? 5 : 1);

const scoped = (base: string, network: string, vault: string | null | undefined) =>
  `${base}:${network}:${(vault ?? 'none').toLowerCase()}`;

/**
 * The owner's order of preference for fee coins, by symbol, as dragged on the Network fee page.
 *
 * The first coin is the one the relayer is asked to bill and the first candidate to hold the
 * reserve (see {resolveFeeReserve}); a coin missing from the list keeps its place after the named
 * ones. Empty until the owner first drags.
 */
export const feeCoinOrder = (network: string, vault: string | null | undefined): string[] =>
  (getPref(scoped(FEE_COIN_ORDER, network, vault)) ?? '').split(',').filter(Boolean);

export const setFeeCoinOrder = (network: string, vault: string | null | undefined, symbols: string[]): void =>
  setPref(scoped(FEE_COIN_ORDER, network, vault), symbols.join(','));

/** `items` sorted by the saved order; anything it does not name keeps its relative place, after. */
export function inFeeCoinOrder<T extends {symbol: string}>(
  network: string,
  vault: string | null | undefined,
  items: T[],
): T[] {
  const order = feeCoinOrder(network, vault).map((s) => s.toUpperCase());
  const rank = (sym: string) => {
    const i = order.indexOf(sym.toUpperCase());
    return i === -1 ? order.length : i;
  };
  return items
    .map((item, i) => ({item, i}))
    .sort((a, b) => rank(a.item.symbol) - rank(b.item.symbol) || a.i - b.i)
    .map((x) => x.item);
}

export const gasReserveAmount = (network: string, vault: string | null | undefined): string =>
  getPref(scoped(RESERVE_AMOUNT, network, vault)) ?? String(defaultGasReserve(network));

export const setGasReserveAmount = (network: string, vault: string | null | undefined, v: string): void =>
  setPref(scoped(RESERVE_AMOUNT, network, vault), v);

/** The configured size of the reserve, whichever coin ends up holding it. */
export function gasReserveSize(network: string, vault: string | null | undefined): number {
  const n = Number(gasReserveAmount(network, vault));
  return Number.isFinite(n) && n >= 0 ? n : defaultGasReserve(network);
}

/**
 * How far a market swap may fill from its quote before the router refuses it, in basis points.
 *
 * A trading preference rather than a vault setting: it is about how patient the owner is with a
 * price, which does not change because they switched chains or vaults, so unlike the fee reserve
 * this is one value. Local, like everything else here.
 */
const SLIPPAGE = 'trade.slippageBps';

/**
 * Two percent.
 *
 * One was the old fixed figure and it refuses too much: the tokenized stocks this vault trades
 * sit in thin pools where a fill a point and a half away is ordinary, and a market order that
 * reverts teaches nothing except that the app is unreliable. Two still leaves a sandwich too
 * little to pay for itself on the pairs that matter, and anyone trading something thinner can
 * raise it a step.
 */
export const DEFAULT_SLIPPAGE_BPS = 200;

/**
 * Five percent, and not a basis point more.
 *
 * The tolerance IS the budget a sandwich gets to work with: a mainnet market swap is a public
 * transaction, and a searcher who sees a floor twenty percent below the quote can buy ahead, let
 * the trade fill at that floor and sell into it, keeping the difference. Below five percent the
 * attack is rarely worth its own gas; above it, the loss is bounded only by what was authorised.
 *
 * Enforced here rather than only in the picker, so a value stored by an older build — this app
 * briefly offered ten and twenty — is refused on read and falls back to the default.
 */
const MAX_SLIPPAGE_BPS = 500;

export function slippageBps(): number {
  const raw = getPref(SLIPPAGE);
  if (raw === undefined) return DEFAULT_SLIPPAGE_BPS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= MAX_SLIPPAGE_BPS ? n : DEFAULT_SLIPPAGE_BPS;
}

export const setSlippageBps = (bps: number): void => setPref(SLIPPAGE, String(bps));

/**
 * How far back the Trade panel's Finished list reaches.
 *
 * Finished only ever grows: every order the pair has ever filled, cancelled or let expire is in it,
 * and the rows a trader is actually looking for are the recent ones. A window is the cheap answer —
 * cheaper than paging, and it keeps the list short enough that the tab is readable at a glance.
 *
 * A STORE and not just a preference, because it is set in one place (the ⋯ sheet) and read in
 * another (the panel), and the panel has to redraw when it changes. The same arrangement the
 * market-cap toggle uses for the same reason.
 */
export type FinishedWindow = '24h' | '1w' | '1m';

/** In the order the sheet lists them: shortest first, so the default sits in the middle. */
export const FINISHED_WINDOWS: FinishedWindow[] = ['24h', '1w', '1m'];

const FINISHED_SECONDS: Record<FinishedWindow, number> = {
  '24h': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  // A month as thirty days. Nothing here is a calendar — it is "about this far back".
  '1m': 30 * 24 * 60 * 60,
};

/** The cutoff in unix seconds: rows older than this are out. */
export const finishedSince = (w: FinishedWindow): number =>
  Math.floor(Date.now() / 1000) - FINISHED_SECONDS[w];

const FINISHED_KEY = 'trade.finishedWindow';

/**
 * A week.
 *
 * A day is too short for a limit order, which is the whole point of placing one — several days is
 * an ordinary life for it, and a window that hid last Tuesday's fill would hide the thing someone
 * opened the tab to check. A month is the long answer for when that is not enough.
 */
const DEFAULT_FINISHED: FinishedWindow = '1w';

export const useFinishedWindow = create<{window: FinishedWindow; setWindow: (w: FinishedWindow) => void}>((set) => {
  const saved = getPref(FINISHED_KEY) as FinishedWindow | undefined;
  return {
    // Validated against the list, not trusted: a value from a build that offered different windows
    // would otherwise index the seconds table with nothing and cut the list to nothing.
    window: saved && FINISHED_WINDOWS.includes(saved) ? saved : DEFAULT_FINISHED,
    setWindow: (w) => {
      setPref(FINISHED_KEY, w);
      set({window: w});
    },
  };
});

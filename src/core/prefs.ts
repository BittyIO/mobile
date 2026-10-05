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

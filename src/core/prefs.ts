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

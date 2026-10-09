import {MMKV} from 'react-native-mmkv';

/**
 * When an order was cancelled, because nothing else knows.
 *
 * CoW's order object carries a creation date and a status and no third date: a fill's time is
 * recoverable from the settlement transaction (see {fetchFillTxs}), but a cancellation moves no
 * tokens and leaves nothing in the transfer feed to match against. So the only moment the time is
 * knowable is the moment the app does the cancelling, and the only place it can be kept is here.
 *
 * The consequence is the honest one: an order cancelled from this device has a time, and one
 * cancelled from the web app or before this existed does not. The detail panel prints the line
 * when there is a time and leaves it out when there is not — rather than falling back to the
 * order's `validTo`, which on a cancelled order is a deadline that stopped applying.
 *
 * Keyed by order uid, which is unique across networks and vaults, so there is nothing to scope.
 * Seconds, to match every other timestamp the order views handle.
 */
const store = new MMKV({id: 'bitty.cancels'});

export function recordCancelled(uids: string[], at = Math.floor(Date.now() / 1000)): void {
  for (const uid of uids) store.set(uid.toLowerCase(), at);
}

export function cancelledAt(uid: string): number | undefined {
  const v = store.getNumber(uid.toLowerCase());
  return v && v > 0 ? v : undefined;
}

/**
 * The earliest of a schedule's parts, which is when the schedule itself was cancelled.
 *
 * Cancelling a TWAP invalidates every slot still open in one transaction, so its parts all carry
 * the same instant; taking the earliest keeps it right if a later slot was ever cancelled alone.
 */
export function cancelledAtAny(uids: string[]): number | undefined {
  const times = uids.map(cancelledAt).filter((n): n is number => n !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

/**
 * How an order READS — the bucket it belongs in, the pill it wears, and how a TWAP's parts collapse
 * into the schedule that placed them.
 *
 * These lived inside the Trade screen, where the orders list was the only thing that needed them.
 * The pushed Order History shows the same orders in the same buckets, and two copies of "which
 * statuses count as finished" would have drifted the first time CoW added a state.
 */
import type {CowOrder} from './limit';
import type {TwapSchedule} from './twap';

/** Where an order sits. Both lists bucket by this; the Trade screen shows only two of the three. */
export type OrderBucket = 'open' | 'finished' | 'cancelled';
export const ORDER_BUCKETS: OrderBucket[] = ['open', 'finished', 'cancelled'];

/**
 * CoW's account endpoint keeps reporting an order as "open" for a while after its validTo passes, so
 * an order that is really done would stay stuck under Open and never reach Finished. A past-validTo
 * "open" order is treated as expired here so it buckets correctly.
 *
 * `cancelled` is the set invalidated in this session: the orderbook lags an on-chain invalidation,
 * so one the user just cancelled reads as cancelled straight away, whatever the API still says.
 */
export const effectiveStatus = (o: CowOrder, cancelled?: Set<string>): string => {
  if (cancelled?.has(o.uid.toLowerCase()) && o.status === 'open') return 'cancelled';
  return o.status === 'open' && o.validTo * 1000 < Date.now() ? 'expired' : o.status;
};

export const orderBucket = (s: string): OrderBucket => {
  const x = s.toLowerCase();
  if (x.includes('cancel')) return 'cancelled';
  if (x.includes('fulfil') || x.includes('filled') || x.includes('expire')) return 'finished';
  return 'open';
};

/** The translation key for the pill label, and its tone; the caller resolves the key with `t`. */
export function statusPill(s: string): {key: string; tone: 'sky' | 'green' | 'gray' | 'amber'} {
  const x = s.toLowerCase();
  // One word for this state across the whole app, and it is "Filled" — the same word the TWAP
  // row's own 3/10 fraction counts in. "Settled" was tried and read as a second, different state
  // sitting beside it.
  if (x.includes('fulfil') || x.includes('filled')) return {key: 'vault.fulfilled', tone: 'green'};
  if (x.includes('cancel')) return {key: 'vault.cancelled', tone: 'gray'};
  if (x.includes('expire')) return {key: 'vault.expired', tone: 'amber'};
  return {key: 'vault.open', tone: 'sky'};
}

/**
 * A timestamp in the APP's language, not the phone's.
 *
 * `toLocaleString(undefined, …)` reads the device locale, so a phone set to English rendered
 * "Oct 5, 3:42 PM" next to a Chinese label however the app's own language was set — and the
 * language picker exists precisely because the two are not the same choice. The locale also
 * decides 12- versus 24-hour, so passing it fixes more than the month name.
 *
 * Defaults to the device locale when no language is given, which is what every caller did
 * before.
 */
export const fmtExpiry = (validTo: number, locale?: string): string =>
  new Date(validTo * 1000).toLocaleString(locale, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

/** One TWAP schedule and the part orders CoW has posted for it so far. */
export type TwapGroup = {
  appData: string;
  schedule: TwapSchedule;
  /** The part the row is drawn from — newest first, so this is the most recent slot. */
  rep: CowOrder;
  parts: CowOrder[];
  filled: number;
  /** From the SCHEDULE, not from the parts present: slots still to be posted count too. */
  total: number;
  openUids: string[];
  bucket: OrderBucket;
};

/**
 * Split a flat order list into the plain orders and one group per TWAP schedule.
 *
 * A part order is identified by its appData matching a schedule the server recorded at placement —
 * CoW has no notion of a TWAP, and the appData is salted per schedule, so nothing else distinguishes
 * a part from an ordinary limit order. A part whose schedule is unknown stays a plain order rather
 * than vanishing.
 */
export function splitTwapGroups(
  orders: CowOrder[],
  twaps: Map<string, TwapSchedule>,
  cancelled?: Set<string>,
): {plain: CowOrder[]; groups: TwapGroup[]} {
  const plain: CowOrder[] = [];
  const byAppData = new Map<string, CowOrder[]>();
  for (const o of orders) {
    const key = o.appData?.toLowerCase();
    if (!key || !twaps.has(key)) {
      plain.push(o);
      continue;
    }
    byAppData.set(key, [...(byAppData.get(key) ?? []), o]);
  }

  const groups: TwapGroup[] = [];
  for (const [appData, parts] of byAppData) {
    const schedule = twaps.get(appData)!;
    const ordered = [...parts].sort((a, b) => b.validTo - a.validTo);
    const st = schedule.status.toLowerCase();
    const total = schedule.parts || parts.length;
    const openUids = parts.filter((p) => effectiveStatus(p, cancelled) === 'open').map((p) => p.uid);
    /**
     * Nothing more can happen to this schedule: every slot has been posted and none is still open.
     *
     * The schedule's own status is the server's, and it is written by the cron that posts the
     * parts — which has no reason to run again once the last one is out, so a TWAP whose final
     * part filled went on calling itself `active` and sat in Open with 10/10 beside it. The parts
     * are the evidence and they are already here, so the client can see the end a poll before the
     * record does.
     *
     * Posted AND none open, not "all filled": a last slot that expired unfilled ends the schedule
     * just as finally, and it would otherwise be stuck in Open for ever.
     */
    const over = ordered.length >= total && openUids.length === 0;
    groups.push({
      appData,
      schedule,
      rep: ordered[0],
      parts: ordered,
      filled: parts.filter((p) => effectiveStatus(p, cancelled).toLowerCase().includes('fulfil')).length,
      total,
      openUids,
      // Cancelled is the server's to say — a cancel invalidates the uids on chain, and the parts
      // alone cannot tell a cancelled slot from an expired one.
      bucket: st.includes('cancel') ? 'cancelled' : over ? 'finished' : st.includes('active') ? 'open' : 'finished',
    });
  }
  return {plain, groups};
}

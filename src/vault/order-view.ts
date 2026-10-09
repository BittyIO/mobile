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

/** What a screen hands these helpers to resolve a key. The same shape `useT` returns. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * How long until something happens, to two units — "in 2d 5h", "in 20m", "due now".
 *
 * A deadline a reader cares about is a distance, not a date. "Expires Oct 9, 4:10 PM" has to be
 * subtracted from today before it means anything, and the thing it means — a day and a half —
 * is what the row was being read for. The absolute time is still right for what has ALREADY
 * happened, where the date is the fact and there is nothing to count down to.
 *
 * Two units rather than one because the round-down lies at the boundary: an order with 1d 23h
 * left reading "in 1d" invites a reader to come back tomorrow and find it gone. The second unit
 * is dropped when it is zero, so a clean figure stays clean.
 */
export function fmtIn(at: number, t: Translate): string {
  return span(at, t, false);
}

/**
 * The same span with no "in" in front of it — "2d 5h", for a line that already has a label.
 *
 * An order's last line reads "Expires · 2d 5h", and "Expires · in 2d 5h" says the preposition
 * twice. The TWAP slot that has no label keeps it, because "2h" alone in the corner of a part
 * row could as easily be how long the slot lasts as how long until it goes out.
 */
export function fmtLeft(at: number, t: Translate): string {
  return span(at, t, true);
}

function span(at: number, t: Translate, bare: boolean): string {
  const K = bare
    ? {m: 'dur_m', h: 'dur_h', d: 'dur_d', dh: 'dur_dh', hm: 'dur_hm'}
    : {m: 'posts_in_m', h: 'posts_in_h', d: 'posts_in_d', dh: 'in_dh', hm: 'in_hm'};
  const key = (k: string) => `mobile.trade.${k}`;
  const secs = at - Math.floor(Date.now() / 1000);
  if (secs <= 30 && !bare) return t('mobile.trade.posts_due');
  const mins = Math.max(1, Math.floor(secs / 60));
  if (mins < 60) return t(key(K.m), {n: mins});
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m ? t(key(K.hm), {h: hours, m}) : t(key(K.h), {n: hours});
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? t(key(K.dh), {d: days, h}) : t(key(K.d), {n: days});
}

/**
 * A time line as the row prints it: a countdown while it is ahead, a date once it is behind.
 *
 * Both screens draw the same line from the same pair, so the choice between the two clocks is
 * made here rather than twice.
 */
export function whenText(line: [string, number], t: Translate, locale?: string): string {
  // "in 2d 5h" rather than the bare span: the row now prints the label and the time as one phrase
  // — "Expires in 2d 5h" — where it used to separate them to opposite ends of the foot and the
  // preposition would have been said twice. See {OrderRow}'s foot.
  return line[0] === 'vault.expires' ? fmtIn(line[1], t) : fmtExpiry(line[1], locale);
}

/**
 * The one time an order row can state, and what to call it — a key and a timestamp, or nothing.
 *
 * A row has room for exactly one date, and which one is a fact depends on how the order ended.
 * An expiry on an order that already filled is the deadline it beat; the same line on a CANCELLED
 * order is worse, because `validTo` there is a deadline that stopped applying the moment it was
 * called off, and printing it as "Expires" claims the order is still waiting for a time in the
 * future. So: when it filled, when it was called off, when it ran out — whichever actually
 * happened, in the past tense once it has.
 *
 * Null when the time is not knowable, and the line is then left out rather than filled with the
 * nearest number to hand. A fill's time comes off the settlement transaction and a cancellation's
 * out of {cancelledAt}, and both can be missing.
 */
export function orderTimeLine(
  o: CowOrder,
  status: string,
  at: {filled?: number; cancelled?: number},
): [string, number] | null {
  const x = status.toLowerCase();
  if (x.includes('fulfil') || x.includes('filled')) return at.filled ? ['vault.fulfilled', at.filled] : null;
  if (x.includes('cancel')) return at.cancelled ? ['vault.cancelled', at.cancelled] : null;
  if (x.includes('expire')) return ['vault.expired', o.validTo];
  return ['vault.expires', o.validTo];
}

/**
 * The same, for a schedule: its window rather than one order's `validTo`.
 *
 * A TWAP that got through every slot is NOT expired — its window closing is the normal end of a
 * finished schedule, and labelling it "Expired" beside a row that already dropped its fraction
 * reads as a failure. That case says nothing at all; a window that closed with slots unposted or
 * unfilled is the one that genuinely expired.
 */
export function twapTimeLine(
  g: TwapGroup,
  at: {cancelled?: number; filled?: number},
): [string, number] | null {
  const end = g.schedule.windowEnd;
  const over = twapEnded(g);
  if (over === 'cancelled') return at.cancelled ? ['vault.cancelled', at.cancelled] : null;
  if (over === 'expired') return ['vault.expired', end];
  /**
   * Got through its slots: the time is when the LAST one landed, not when the window would have
   * closed.
   *
   * A schedule that fills early is done early, and its window end is then a deadline it beat
   * rather than anything that happened — the same reason a filled limit order states its fill and
   * not its `validTo`. Null when no fill time is known, so the line is left out rather than
   * labelled with the nearest number to hand. See {twapFilledAt}.
   */
  if (g.bucket === 'finished') return at.filled ? ['vault.fulfilled', at.filled] : null;
  return end * 1000 > Date.now() ? ['vault.expires', end] : null;
}

/**
 * When the LAST slot of a schedule landed.
 *
 * The maximum rather than the first: the parts are held newest-first for the history panel, and a
 * schedule is finished when its final slice settles, which is the moment the row is reporting.
 *
 * Takes a lookup rather than the map, so this does not have to know how either screen keys its fill
 * times — and both screens key them the same way, by lowercased uid.
 */
export function twapFilledAt(
  g: TwapGroup,
  filledAt: (uid: string) => number | undefined,
): number | undefined {
  let last: number | undefined;
  for (const p of g.parts) {
    const at = filledAt(p.uid.toLowerCase());
    if (at != null && (last == null || at > last)) last = at;
  }
  return last;
}

/**
 * How a SCHEDULE ended, when that is worth naming — the one place that decides it.
 *
 * A TWAP has no status of its own: the server's is written by the cron that posts its parts, and
 * that cron has no reason to run again once it stops, so a schedule can sit at `active` long
 * after it is over. What is true is the window and the slots: called off, or the window closed
 * on slots that never filled.
 *
 * Deliberately NOT keyed on the bucket. A schedule whose window has passed is expired whether or
 * not the bucketing has caught up with it, and the row's pill disagreeing with the row's own date
 * line — one reading the bucket, the other the clock — is exactly the drift this is here to stop.
 *
 * Null for one that got through every slot: its window closing is the normal end of a finished
 * schedule, and "Expired" against a row that already dropped its fraction reads as a failure.
 */
export function twapEnded(g: TwapGroup): 'cancelled' | 'expired' | null {
  if (g.bucket === 'cancelled') return 'cancelled';
  return g.schedule.windowEnd * 1000 < Date.now() && g.filled < g.total ? 'expired' : null;
}

/**
 * When an order was PLACED, in unix seconds — what a record is ordered by.
 *
 * Both lists sorted on `validTo`, which is not a time the order happened: it is a deadline in the
 * FUTURE. So a limit order good for thirty days sorted above everything — above a swap that filled
 * ten minutes ago — and the longer its validity the higher it climbed. A list of what the vault has
 * done is read from the top, and the top has to be the most recent thing done.
 *
 * Placement rather than last activity, on purpose: it does not reshuffle under the reader when a
 * fill lands, and it is the date the row itself prints. `validTo` remains the fallback for an order
 * with no creation date, which is the old behaviour for the one case that cannot do better.
 */
export const placedAt = (o: CowOrder): number =>
  o.creationDate ? Math.floor(Date.parse(o.creationDate) / 1000) || o.validTo : o.validTo;

/**
 * The same for a schedule: when it was set up, not when its window closes.
 *
 * `startTime` is the schedule's own answer and needs no part to have been posted yet, which matters
 * for one placed moments ago — its first slot may not exist, and the window end is days away.
 */
export const twapPlacedAt = (g: TwapGroup): number => g.schedule.startTime || g.schedule.windowEnd;

/**
 * A schedule's verdict, as its row prints it at the foot — one answer, for both lists.
 *
 * It was worked out twice, once per screen, and the two had already drifted: a schedule that got
 * through every slot ended with NOTHING on its foot-left, because {twapEnded} answers only the two
 * ways a schedule comes to a bad end. Which left the most ordinary outcome — it ran, it filled —
 * as the one case with no word for it, on a list where every other finished row says "Filled".
 *
 * A completed schedule says how much of it filled rather than just that it did. "3/3 filled" is
 * the fact a reader wants from a TWAP: it is a plan carried out in slices, and whether every slice
 * landed is the question. The cancelled and expired endings keep their single word — what became of
 * the schedule is the news there, and the slice-by-slice detail is in the parts list underneath.
 *
 * Null while it is still running: such a row states its deadline instead, and the Cancel that
 * belongs to it takes the corner this would have used.
 */
export function twapVerdict(
  g: TwapGroup,
  t: Translate,
): {label: string; tone: 'gray' | 'amber' | 'green'} | null {
  const over = twapEnded(g);
  if (over === 'cancelled') return {label: t('vault.cancelled'), tone: 'gray'};
  if (over === 'expired') return {label: t('vault.expired'), tone: 'amber'};
  if (g.bucket !== 'finished') return null;
  return {label: `${g.filled}/${g.total} ${t('mobile.trade.filled_parts')}`, tone: 'green'};
}

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
    /**
     * ...or the window it had to do it in has passed.
     *
     * A schedule is posted one slot at a time by a cron, and nothing guarantees it got through
     * them all: a TWAP whose window ended with three of ten slots out has `ordered.length < total`
     * for ever, so the first test alone left it sitting in Open with "3/10" beside it and no
     * deadline it could still meet. Once `windowEnd` is behind us no further slot can be posted —
     * CoW would reject it — so the schedule is as over as a full one, and expired is a FINISHED
     * state, not an open one.
     */
    const over = openUids.length === 0 && (ordered.length >= total || schedule.windowEnd * 1000 < Date.now());
    groups.push({
      appData,
      schedule,
      rep: ordered[0],
      parts: ordered,
      filled: parts.filter((p) => effectiveStatus(p, cancelled).toLowerCase().includes('fulfil')).length,
      total,
      openUids,
      /**
       * Cancelled if the SERVER says so, or if any slot does.
       *
       * The server's word alone was not enough. A schedule's status is written by the cron that
       * posts its parts, and cancelling a TWAP does not go through that cron — it invalidates the
       * open uids on chain — so the record went on saying `active` while the thing was over. The
       * slots meanwhile all read cancelled the moment CoW indexed the invalidation, and with none
       * of them open the schedule fell through to `over` and was filed under Finished: a TWAP
       * three fills into ten that the user had called off showed as a schedule that had run its
       * course, with no pill and the wrong date line.
       *
       * One cancelled slot is enough, because a cancel takes every open slot at once — the filled
       * ones stay filled, so a part-filled schedule is exactly the case this gets right.
       */
      bucket:
        st.includes('cancel') || parts.some((p) => effectiveStatus(p, cancelled).toLowerCase().includes('cancel'))
          ? 'cancelled'
          : over
            ? 'finished'
            : st.includes('active')
              ? 'open'
              : 'finished',
    });
  }
  return {plain, groups};
}

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {formatUnits, type Address} from 'viem';
import Svg, {Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {PickerList} from '@/components/AssetPicker';
import {Sheet} from '@/components/Sheet';
import {OrderRow, OrderDetailLines, fmtPrice, type OrderValue} from '@/components/OrderRow';
import {assetMeta, isKnownAsset, underlyingOf} from '@/core/assets';
import {displaySymbol, fmtShort} from '@/core/format';
import {useNetwork} from '@/core/network-store';
import {useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {fetchTrades, type MarketTrade} from '@/vault/market-trades';
import {fetchRecentOrders, type CowOrder} from '@/vault/limit';
import {cancelledAt, cancelledAtAny} from '@/vault/cancel-log';
import {
  effectiveStatus,
  orderTimeLine,
  placedAt,
  twapFilledAt,
  twapPlacedAt,
  twapVerdict,
  whenText,
  twapTimeLine,
  fmtExpiry,
  orderBucket,
  splitTwapGroups,
  statusPill,
  type OrderBucket,
  type TwapGroup,
} from '@/vault/order-view';
import {ownerVaultAddress} from '@/vault/read';
import {fetchTwapSchedules, type TwapSchedule} from '@/vault/twap';
import {useWallet} from '@/wallet/store';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';
import {attemptTrade, useVaultAttempts, type Attempt, type AttemptTrade} from '@/vault/attempts';

/**
 * Every order the vault has placed, on every pair.
 *
 * The Trade tab's own list answers "what is happening to the pair in front of me": it shows Open and
 * Finished, filtered to that pair. This answers the other question — "what have I ever done" — so it
 * drops the pair filter entirely and adds back the Cancelled bucket, which was taking a tab beside
 * the orders a user is actually managing to hold the ones that never happened.
 *
 * Read-only on purpose. Cancelling belongs where the open order is being watched, not in a record of
 * what already happened.
 */

/**
 * One line in the list: a plain order, a TWAP schedule, a completed market swap — or one that
 * failed.
 *
 * The last is a different kind for a reason: every other row here is reconstructed from what moved
 * on chain, and a reverted swap moved nothing. It comes from {usePending}, which is where this
 * device wrote down what it sent, and it is the only kind whose figures are what was ASKED for
 * rather than what happened. See {PendingTrade}.
 */
type Entry =
  | {kind: 'order'; key: string; at: number; bucket: OrderBucket; order: CowOrder}
  | {kind: 'twap'; key: string; at: number; bucket: OrderBucket; group: TwapGroup}
  | {kind: 'market'; key: string; at: number; bucket: 'finished'; trade: MarketTrade}
  | {kind: 'failed'; key: string; at: number; bucket: OrderBucket; tx: Attempt; trade: AttemptTrade};

/** What kind of order a row is — the only filter this page keeps besides the asset. */
type TypeFilter = 'all' | 'limit' | 'market' | 'twap';
/** The entry kinds behind each type filter — `order` is a plain limit order. */
/**
 * The entry kinds behind each type filter — `order` is a plain limit order.
 *
 * A failed swap files under Market, because that is what it was. Giving failure its own filter
 * would ask the user to know an order had failed before they could go looking for it.
 */
const TYPE_OF: Record<Exclude<TypeFilter, 'all'>, Entry['kind'][]> = {
  limit: ['order'],
  market: ['market', 'failed'],
  twap: ['twap'],
};

/** How an order ended. Ordered by how often one is looked for, with the catch-all first. */
type StatusFilter = 'all' | 'filled' | 'open' | 'cancelled' | 'expired' | 'failed';
const STATUS_FILTERS: {key: StatusFilter; label: string}[] = [
  {key: 'all', label: 'vault.all'},
  {key: 'filled', label: 'vault.fulfilled'},
  {key: 'open', label: 'vault.open'},
  {key: 'cancelled', label: 'vault.cancelled'},
  {key: 'expired', label: 'vault.expired'},
  // Last, because it is the rarest — and present at all because without it there was no way to
  // ASK for the failures: Filled, Open, Cancelled and Expired are all things that happened to a
  // live order, and a trade the relayer refused was never one.
  {key: 'failed', label: 'vault.failed'},
];

export function OrderHistoryScreen() {
  const {t, words, language} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const catalog = useAssetCatalog(network);
  const stables = useMemo(() => catalog.filter((a) => a.kind === 'stable'), [catalog]);

  // One nonce drives every feed on this page, the attempts included, so a pull refreshes all of
  // them together rather than leaving one list a read behind the others.
  const [nonce, setNonce] = useState(0);
  const [orders, setOrders] = useState<CowOrder[]>([]);
  const [trades, setTrades] = useState<MarketTrade[]>([]);
  /**
   * Every market swap the relayer was asked for and did not complete — from the SERVER.
   *
   * Pending ones included, deliberately. A record that starts at "failed" only exists once
   * something has gone wrong, which leaves an attempt whose verdict has not arrived yet
   * indistinguishable from one that was never made. Confirmed ones are left out because they are
   * not missing: they arrive in the ordinary feed as a real swap, with the amounts that actually
   * moved rather than the ones that were asked for.
   *
   * Only the ones carrying a swap. The same table records deposits and cancels, which have no
   * business in a list of orders — the transaction history is where those belong.
   */
  const {attempts: relayed} = useVaultAttempts(vault, network, nonce);
  const attempts = useMemo(
    () =>
      relayed
        .filter((a) => a.status !== 'confirmed')
        .map((a) => ({a, trade: attemptTrade(a, network)}))
        .filter((x) => !!x.trade),
    [relayed, network],
  );
  const [fillAt, setFillAt] = useState<Map<string, number>>(() => new Map());
  const [cancelAt, setCancelAt] = useState<Map<string, number>>(() => new Map());
  const [twaps, setTwaps] = useState<Map<string, TwapSchedule>>(() => new Map());
  const [loading, setLoading] = useState(false);
  /**
   * Has a read ever finished? Three states, not two.
   *
   * With only `loading`, an empty list and a list that has not arrived yet look identical, and the
   * page greeted every arrival with "No orders yet" — a statement about the vault, made before
   * anything had been asked of it. `loaded` is what separates "nothing here" from "not here yet".
   */
  const [loaded, setLoaded] = useState(false);
  /**
   * A pull, as opposed to the first load.
   *
   * The pull spinner belongs to a pull. Driving `RefreshControl` straight from `loading` made the
   * control snap open by itself on entry, which reads as the user having gestured.
   */
  const [pulled, setPulled] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  /**
   * How an order ENDED, which is the other question a record is read with.
   *
   * Not a fifth kind beside Market/Limit/TWAP: those ask what an order IS, this asks how it turned
   * out, and the two compose — Limit + Expired is the limit orders that ran out.
   *
   * Everything, to begin with.
   *
   * It opened on Filled, which reads as a sensible default — most of what anyone looks for here
   * did trade — and quietly made the page unable to answer its most urgent question. A trade that
   * FAILED is not filled, so the one row the owner had come to find was the one the default hid,
   * and nothing on screen said a filter was even on.
   */
  const [status, setStatus] = useState<StatusFilter>('all');
  /**
   * Which asset the list is about. 'all' is every one.
   *
   * Seeded from the pair the user came from, because that is what they were looking at a moment
   * ago: opening the record of a CRCL position onto a list led by last week's ETH orders is a
   * page about somebody else's day. It is a filter and not a lock — the chip beside the
   * categories changes it, and 'all' is the first entry.
   */
  const route = useRoute<RouteProp<RootStackParamList, 'OrderHistory'>>();
  const [asset, setAsset] = useState<string>(route.params?.symbol ?? 'all');
  const [filterOpen, setFilterOpen] = useState(false);
  /**
   * What the SHEET is showing, as against what the list is drawn from.
   *
   * Applying each tap straight through redrew the page under the sheet while the user was still
   * choosing: rows vanished behind the card, the scroll jumped to fit a shorter list, and by the
   * time the sheet came down it had been rearranged three times by choices that were only being
   * tried out. So the sheet edits a copy, and the list is rebuilt once, when the sheet closes —
   * which is the moment the user has said they are finished, by Done or by tapping the page.
   */
  const [draftStatus, setDraftStatus] = useState<StatusFilter>(status);
  const [draftAsset, setDraftAsset] = useState(asset);
  const openFilter = () => {
    setDraftStatus(status);
    setDraftAsset(asset);
    setFilterOpen(true);
  };
  const applyFilter = () => {
    setStatus(draftStatus);
    setAsset(draftAsset);
    setFilterOpen(false);
  };
  /** The TWAP whose terms are open, as the lines to draw — see {HistoryRow}'s `onDetails`. */
  const [details, setDetails] = useState<[string, OrderValue][] | null>(null);

  useEffect(() => {
    if (!vault) return;
    let live = true;
    setLoading(true);
    Promise.all([
      fetchRecentOrders(vault, network).catch(() => [] as CowOrder[]),
      // The swaps AND the fill times: a filled order says when it filled here too, which it could
      // not while this screen read the feed without them. See {fetchTrades}.
      fetchTrades(vault, network).catch(() => ({
        trades: [] as MarketTrade[],
        fillAt: new Map<string, number>(),
        cancelAt: new Map<string, number>(),
      })),
      fetchTwapSchedules(vault, network).catch(() => [] as TwapSchedule[]),
    ])
      .then(([o, feed, sched]) => {
        if (!live) return;
        setOrders(o);
        setTrades(feed.trades);
        setFillAt(feed.fillAt);
        setCancelAt(feed.cancelAt);
        setTwaps(new Map(sched.map((r) => [r.appData.toLowerCase(), r])));
      })
      .finally(() => {
        if (!live) return;
        setLoading(false);
        setLoaded(true);
        setPulled(false);
      });
    return () => {
      live = false;
    };
  }, [vault, network, nonce]);

  const onRefresh = useCallback(() => {
    setPulled(true);
    setNonce((n) => n + 1);
  }, []);

  /**
   * Newest first, across all three kinds.
   *
   * Everything here is ordered by when it was PLACED — see {placedAt}. It used to be an order's
   * `validTo`, which is a deadline rather than an event, so a limit order good for a month sat
   * above a swap that filled minutes ago. A market swap's placement and its execution are the same
   * moment, so its block stands in for both.
   */
  const entries = useMemo<Entry[]>(() => {
    const named = orders.filter((o) => isKnownAsset(network, o.sellToken) && isKnownAsset(network, o.buyToken));
    const {plain, groups} = splitTwapGroups(named, twaps);
    const out: Entry[] = [
      ...plain.map((o): Entry => ({
        kind: 'order',
        key: o.uid,
        at: placedAt(o),
        bucket: orderBucket(effectiveStatus(o)),
        order: o,
      })),
      ...groups.map((g): Entry => ({kind: 'twap', key: `twap-${g.appData}`, at: twapPlacedAt(g), bucket: g.bucket, group: g})),
      ...trades.map((m): Entry => ({kind: 'market', key: `mkt-${m.txHash}`, at: m.ts ?? m.blockNum, bucket: 'finished', trade: m})),
      /**
       * The swaps this device attempted — see {attempts}.
       *
       * Sorted in by the time it was SUBMITTED, which is the only time one has: a transaction that
       * reverted has no fill, and one still in flight has no outcome at all. An attempt in flight
       * is `open` and a settled one is `finished`; neither is cancelled, because nobody stopped it.
       */
      ...attempts.map(({a, trade}): Entry => ({
        kind: 'failed',
        key: `relay-${a.id}`,
        at: a.at,
        bucket: a.status === 'submitted' ? 'open' : 'finished',
        tx: a,
        trade: trade as AttemptTrade,
      })),
    ];
    return out.sort((a, b) => b.at - a.at);
  }, [orders, trades, twaps, attempts, network]);

  /**
   * The assets an entry is about — one leg each side, as the user would name them.
   *
   * Compared on the DISPLAYED symbol so ETH matches the WETH the order was actually written in,
   * and a leg held as a receipt token answers with what it stands for: a limit order selling
   * sUSDS belongs to the USDC the owner thinks they hold, not to a share class they never chose.
   */
  const legsOf = useCallback(
    (e: Entry): string[] => {
      const name = (addr: string) => displaySymbol(underlyingOf(network, addr) ?? assetMeta(network, addr as Address).symbol);
      if (e.kind === 'market') return [displaySymbol(e.trade.sold.symbol), displaySymbol(e.trade.bought.symbol)];
      /**
       * A failure carries the symbols it was asked for, not addresses: nothing moved, so there is
       * no transfer to read a token out of.
       *
       * With no legs at all it names no asset, and the asset filter treats that as "matches
       * anything" rather than "matches nothing" — a row whose asset is unknown must not be hidden
       * by a question it cannot answer, least of all by the filter the page pre-sets from the pair
       * the user happened to come from.
       */
      if (e.kind === 'failed')
        return [displaySymbol(e.trade.sold.symbol), displaySymbol(e.trade.bought.symbol)];
      const o = e.kind === 'twap' ? e.group.rep : e.order;
      return [name(o.sellToken), name(o.buyToken)];
    },
    [network],
  );

  /**
   * Every asset the record actually mentions, for the filter sheet's list. Nothing else is worth
   * offering — plus whatever is currently chosen, applied or merely picked, so that selecting one
   * and then narrowing by kind cannot make the row you are standing on disappear under you.
   */
  const assetsSeen = useMemo(() => {
    const seen = new Set<string>();
    for (const e of entries) for (const sym of legsOf(e)) seen.add(sym);
    for (const a of [asset, draftAsset]) if (a !== 'all') seen.add(displaySymbol(a));
    return [...seen].sort();
  }, [entries, legsOf, asset, draftAsset]);

  /**
   * Did anything actually trade? Executed amounts, not status.
   *
   * A PARTIAL fill is a fill: a limit order that got half away is still open and a TWAP three
   * slots into ten is still running, and both have a trade in them that the check is there to
   * show. Reading the status instead would have called those two untraded and hidden them with
   * the orders that never went anywhere.
   */
  const traded = useCallback((e: Entry): boolean => {
    if (e.kind === 'market') return true;
    // Nothing traded, which is the whole point of the row: an attempt that reverted executed no
    // amount, and one still in flight has executed nothing yet either.
    if (e.kind === 'failed') return false;
    const anyFill = (o: CowOrder) => BigInt(o.executedSellAmount ?? '0') > 0n || BigInt(o.executedBuyAmount ?? '0') > 0n;
    return e.kind === 'twap' ? e.group.parts.some(anyFill) : anyFill(e.order);
  }, []);

  /**
   * How an entry ended, against what the filter asks for.
   *
   * Filled is the one that OVERLAPS the others: a partially filled order is still open until it
   * expires, and a TWAP cancelled three slots in traded three times. Both answer yes to Filled
   * and yes to their own state, which is right — they are both things, and a reader asking "what
   * traded" wants them as much as a reader asking "what did I call off" does.
   *
   * A market swap is only ever filled; it has no other way to end. One that FAILED is none of
   * these — see below.
   */
  const matchesStatus = useCallback(
    (e: Entry): boolean => {
      if (status === 'all') return true;
      // An attempt still in flight is OPEN, not failed: it has not come to anything yet, and
      // filing it under Failed would announce an outcome the device does not have.
      if (e.kind === 'failed') return status === (e.tx.status === 'submitted' ? 'open' : 'failed');
      if (status === 'failed') return false;
      if (status === 'filled') return traded(e);
      if (e.kind === 'market') return false;
      if (e.kind === 'twap') {
        if (status === 'cancelled') return e.group.bucket === 'cancelled';
        if (status === 'open') return e.group.bucket === 'open';
        // Expired: the window closed on a schedule that never got through its slots. One that
        // did is finished, not expired — see {twapTimeLine}.
        return e.group.bucket === 'finished' && e.group.filled < e.group.total;
      }
      const es = effectiveStatus(e.order).toLowerCase();
      if (status === 'cancelled') return es.includes('cancel');
      if (status === 'expired') return es.includes('expire');
      return es === 'open';
    },
    [status, traded],
  );

  /** Whether the icon should say so: any cut that hides rows the page would otherwise show. */
  const filtering = typeFilter !== 'all' || asset !== 'all' || status !== 'all';

  const shown = useMemo(
    () =>
      entries.filter(
        (e) =>
          (typeFilter === 'all' || TYPE_OF[typeFilter].includes(e.kind)) &&
          (asset === 'all' || legsOf(e).length === 0 || legsOf(e).includes(displaySymbol(asset))) &&
          matchesStatus(e),
      ),
    [entries, typeFilter, asset, legsOf, matchesStatus],
  );

  const TYPE_FILTERS: {key: TypeFilter; label: string}[] = [
    {key: 'all', label: t('vault.all')},
    {key: 'market', label: t('vault.market')},
    {key: 'limit', label: t('vault.limit')},
    {key: 'twap', label: t('vault.twap')},
  ];

  const isStable = (addr: string) => stables.some((st) => st.address.toLowerCase() === addr.toLowerCase());
  const sideWord = (buy: boolean) => t(buy ? 'mobile.trade.buy_short' : 'mobile.trade.sell_short');

  /** The badge, the one-line summary, the right-hand mark and the details, per kind. */
  const row = (e: Entry) => {
    if (e.kind === 'market') {
      const buy = isStable(e.trade.sold.address);
      return (
        <OrderRow
          standalone
          key={e.key}
          badge={words(t('vault.market'), sideWord(buy))}
          leg={
            buy
              ? {amount: fmtShort(e.trade.bought.amount), symbol: e.trade.bought.symbol}
              : {amount: fmtShort(e.trade.sold.amount), symbol: e.trade.sold.symbol}
          }
          price={fmtPrice(buy ? e.trade.sold.amount / e.trade.bought.amount : e.trade.bought.amount / e.trade.sold.amount)}
          // Nothing on the right: a completed swap has no state worth a pill of its own, and the
          // Trade tab's finished rows give that corner to the amount. See {HistoryRow}.
          right={null}
          /**
           * The OTHER leg, the price, and when — the shape the Trade tab's expanded order uses.
           *
           * The row above already names the leg the trade was FOR, so printing both here made the
           * first line of the panel a copy of the line above it, and left the price — the figure
           * a reader is actually comparing between rows — written nowhere.
           */
          lines={[
            buy
              ? [t('mobile.trade.paid'), {amount: fmtShort(e.trade.sold.amount), symbol: e.trade.sold.symbol}]
              : [t('vault.received'), {amount: fmtShort(e.trade.bought.amount), symbol: e.trade.bought.symbol}],
          ]}
          /* A swap has one ending and it already happened. */
          outcome={{label: t('vault.fulfilled'), tone: 'green'}}
          outcomeAt={e.trade.ts ? fmtExpiry(e.trade.ts, language) : undefined}
        />
      );
    }
    if (e.kind === 'failed') {
      const tr = e.trade;
      const leg = tr.buy ? tr.bought : tr.sold;
      const buy = tr.buy;
      return (
        <OrderRow
          standalone
          key={e.key}
          // Badged Market, like the swap it was trying to be: what it was does not change
          // because of how it ended, and the ending has its own line at the foot. With no legs
          // the side is unknown too, so the badge drops it rather than guessing.
          badge={words(t('vault.market'), sideWord(buy))}
          leg={{amount: fmtShort(leg.amount), symbol: leg.symbol}}
          /**
           * The price it was ASKED at, and marked as such by the row around it.
           *
           * Every other row's price is what it got. This one never got anything, so the figure is
           * the quote the swap was sent with — worth printing, because it is what the user was
           * looking at when they pressed the button, and worth not pretending is a fill.
           */
          price={
            tr.sold.amount > 0 && tr.bought.amount > 0
              ? fmtPrice(tr.buy ? tr.sold.amount / tr.bought.amount : tr.bought.amount / tr.sold.amount)
              : undefined
          }
          right={null}
          /**
           * Pay / Receive where the legs are known.
           *
           * With no legs there is nothing to split into two sides, so the panel carries the
           * reason instead — which for a refusal is the only place it exists, and is what
           * someone opening a failed row came to find.
           */
          lines={[
            tr.buy
              ? [t('vault.pay'), {amount: fmtShort(tr.sold.amount), symbol: tr.sold.symbol}]
              : [t('vault.receive'), {amount: fmtShort(tr.bought.amount), symbol: tr.bought.symbol}],
            // Why, where the relayer said why. For a refusal this is the only account of it: there
            // is no receipt to go and read, because nothing was ever sent.
            ...(e.tx.reason ? [[t('vault.status'), e.tx.reason] as [string, string]] : []),
          ]}
          /**
           * Three states, three words, and the colour says which kind of news it is.
           *
           * In flight has no verdict yet and must not borrow one. Past that: `failed` means the
           * chain ran it and reverted; `refused` means the relayer turned it down before signing,
           * so nothing happened at all. The owner's next move differs — a refusal says fix the
           * condition and try again, a revert says the operation itself was rejected — which is
           * why they do not share a word.
           */
          outcome={
            e.tx.status === 'submitted'
              ? {label: t('mobile.app.submitting'), tone: 'sky' as const}
              : {
                  label: t(e.tx.status === 'refused' ? 'vault.tx_not_included' : 'vault.failed'),
                  tone: 'rose' as const,
                }
          }
          outcomeAt={fmtExpiry(e.tx.at, language)}
        />
      );
    }
    const o = e.kind === 'twap' ? e.group.rep : e.order;
    const sellM = assetMeta(network, o.sellToken as Address);
    const buyM = assetMeta(network, o.buyToken as Address);
    const buy = isStable(o.sellToken);
    const mult = e.kind === 'twap' ? e.group.total : 1;
    const sell = Number(formatUnits(BigInt(o.sellAmount), sellM.decimals)) * mult;
    const recv = Number(formatUnits(BigInt(o.buyAmount), buyM.decimals)) * mult;
    const st = e.kind === 'twap' ? null : statusPill(effectiveStatus(o));
    /** Fully filled — a partial one has paid SOME of the figure these lines print, not all of it. */
    const done = st?.key === 'vault.fulfilled';
    /**
     * A TWAP says what it DID once it is over, exactly as the Trade tab's row does.
     *
     * Its schedule's full size is a plan, and a schedule can end cancelled or expired with two
     * slots of ten behind it — a row reading the whole amount claims a trade that never
     * happened. So a finished one adds up the parts that settled, on the leg it names, and
     * carries the average they went at. A running one still states what it is for.
     */
    const parts = e.kind === 'twap' ? e.group.parts : [];
    const exec = (pt: CowOrder, which: 'sell' | 'buy') =>
      Number(
        formatUnits(
          BigInt((which === 'sell' ? pt.executedSellAmount : pt.executedBuyAmount) ?? '0'),
          (which === 'sell' ? sellM : buyM).decimals,
        ),
      );
    const settledBase = parts.reduce((n, pt) => n + exec(pt, buy ? 'buy' : 'sell'), 0);
    const settledQuote = parts.reduce((n, pt) => n + exec(pt, buy ? 'sell' : 'buy'), 0);
    const over = e.kind === 'twap' && e.group.bucket === 'finished';
    const shown = over && settledBase > 0 ? settledBase : buy ? recv : sell;
    /**
     * Every row carries a price: what it GOT if it filled, what it ASKED if it has not.
     *
     * Showing it only on fills left the open and expired rows — most of this record — with a
     * blank where the number people scan the column for goes. The two are different claims and
     * the row says which by what else is on it: an amber pill or a part count means the price
     * beside it is the one that was wanted.
     */
    const limitPx = fmtPrice(buy ? sell / recv : recv / sell);
    const executed =
      e.kind === 'twap'
        ? settledBase > 0
          ? fmtPrice(settledQuote / settledBase)
          : null
        : (() => {
            const es = Number(formatUnits(BigInt(o.executedSellAmount ?? '0'), sellM.decimals));
            const eb = Number(formatUnits(BigInt(o.executedBuyAmount ?? '0'), buyM.decimals));
            return es > 0 && eb > 0 ? fmtPrice(buy ? es / eb : eb / es) : null;
          })();
    const avg = executed ?? limitPx;
    /** Filled, cancelled or expired — whichever actually happened. See {orderTimeLine}. */
    const when =
      e.kind === 'twap'
        ? twapTimeLine(e.group, {
            cancelled:
              e.group.parts.reduce<number | undefined>((at, pt) => at ?? cancelAt.get(pt.uid.toLowerCase()), undefined) ??
              cancelledAtAny(e.group.parts.map((pt) => pt.uid)),
            // When the last slot landed — the time a completed schedule reports.
            filled: twapFilledAt(e.group, (uid) => fillAt.get(uid)),
          })
        : orderTimeLine(o, effectiveStatus(o), {
            filled: fillAt.get(o.uid.toLowerCase()),
            // The chain's answer first; this device's own log only covers its own cancels.
            cancelled: cancelAt.get(o.uid.toLowerCase()) ?? cancelledAt(o.uid),
          });
    /**
     * The terms, as the Trade tab states them.
     *
     * A limit order's panel is printed under the row, so it shows the leg the row does NOT name —
     * printing both would make its first line a copy of the line above it. A TWAP's go in a
     * sheet, which is opened FOR the terms, so that one spells out both ends of the schedule.
     */
    const detailLines: [string, OrderValue][] =
      e.kind === 'twap'
        ? [
            [t('vault.pay'), {amount: fmtShort(sell), symbol: sellM.symbol}],
            [t('vault.receive'), {amount: fmtShort(recv), symbol: buyM.symbol}],
            // What one slot buys, so the fraction on the row has a size attached to it.
            [t('mobile.trade.per_part'), {amount: fmtShort(sell / e.group.total), symbol: sellM.symbol}],
            [
              t('mobile.trade.parts_history'),
              t('mobile.trade.parts_posted', {posted: e.group.parts.length, total: e.group.total}),
            ],
            ...(when ? ([[t(when[0]), whenText(when, t, language)]] as [string, OrderValue][]) : []),
          ]
        : [
            // Past tense once it happened — see the Trade tab's rows.
            buy
              ? [t(done ? 'mobile.trade.paid' : 'vault.pay'), {amount: fmtShort(sell), symbol: sellM.symbol}]
              : [t(done ? 'vault.received' : 'vault.receive'), {amount: fmtShort(recv), symbol: buyM.symbol}],
          ];
    return (
      <OrderRow
        standalone
        key={e.key}
        badge={words(t(e.kind === 'twap' ? 'vault.twap' : 'vault.limit'), sideWord(buy))}

        leg={{amount: fmtShort(shown), symbol: buy ? buyM.symbol : sellM.symbol}}
        price={avg}
        /** As above: the leg the row does not name, the price it was placed at, and the window. */
        // One line per posted slot: what it got, and what it went at. The Trade panel leads with
        // these for the same reason — a schedule is read by how far along it is.
        parts={parts.map((pt) => {
          const got = exec(pt, buy ? 'buy' : 'sell');
          const paid = exec(pt, buy ? 'sell' : 'buy');
          const at = got > 0 ? fmtPrice(paid / got) : null;
          const size = got > 0 ? got : Number(formatUnits(BigInt(buy ? pt.buyAmount : pt.sellAmount), (buy ? buyM : sellM).decimals));
          return {
            label: `${fmtShort(size)} ${displaySymbol(buy ? buyM.symbol : sellM.symbol)}${at ? ` @${at}` : ''}`,
            state: t(statusPill(effectiveStatus(pt)).key),
          };
        })}
        /**
         * What became of it, at the foot — the Trade tab's rule exactly.
         *
         * A schedule has no status of its own, so it is read off the bucket and the parts — in
         * {twapVerdict}, which both lists share, rather than worked out here and again there. An
         * order still working states its deadline rather than a verdict. See {OrderRow}'s
         * `outcome`.
         */
        outcome={
          e.kind === 'twap'
            ? (twapVerdict(e.group, t) ?? undefined)
            : !st
              ? undefined
              : st.key === 'vault.open'
                ? when
                  ? {label: t(when[0])}
                  : undefined
                : {label: t(st.key), tone: st.tone}
        }
        outcomeAt={when ? whenText(when, t, language) : undefined}
        onDetails={e.kind === 'twap' ? () => setDetails(detailLines) : undefined}
        lines={detailLines}
      />
    );
  };

  return (
    <ScrollView
      style={styles.container}
      // A PUSHED screen, so the header inset is the system's to apply: this is the only thing it
      // needs, and `contentInsetAdjustmentBehavior` is what the stack's own options say pages use.
      // Adding `headerHeight` on top of it, the way a TAB screen has to, padded the page twice and
      // left the filter row sitting a header's height below where it belongs.
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={pulled && loading} onRefresh={onRefresh} tintColor={c.text} colors={[c.accent]} />}>
      {/**
        * One row: what kind of order, and which asset.
        *
        * The kinds lead because that is what a record of orders is browsed by, with "All" first
        * so there is a way back to the whole list. The status chip that used to open this row is
        * gone: this page exists to show everything the vault has ever placed, the state is
        * already written on every row, and a second filter in front of the one people actually
        * use made the simple case a two-step.
        *
        * No counts on the labels. A count beside a filter has to be computed against the OTHER
        * filter's selection to be true, and the pair of them changing as you tap was more to read
        * than the one number anybody wanted.
        */}
      {/**
        * Scrollable, because the strip outgrew the screen.
        *
        * Four kinds, a checkbox and an asset is more than 390pt of phone holds at this size, and
        * the alternatives were worse: shrinking the type closes the gap between a filter strip and
        * a caption, and wrapping to a second line turns one band of chrome into two above a list
        * that is the point of the page. `flexGrow` on the content keeps the asset chip's
        * `marginLeft: auto` working — pinned to the right edge while everything fits, and simply
        * last in the row once it does not.
        */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabs}>
        {TYPE_FILTERS.map((f) => (
          <Pressable key={f.key} style={styles.catTab} onPress={() => setTypeFilter(f.key)} hitSlop={6}>
            <Text style={[styles.cat, typeFilter === f.key && styles.catOn]}>{f.label}</Text>
          </Pressable>
        ))}
        {/**
          * The cuts that are not kinds, behind one control at the far end.
          *
          * Status and asset are both "which of these rows", not "what are they", and spelling
          * either out in the strip cost it more width than a phone has: four kinds, a word for
          * the status and an asset name ran off the right of the screen. An icon says there is
          * more filtering here without claiming a share of the row, and it carries its own state
          * — accent while anything is narrowing the list, so a short list is never a mystery.
          */}
        <Pressable style={styles.filterBtn} onPress={openFilter} hitSlop={10} accessibilityRole="button">
          <Svg width={20} height={20} viewBox="0 0 24 24">
            <Path
              d="M3 5h18M6 12h12M10 19h4"
              stroke={filtering ? c.accent : c.subtext}
              strokeWidth={2}
              strokeLinecap="round"
              fill="none"
            />
          </Svg>
        </Pressable>
      </ScrollView>
      {/* The first load spins HERE, where the list will be — the pull control is for a pull. A
          refresh after that leaves the rows up and spins in the control instead, so the page does
          not blank out what the user is reading. */}
      {/* One card per order, as the transaction feed does it.
          They were cells of a single card — the Trade panel's arrangement, which is right there
          because it sits under a chart and has to pack tight. Read down a page of records the
          hairlines were not enough: a three-line TWAP ran into the row beneath it. Here each
          record is its own object and the gap between them does the separating. */}
      {!loaded ? (
        <View style={styles.card}>
          <ActivityIndicator color={c.accent} style={styles.spinner} />
        </View>
      ) : shown.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.empty}>{t('mobile.trade.no_orders')}</Text>
        </View>
      ) : (
        shown.map((e) => (
          <View key={e.key} style={styles.rowCard}>
            {row(e)}
          </View>
        ))
      )}

      {/* A schedule's terms, the way the Trade tab shows them: a tap away, not under every row. */}
      <Sheet visible={details != null} title={t('mobile.trade.details')} onClose={() => setDetails(null)} height={420}>
        <OrderDetailLines lines={details ?? []} />
      </Sheet>

      {/**
        * Two questions, one sheet, and it stays up between them.
        *
        * A picker that closes on the answer is right when there is one answer; here the user is
        * setting a view, and having the sheet vanish after the first choice so the second needs a
        * second trip made a two-field form into two errands. So the rows select in place and the sheet
        * goes when the user says it does — Done, or a tap on the page behind it. Both mean the
        * same thing and both commit, which is why there is no Cancel beside Done: the way out
        * without choosing is to put back what was there and close.
        */}
      <Sheet visible={filterOpen} title={t('mobile.trade.filter')} onClose={applyFilter} done>
        <ScrollView showsVerticalScrollIndicator={false} bounces={false} contentContainerStyle={styles.filterBody}>
          {/* Asset first, status second — the order the question is actually asked in.
              Someone opening this sheet is nearly always after one asset's record; how it ended is
              the cut they make once they are looking at it. Status led, which put the broad filter
              above the narrow one and meant the list under the sheet barely changed until they had
              scrolled past it. It is also the half the page pre-sets from the pair they arrived
              from, so it is the row most likely to need correcting. */}
          <Text style={styles.group}>{t('vault.asset')}</Text>
          <PickerList
            items={[
              {key: 'all', label: t('mobile.trade.all_assets')},
              ...assetsSeen.map((sym) => ({key: sym, label: sym, icon: <TokenIcon symbol={sym} size={30} />})),
            ]}
            selected={draftAsset === 'all' ? 'all' : displaySymbol(draftAsset)}
            onSelect={setDraftAsset}
          />
          <Text style={styles.group}>{t('vault.status')}</Text>
          <PickerList
            items={STATUS_FILTERS.map((f) => ({key: f.key, label: t(f.label)}))}
            selected={draftStatus}
            onSelect={(k) => setDraftStatus(k as StatusFilter)}
          />
        </ScrollView>
      </Sheet>

    </ScrollView>
  );
}

/**
 * One entry, open.
 *
 * Nothing here collapses. On the Trade tab a row folds shut because the list sits under a chart and
 * a form and has to earn its height; this page is the record and nothing else, so hiding what the
 * user came to read behind a tap per row only made them tap every row.
 */
const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 12, paddingBottom: 32},
    // The Market directory's own category metrics, so the two rows read as the same control.
    tabs: {flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 4, flexGrow: 1},
    catTab: {paddingVertical: 6},
    // Pushed to the far end of the row; the gap before it is the auto margin, not the row's gap.
    filterBtn: {paddingVertical: 6, paddingLeft: 12, marginLeft: 'auto'},
    filterBody: {gap: 8, paddingBottom: 8},
    // A heading for a card of rows, not a section of the page: one step down from the sheet title.
    group: {color: c.subtext, fontSize: 13, fontWeight: '600', paddingHorizontal: 4, paddingTop: 8},
    cat: {color: c.subtext, fontSize: 15, fontWeight: '600'},
    catOn: {color: c.text, fontWeight: '700'},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    // One record's own card. The vertical padding is the row's; this supplies the horizontal, since
    // a standalone row no longer bleeds past its parent to draw a divider. See {standalone}.
    rowCard: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 18},
    // The icon travels with the leg, so the row says WHICH asset before it says how much of it.
    // Regular weight inside a semibold line: the amount is the subject, the price is the aside.
    empty: {color: c.subtext, fontSize: 13, textAlign: 'center', paddingVertical: 36},
    // The same height the empty line occupies, so the card does not resize as the list arrives.
    spinner: {paddingVertical: 36},
  });

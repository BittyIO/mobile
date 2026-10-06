import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {formatUnits, type Address} from 'viem';
import {Amount} from '@/components/Amount';
import {TokenIcon} from '@/components/TokenIcon';
import {Pill} from '@/components/ui';
import {PickerSheet} from '@/components/AssetPicker';
import Svg, {Path} from 'react-native-svg';
import {assetMeta, isKnownAsset} from '@/core/assets';
import {displaySymbol, fmtShort} from '@/core/format';
import {useNetwork} from '@/core/network-store';
import {fetchMarketTrades, type MarketTrade} from '@/vault/market-trades';
import {fetchRecentOrders, type CowOrder} from '@/vault/limit';
import {
  effectiveStatus,
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

/** One line in the list: a plain order, a TWAP schedule, or a completed market swap. */
type Entry =
  | {kind: 'order'; key: string; at: number; bucket: OrderBucket; order: CowOrder}
  | {kind: 'twap'; key: string; at: number; bucket: OrderBucket; group: TwapGroup}
  | {kind: 'market'; key: string; at: number; bucket: 'finished'; trade: MarketTrade};

/** Two independent questions, so two rows of filters: what state is it in, and what kind is it. */
type Filter = 'all' | OrderBucket;
type TypeFilter = 'all' | 'limit' | 'market' | 'twap';
/** The entry kinds behind each type filter — `order` is a plain limit order. */
const TYPE_OF: Record<Exclude<TypeFilter, 'all'>, Entry['kind']> = {limit: 'order', market: 'market', twap: 'twap'};

export function OrderHistoryScreen() {
  const {t, words, language} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const catalog = useAssetCatalog(network);
  const stables = useMemo(() => catalog.filter((a) => a.kind === 'stable'), [catalog]);

  const [orders, setOrders] = useState<CowOrder[]>([]);
  const [trades, setTrades] = useState<MarketTrade[]>([]);
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
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusOpen, setStatusOpen] = useState(false);

  useEffect(() => {
    if (!vault) return;
    let live = true;
    setLoading(true);
    Promise.all([
      fetchRecentOrders(vault, network).catch(() => [] as CowOrder[]),
      fetchMarketTrades(vault, network).catch(() => [] as MarketTrade[]),
      fetchTwapSchedules(vault, network).catch(() => [] as TwapSchedule[]),
    ])
      .then(([o, m, sched]) => {
        if (!live) return;
        setOrders(o);
        setTrades(m);
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
   * An order's own clock is its `validTo` and a swap's is the block it settled in, which are not the
   * same measure — but both increase with time, which is all an ordering needs, and mixing them is
   * what lets one list answer "what did I do, most recent first".
   */
  const entries = useMemo<Entry[]>(() => {
    const named = orders.filter((o) => isKnownAsset(network, o.sellToken) && isKnownAsset(network, o.buyToken));
    const {plain, groups} = splitTwapGroups(named, twaps);
    const out: Entry[] = [
      ...plain.map((o): Entry => ({
        kind: 'order',
        key: o.uid,
        at: o.validTo,
        bucket: orderBucket(effectiveStatus(o)),
        order: o,
      })),
      ...groups.map((g): Entry => ({kind: 'twap', key: `twap-${g.appData}`, at: g.schedule.windowEnd, bucket: g.bucket, group: g})),
      ...trades.map((m): Entry => ({kind: 'market', key: `mkt-${m.txHash}`, at: m.ts ?? m.blockNum, bucket: 'finished', trade: m})),
    ];
    return out.sort((a, b) => b.at - a.at);
  }, [orders, trades, twaps, network]);

  const shown = useMemo(
    () =>
      entries.filter(
        (e) => (typeFilter === 'all' || e.kind === TYPE_OF[typeFilter]) && (filter === 'all' || e.bucket === filter),
      ),
    [entries, typeFilter, filter],
  );

  const STATUS_LABEL: Record<Filter, string> = {
    all: t('vault.all'),
    open: t('vault.orders_open_short'),
    finished: t('vault.orders_finished_short'),
    cancelled: t('vault.orders_cancelled_short'),
  };
  const TYPE_FILTERS: {key: Exclude<TypeFilter, 'all'>; label: string}[] = [
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
        <HistoryRow
          key={e.key}
          buy={buy}
          badge={words(t('vault.market'), sideWord(buy))}
          symbol={buy ? e.trade.bought.symbol : e.trade.sold.symbol}
          summary={
            buy
              ? `${fmtShort(e.trade.bought.amount)} ${displaySymbol(e.trade.bought.symbol)}`
              : `${fmtShort(e.trade.sold.amount)} ${displaySymbol(e.trade.sold.symbol)}`
          }
          right={<Pill label={t('mobile.trade.settled_status')} tone="green" />}
          lines={[
            [t('mobile.trade.paid'), `${fmtShort(e.trade.sold.amount)} ${displaySymbol(e.trade.sold.symbol)}`],
            [t('vault.receive'), `${fmtShort(e.trade.bought.amount)} ${displaySymbol(e.trade.bought.symbol)}`],
            ...(e.trade.ts ? [[t('mobile.trade.settled'), fmtExpiry(e.trade.ts, language)] as [string, string]] : []),
          ]}
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
    return (
      <HistoryRow
        key={e.key}
        buy={buy}
        badge={words(t(e.kind === 'twap' ? 'vault.twap' : 'vault.limit'), sideWord(buy))}
        symbol={buy ? buyM.symbol : sellM.symbol}
        summary={buy ? `${fmtShort(recv)} ${displaySymbol(buyM.symbol)}` : `${fmtShort(sell)} ${displaySymbol(sellM.symbol)}`}
        right={
          e.kind === 'twap' ? (
            <Text style={styles.filled}>
              {e.group.filled}/{e.group.total} {t('mobile.trade.filled_parts')}
            </Text>
          ) : st ? (
            <Pill label={t(st.key)} tone={st.tone} />
          ) : null
        }
        lines={[
          [t('vault.pay'), `${fmtShort(sell)} ${displaySymbol(sellM.symbol)}`],
          [t('vault.receive'), `${fmtShort(recv)} ${displaySymbol(buyM.symbol)}`],
          ...(e.kind === 'twap'
            ? ([
                [t('mobile.trade.per_part'), `${fmtShort(sell / e.group.total)} ${displaySymbol(sellM.symbol)}`],
                [
                  t('mobile.trade.parts_history'),
                  t('mobile.trade.parts_posted', {posted: e.group.parts.length, total: e.group.total}),
                ],
              ] as [string, string][])
            : []),
          [t('vault.expires'), fmtExpiry(e.kind === 'twap' ? e.group.schedule.windowEnd : o.validTo, language)],
        ]}
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
        * One row: the three kinds of order, and a chip that opens the status.
        *
        * The kinds are the categories because that is what a record of orders is browsed by. Status
        * is the second cut and a rarer one, so it collapses into a chip that NAMES the state it is
        * filtering by — "All" until a state is picked, the state itself after — and a sheet behind
        * it. Two rows of tabs made the page look like it was mostly chrome.
        *
        * The chip is also the "all kinds" category, which is what makes the row a row: picking
        * Market and then wanting everything back had nowhere to go but a second tap on Market, and
        * a filter you clear by re-tapping is a filter people get stuck in. It is the leftmost item
        * and it lights up when no kind is filtered, exactly as an "All" tab would.
        *
        * No counts on the labels. A count beside a filter has to be computed against the OTHER
        * filter's selection to be true, and the pair of them changing as you tap was more to read
        * than the one number anybody wanted.
        */}
      <View style={styles.tabs}>
        <Pressable
          style={styles.statusChip}
          onPress={() => {
            setTypeFilter('all');
            setStatusOpen(true);
          }}
          hitSlop={6}
          accessibilityRole="button">
          <Text style={[styles.cat, typeFilter === 'all' && styles.catOn]}>{STATUS_LABEL[filter]}</Text>
          <Svg width={12} height={12} viewBox="0 0 24 24">
            <Path
              d="M6 9l6 6 6-6"
              stroke={typeFilter === 'all' ? c.text : c.subtext}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </Svg>
        </Pressable>
        {TYPE_FILTERS.map((f) => (
          <Pressable key={f.key} style={styles.catTab} onPress={() => setTypeFilter(f.key)} hitSlop={6}>
            <Text style={[styles.cat, typeFilter === f.key && styles.catOn]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>
      {/* The first load spins HERE, where the list will be — the pull control is for a pull. A
          refresh after that leaves the rows up and spins in the control instead, so the page does
          not blank out what the user is reading. */}
      <View style={styles.card}>
        {!loaded ? (
          <ActivityIndicator color={c.accent} style={styles.spinner} />
        ) : shown.length === 0 ? (
          <Text style={styles.empty}>{t('mobile.trade.no_orders')}</Text>
        ) : (
          shown.map(row)
        )}
      </View>

      <PickerSheet
        visible={statusOpen}
        title={t('mobile.trade.order_status')}
        items={(['all', 'open', 'finished', 'cancelled'] as Filter[]).map((k) => ({key: k, label: STATUS_LABEL[k]}))}
        selected={filter}
        onSelect={(k) => setFilter(k as Filter)}
        onClose={() => setStatusOpen(false)}
      />
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
function HistoryRow({
  buy,
  badge,
  symbol,
  summary,
  right,
  lines,
}: {
  buy: boolean;
  badge: string;
  /** The leg the summary is about — a buy's bought asset, a sell's sold one. */
  symbol: string;
  summary: string;
  right: React.ReactNode;
  lines: [string, string][];
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <View style={[styles.badge, {backgroundColor: buy ? c.successSoft : c.dangerSoft}]}>
            <Text style={[styles.badgeText, {color: buy ? c.success : c.danger}]}>{badge}</Text>
          </View>
          <View style={styles.summaryWrap}>
            <TokenIcon symbol={symbol} size={18} />
            <Text style={styles.summary} numberOfLines={1}>
              {summary}
            </Text>
          </View>
        </View>
        {right}
      </View>
      <View style={styles.detail}>
        {lines.map(([label, value]) => (
          <View key={label} style={styles.line}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.value}>{value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 12, paddingBottom: 32},
    // The Market directory's own category metrics, so the two rows read as the same control.
    tabs: {flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 4},
    statusChip: {flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 6},
    catTab: {paddingVertical: 6},
    cat: {color: c.subtext, fontSize: 15, fontWeight: '600'},
    catOn: {color: c.text, fontWeight: '700'},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    row: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    head: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, gap: 10, minHeight: 52},
    headLeft: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1},
    badge: {borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4},
    badgeText: {fontSize: 12, fontWeight: '700'},
    // The icon travels with the leg, so the row says WHICH asset before it says how much of it.
    summaryWrap: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0},
    summary: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
    filled: {color: c.subtext, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
    detail: {paddingBottom: 14, gap: 10},
    line: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10},
    label: {color: c.subtext, fontSize: 14},
    value: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right'},
    empty: {color: c.subtext, fontSize: 13, textAlign: 'center', paddingVertical: 36},
    // The same height the empty line occupies, so the card does not resize as the list arrives.
    spinner: {paddingVertical: 36},
  });

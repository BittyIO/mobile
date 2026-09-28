import {useHeaderHeight} from '@react-navigation/elements';
import React, {useCallback, useMemo, useState} from 'react';
import {ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Svg, {Circle, Line, Path} from 'react-native-svg';
import type {RootStackParamList} from '@/App';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {ReceiveDialog} from '@/components/ReceiveDialog';
import {useNetwork, networkLabel} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {useVaultLp} from '@/vault/useVaultLp';
import {useFlows} from '@/vault/useFlows';
import {earnedRaw} from '@/vault/flows';
import {usePrices} from '@/vault/usePrices';
import {usdValue, fmtUsd} from '@/core/prices';
import {fmtNum, displaySymbol} from '@/core/format';
import {ASSET_CATEGORIES, type AssetCategory} from '@/core/assets';
import {useAssetCatalog} from '@/core/asset-catalog';
import {balanceOfSymbol} from '@/vault/read';
import {formatUnits} from 'viem';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/** Eye (visible) / eye-off (hidden) toggle icon. */
function EyeIcon({off, color, size = 20}: {off: boolean; color: string; size?: number}) {
  const c = {stroke: color, strokeWidth: 1.8, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {off ? (
        <>
          <Path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c6 0 10 7 10 7a18.5 18.5 0 0 1-2.4 3.3M6.6 6.6A18.6 18.6 0 0 0 2 12s4 7 10 7a10.3 10.3 0 0 0 4.3-.9" {...c} />
          <Path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" {...c} />
          <Line x1={3} y1={3} x2={21} y2={21} {...c} />
        </>
      ) : (
        <>
          <Path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" {...c} />
          <Circle cx={12} cy={12} r={3} {...c} />
        </>
      )}
    </Svg>
  );
}

/** Send (arrow out, up-right) / Receive (arrow in, down-left) / History (clock) action icons. */
function ActionIcon({name, color, size = 22}: {name: 'send' | 'receive' | 'history'; color: string; size?: number}) {
  const c = {stroke: color, strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'send' ? (
        // Out and away: the diagonal arrow wallets use for Send (lucide arrow-up-right).
        <>
          <Path d="M7 17L17 7" {...c} />
          <Path d="M8 7h9v9" {...c} />
        </>
      ) : name === 'receive' ? (
        // In and down: its mirror for Receive (lucide arrow-down-left).
        <>
          <Path d="M17 7L7 17" {...c} />
          <Path d="M16 17H7V8" {...c} />
        </>
      ) : (
        <>
          <Circle cx={12} cy={12} r={9} {...c} />
          <Path d="M12 7.5V12l3 2" {...c} />
        </>
      )}
    </Svg>
  );
}

const fmt = fmtNum;

type Row = {
  symbol: string;
  company?: string;
  icon?: string;
  address: string;
  free: number;
  yielding: number;
  lending: number;
  earned: number;
  total: number;
  usd: number | null;
  price: number | null;
  stable: boolean;
  category: AssetCategory;
};

/** The assets card for one category: its rows, or the loading / empty / error state. */
function AssetList({rows, loading, error}: {rows: Row[]; loading: boolean; error: string | null}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={styles.card}>
      {error ? (
        <Text style={styles.err}>{error}</Text>
      ) : loading ? (
        <ActivityIndicator color={c.accent} style={{paddingVertical: 20}} />
      ) : rows.length === 0 ? (
        <Text style={styles.note}>{t('vault.no_assets')}</Text>
      ) : (
        <View style={styles.list}>
          {rows.map((r, i) => (
            <AssetRow key={r.address} row={r} first={i === 0} last={i === rows.length - 1} />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * One asset: the name with the unit price under it, and at the right the
 * balance (principal + earned in green when yield has accrued) with the holding's value under it.
 */
function AssetRow({row, first, last}: {row: Row; first: boolean; last: boolean}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={[styles.row, !first && styles.rowSeparator, first && styles.noTop, last && styles.noBottom]}>
      <View style={styles.assetCell}>
        <TokenIcon symbol={row.symbol} uri={row.icon} />
        <View style={styles.assetText}>
          <View style={styles.symLine}>
            <Text style={styles.sym}>{displaySymbol(row.symbol)}</Text>
            {row.company ? (
              <Text style={styles.company} numberOfLines={1}>
                {row.company}
              </Text>
            ) : null}
          </View>
          {row.price != null ? <Text style={styles.sub}>{fmtUsd(row.price)}</Text> : null}
        </View>
      </View>
      <View style={styles.amtCol}>
        <Text style={styles.amt}>
          {row.earned > 0 ? (
            <>
              <Amount v={fmt(row.total - row.earned)} size={15} weight="600" />{' '}
              <Text style={styles.amtEarned}>+ <Amount v={fmt(row.earned)} size={13} color={c.success} weight="600" /></Text>
            </>
          ) : (
            <Amount v={fmt(row.total)} size={15} weight="600" />
          )}
        </Text>
        {row.usd != null ? <Text style={styles.sub}>{fmtUsd(row.usd)}</Text> : null}
      </View>
    </View>
  );
}


export function VaultHomeScreen() {
  const headerHeight = useHeaderHeight();
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const bal = useVaultBalances(network);
  const pos = useVaultPositions(bal.vault, network);
  const lp = useVaultLp(bal.vault, network);
  const flows = useFlows(bal.vault, network);
  const prices = usePrices(network);

  // The hooks load once on mount; after that the data refreshes only on pull-to-refresh. Refetching on
  // every focus flashed the loading state each time the tab was opened.

  const [hidden, setHidden] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  const catalog = useAssetCatalog(network);
  const rows = useMemo<Row[]>(() => {
    // Stablecoins lead the list, then the rest in catalog order.
    const assets = [...catalog].sort((x, y) => Number(y.kind === 'stable') - Number(x.kind === 'stable'));
    return assets.map((a) => {
      const free = Number(bal.balances ? balanceOfSymbol(bal.balances, a.symbol) : '0');
      const yielding = pos.positions
        .filter((p) => p.kind === 'staked' && p.symbol === a.symbol)
        .reduce((s, p) => s + Number(p.formatted), 0);
      const lending = pos.positions
        .filter((p) => p.kind === 'supplied' && p.symbol === a.symbol)
        .reduce((s, p) => s + Number(p.formatted), 0);
      // Earnings accrued on this asset's yield/lend positions (from the flows feed).
      const earned = flows.flows
        ? pos.positions
            .filter((p) => p.symbol === a.symbol)
            .reduce((s, p) => {
              const raw = earnedRaw(p, flows.flows!);
              return s + (raw != null ? Number(formatUnits(raw, p.decimals)) : 0);
            }, 0)
        : 0;
      const total = free + yielding + lending;
      return {symbol: a.symbol, company: a.company, icon: a.icon, address: a.address, free, yielding, lending, earned, total, usd: usdValue(total, a.symbol, prices), price: usdValue(1, a.symbol, prices), stable: a.kind === 'stable', category: a.category ?? 'crypto_native'};
    });
  }, [catalog, bal.balances, pos.positions, flows.flows, network, prices]);

  // Category filter, the web's grouping: whichever categories this network's assets use, Crypto
  // Native first and selected by default.
  const [category, setCategory] = useState<AssetCategory>('crypto_native');
  const categories = useMemo(() => ASSET_CATEGORIES.filter((k) => rows.some((r) => r.category === k)), [rows]);
  const byCategory = useMemo(() => {
    const m = new Map<AssetCategory, Row[]>();
    for (const r of rows) m.set(r.category, [...(m.get(r.category) ?? []), r]);
    return m;
  }, [rows]);
  // The lists sit side by side in a horizontal pager: a swipe moves to the neighbouring category and a
  // tap on a tab scrolls the pager there, so the list always slides in from the side it comes from.
  // The pager is only as tall as the page in view, interpolated between neighbours while swiping, so
  // each category keeps the height of its own rows.
  const pagerRef = React.useRef<ScrollView>(null);
  const pagerX = React.useRef(new Animated.Value(0)).current;
  const [pageW, setPageW] = useState(0);
  const [pageH, setPageH] = useState<Record<string, number>>({});
  const pages = categories.length > 0 ? categories : (['crypto_native'] as AssetCategory[]);
  const pickCategory = (k: AssetCategory) => {
    setCategory(k);
    const i = pages.indexOf(k);
    if (i >= 0 && pageW > 0) pagerRef.current?.scrollTo({x: i * pageW, animated: true});
  };
  const onPagerSettle = (x: number) => {
    if (pageW <= 0) return;
    const k = pages[Math.max(0, Math.min(pages.length - 1, Math.round(x / pageW)))];
    if (k && k !== category) setCategory(k);
  };
  const knownH = pages.map((k) => pageH[k]);
  const allKnown = pages.length > 1 && pageW > 0 && knownH.every((h) => h != null);
  const maxH = allKnown ? Math.max(...(knownH as number[])) : 0;
  // Nothing is clipped: the pager stays as tall as its tallest page, and an animated negative bottom
  // margin pulls the content below up to the bottom of the page in view, so each card shows whole with
  // its rounded corners and the page below still follows the current list's height.
  const pagerStyle = allKnown
    ? {
        height: maxH,
        marginBottom: pagerX.interpolate({
          inputRange: pages.map((_, i) => i * pageW),
          outputRange: (knownH as number[]).map((h) => h - maxH),
          extrapolate: 'clamp',
        }),
      }
    : undefined;
  // A new network has a different list: start the selection afresh.
  React.useEffect(() => {
    setCategory('crypto_native');
    setPageH({});
    pagerRef.current?.scrollTo({x: 0, animated: false});
  }, [network]);

  // Total portfolio value: every asset (free + yielding + lending) plus both sides of each LP position.
  const totalUsd = useMemo(() => {
    let sum = 0;
    let any = false;
    rows.forEach((r) => {
      if (r.usd != null) {
        sum += r.usd;
        any = true;
      }
    });
    lp.lp.forEach((p) => {
      const v0 = usdValue(p.amount0, p.symbol0, prices);
      const v1 = usdValue(p.amount1, p.symbol1, prices);
      if (v0 != null) {
        sum += v0;
        any = true;
      }
      if (v1 != null) {
        sum += v1;
        any = true;
      }
    });
    return any ? sum : null;
  }, [rows, lp.lp, prices]);

  // The pull spinner belongs to a pull only, never to the first load.
  const anyLoading = bal.loading || pos.loading || lp.loading;
  const [pulled, setPulled] = useState(false);
  const refreshing = pulled && anyLoading;
  const onRefresh = useCallback(() => {
    setPulled(true);
    bal.refresh();
    pos.refresh();
    lp.refresh();
  }, [bal, pos, lp]);
  React.useEffect(() => {
    if (!anyLoading) setPulled(false);
  }, [anyLoading]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical
      style={styles.container}
      contentContainerStyle={[styles.content, {paddingTop: 8}]}
      contentInset={{top: headerHeight}}
      contentOffset={{x: 0, y: -headerHeight}}
      scrollIndicatorInsets={{top: headerHeight}}
      automaticallyAdjustContentInsets={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text} colors={[c.accent]} />}>
      <View style={styles.heroCard}>
        <View style={styles.totalHeader}>
          <Text style={styles.totalLabel}>{t('vault.total_value_label')}</Text>
          <Pressable onPress={() => setHidden((v) => !v)} hitSlop={10}>
            <EyeIcon off={hidden} color={c.subtext} />
          </Pressable>
        </View>
        <Text style={styles.totalValue}>{hidden ? '$••••••' : totalUsd != null ? fmtUsd(totalUsd) : '—'}</Text>
        <View style={styles.actions}>
          {([
            {label: t('vault.send'), icon: 'send', onPress: () => nav.navigate('Payments')},
            {label: t('vault.receive'), icon: 'receive', onPress: () => setReceiveOpen(true)},
            {label: t('mobile.app.history'), icon: 'history', onPress: () => nav.navigate('Transactions')},
          ] as const).map((a) => (
            <Pressable key={a.icon} style={styles.action} onPress={a.onPress}>
              <View style={styles.actionCircle}>
                <ActionIcon name={a.icon} color={c.accent} />
              </View>
              <Text style={styles.actionLabel}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {categories.length > 1 ? (
        <View style={styles.catWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catRow}>
            {categories.map((k) => {
              const on = category === k;
              return (
                <Pressable key={k} onPress={() => pickCategory(k)} style={styles.catTab}>
                  <Text style={[styles.catText, on && styles.catTextOn]}>{k === 'crypto_native' ? t('mobile.home.category_crypto') : t(`vault.category_${k}`)}</Text>
                  <View style={[styles.catUnderline, on && styles.catUnderlineOn]} />
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {/* Each category is its own list, one page of the pager. */}
      <View onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
        {pageW > 0 ? (
          <Animated.ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            scrollEnabled={pages.length > 1}
            nestedScrollEnabled
            style={pagerStyle}
            contentContainerStyle={styles.pagerContent}
            onScroll={Animated.event([{nativeEvent: {contentOffset: {x: pagerX}}}], {useNativeDriver: false})}
            scrollEventThrottle={16}
            onMomentumScrollEnd={(e) => onPagerSettle(e.nativeEvent.contentOffset.x)}>
            {pages.map((k) => (
              <View key={k} style={{width: pageW}}>
                <View
                  onLayout={(e) => {
                    // Read the height now: the event is recycled before a state updater runs.
                    const h = e.nativeEvent.layout.height;
                    setPageH((prev) => (prev[k] === h ? prev : {...prev, [k]: h}));
                  }}>
                  <AssetList rows={byCategory.get(k) ?? []} loading={bal.loading && !bal.balances} error={bal.error} />
                </View>
              </View>
            ))}
          </Animated.ScrollView>
        ) : null}
      </View>

      <ReceiveDialog
        visible={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        vault={bal.vault}
        networkLabel={networkLabel(network, t)}
      />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  content: {flexGrow: 1, padding: 16, gap: 16, paddingBottom: 32},
  card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 6},
  // Underline tabs sized to their labels and scrollable; only the selected tab draws its accent line.
  catWrap: {marginTop: -4, marginBottom: -8},
  // Pages keep their own height (no stretch to the tallest neighbour).
  pagerContent: {alignItems: 'flex-start'},
  catRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 20, paddingHorizontal: 4},
  catTab: {alignItems: 'center', gap: 8, paddingTop: 6},
  catText: {color: c.subtext, fontSize: 14, fontWeight: '600'},
  catTextOn: {color: c.text},
  catUnderline: {height: 2, alignSelf: 'stretch', backgroundColor: 'transparent', borderRadius: 1},
  catUnderlineOn: {backgroundColor: c.accent},
  heroCard: {backgroundColor: c.card, borderRadius: 20, padding: 20, gap: 6},
  totalHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  totalLabel: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  totalValue: {color: c.text, fontSize: 34, fontWeight: '800', marginTop: 2},
  actions: {flexDirection: 'row', justifyContent: 'space-around', marginTop: 16, paddingTop: 18, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  action: {alignItems: 'center', gap: 8},
  actionCircle: {width: 54, height: 54, borderRadius: 27, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center'},
  actionLabel: {color: c.text, fontSize: 13, fontWeight: '600'},
  note: {color: c.subtext, fontSize: 13, paddingVertical: 8},
  err: {color: c.danger, fontSize: 13, paddingVertical: 8},
  list: {gap: 0},
  // The separator sits on TOP of every row: one between the header and the first asset, one
  // between each pair of rows, and none trailing the last.
  rowSeparator: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  row: {flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 10},
  assetCell: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1},
  badge: {width: 28, height: 28, borderRadius: 14, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center'},
  badgeText: {color: c.subtext, fontSize: 10, fontWeight: '700'},
  assetText: {flexShrink: 1, minWidth: 0},
  symLine: {flexDirection: 'row', alignItems: 'baseline', gap: 6, flexShrink: 1},
  company: {color: c.subtext, fontSize: 13, flexShrink: 1},
  sym: {color: c.text, fontSize: 15, fontWeight: '600'},
  amtCol: {alignItems: 'flex-end'},
  amt: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
  sub: {color: c.subtext, fontSize: 12, marginTop: 2},
  amtEarned: {color: c.success, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
  chev: {color: c.subtext, fontSize: 18, width: 16, textAlign: 'right'},
  // The card's padding frames the list: the last row (or its open details) adds no bottom padding,
  // so the space below the last asset equals the space above the header.
  noBottom: {paddingBottom: 0},
  noTop: {paddingTop: 0},
  depositBtn: {backgroundColor: c.accent, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 2},
  depositText: {color: c.onAccent, fontSize: 14, fontWeight: '700'},
});

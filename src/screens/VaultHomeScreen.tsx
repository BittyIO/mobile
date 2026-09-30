import {useHeaderHeight} from '@react-navigation/elements';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, PanResponder, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
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

import {useAssetCatalog} from '@/core/asset-catalog';
import {assetCategory, type AssetCategory} from '@/core/assets';
import {useAssetOrder, useFavoriteSet} from '@/core/favorites-store';
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
  icon?: string;
  address: string;
  free: number;
  yielding: number;
  lending: number;
  /** Each position behind the totals, with what it has earned, for the expanded row. */
  legs: {protocol: string; kind: 'staked' | 'supplied'; amount: number; earned: number}[];
  earned: number;
  total: number;
  usd: number | null;
  price: number | null;
  stable: boolean;
  category: AssetCategory;
};

/** The assets card for one category: its rows, or the loading / empty / error state. */
function AssetList({
  rows,
  loading,
  error,
  onTrade,
  onReorder,
  onDragging,
}: {
  rows: Row[];
  loading: boolean;
  error: string | null;
  onTrade: (row: Row) => (() => void) | null;
  /** The new order, by symbol, once a drag settles. */
  onReorder: (symbols: string[]) => void;
  /** The parent stops scrolling while a row is in hand. */
  onDragging: (active: boolean) => void;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();

  /**
   * Long press and drag to reorder.
   *
   * Row heights differ — an open row is taller than a closed one — so the drop target is worked
   * out from measured heights rather than assuming they match. The row in hand is lifted and
   * follows the finger; the rows it passes slide out of its way by exactly its height, so the gap
   * that opens is the one it will land in.
   */
  const [heights, setHeights] = useState<number[]>([]);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState(0);
  const dy = useRef(new Animated.Value(0)).current;
  // Read inside the responder, which is created once and would otherwise see the first render.
  //
  // `onReorder` has to live here too, not just the data. It is rebuilt every render around the
  // CURRENT network, so the copy the responder captured on mount writes to whichever network was
  // showing when the Overview first mounted — which is why a drag appeared to work on Ethereum
  // and do nothing anywhere else: every other network's order was being saved under Ethereum's key.
  const live = useRef({rows, heights, from: null as number | null, to: 0, onReorder});
  live.current = {...live.current, rows, heights, onReorder};

  const measure = (i: number, h: number) =>
    setHeights((prev) => (prev[i] === h ? prev : Object.assign([...prev], {[i]: h})));

  /** Which slot the dragged row's own centre now sits over. */
  const slotFor = (offset: number) => {
    const {heights: hs, from: f} = live.current;
    if (f == null) return 0;
    const own = hs[f] ?? 0;
    let target = f;
    let travelled = 0;
    if (offset > 0) {
      for (let i = f + 1; i < hs.length; i++) {
        travelled += hs[i] ?? own;
        if (offset > travelled - (hs[i] ?? own) / 2) target = i;
        else break;
      }
    } else {
      for (let i = f - 1; i >= 0; i--) {
        travelled += hs[i] ?? own;
        if (-offset > travelled - (hs[i] ?? own) / 2) target = i;
        else break;
      }
    }
    return target;
  };

  const responder = useRef(
    PanResponder.create({
      // Only a long press starts this. A plain touch belongs to the row's own targets.
      onStartShouldSetPanResponder: () => false,
      // CAPTURE, not the bubbling variant. The row's own Pressable holds the responder from the
      // moment the finger lands, and a bubbling claim asks it to hand over — which it does not do
      // reliably once it has fired its long press. Asking on the way DOWN the tree takes the
      // gesture before the Pressable sees the move at all. The start handler stays false, so a
      // plain tap still belongs to the row.
      onMoveShouldSetPanResponderCapture: () => live.current.from != null,
      onMoveShouldSetPanResponder: () => live.current.from != null,
      // Nothing takes the gesture back mid-drag — not the page, not the row's own Pressable.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderMove: (_e: unknown, g: {dy: number}) => {
        dy.setValue(g.dy);
        const next = slotFor(g.dy);
        if (next !== live.current.to) {
          live.current.to = next;
          setTo(next);
        }
      },
      onPanResponderRelease: () => finish(),
      onPanResponderTerminate: () => finish(),
    }),
  ).current;

  const finish = () => {
    const {rows: rs, from: f, to: target, onReorder: save} = live.current;
    if (f != null && target !== f) {
      const next = [...rs];
      next.splice(target, 0, next.splice(f, 1)[0]);
      save(next.map((r) => r.symbol));
    }
    cancelHold();
    live.current.from = null;
    setFrom(null);
    dy.setValue(0);
    onDragging(false);
  };

  /**
   * Arm the drag on a long hold, timed from the touch itself.
   *
   * Pressable's own onLongPress cancels the moment the finger drifts, which on a scrolling list is
   * most holds. A timer started by the raw touch survives that, and the press handlers underneath
   * are left alone so a tap still does what it did.
   */
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armHold = (i: number) => {
    holdTimer.current = setTimeout(() => begin(i), 220);
  };
  const cancelHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  /**
   * The finger left. Cancels a hold that never matured, and puts down a row that was lifted but
   * never moved — without this it stays picked up for ever, because the drag responder only ends
   * a gesture it actually took.
   */
  const endTouch = () => {
    cancelHold();
    if (live.current.from != null) finish();
  };

  const begin = (i: number) => {
    live.current.from = i;
    live.current.to = i;
    setFrom(i);
    setTo(i);
    dy.setValue(0);
    onDragging(true);
  };

  /** How far a row that is not the one in hand has to step aside. */
  const shiftFor = (i: number) => {
    if (from == null || i === from) return 0;
    const own = heights[from] ?? 0;
    if (from < to && i > from && i <= to) return -own;
    if (from > to && i >= to && i < from) return own;
    return 0;
  };

  return (
    <View style={styles.listCard}>
      {error ? (
        <Text style={styles.err}>{error}</Text>
      ) : loading ? (
        <ActivityIndicator color={c.accent} style={{paddingVertical: 20}} />
      ) : rows.length === 0 ? (
        <Text style={styles.note}>{t('vault.no_assets')}</Text>
      ) : (
        <View style={styles.list}>
          {rows.map((r, i) => {
            const held = from === i;
            return (
              <Animated.View
                key={r.address}
                onLayout={(e) => measure(i, e.nativeEvent.layout.height)}
                onTouchStart={() => armHold(i)}
                onTouchEnd={endTouch}
                onTouchCancel={endTouch}
                style={[
                  held && styles.lifted,
                  {transform: [{translateY: held ? dy : shiftFor(i)}]},
                ]}
                // Attached to every row, always. Adding them only once a row is held meant the
                // view joined the responder negotiation after the touch had already started, and
                // the move was never offered to it — which is why nothing moved.
                {...responder.panHandlers}>
                <AssetRow row={r} first={i === 0} onTrade={onTrade(r)} onHold={() => begin(i)} />
              </Animated.View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/**
 * One asset: the name with the unit price under it, and at the right the balance (principal +
 * earned in green when yield has accrued) with the holding's value under it.
 *
 * A row whose balance is spread across a yield or lending position opens on tap to show where each
 * part of it sits. The total on the right is the sum of all three, which answers "how much do I
 * have" but not "how much can I spend right now" — that is what the breakdown is for, and it is
 * hidden until asked for so the common single-source row stays one line.
 */
function AssetRow({
  row,
  first,
  onTrade,
  onHold,
}: {
  row: Row;
  first: boolean;
  /** Null when this asset has nothing to trade against, which leaves the name inert. */
  onTrade: (() => void) | null;
  /** A long press picks the row up so it can be dragged to a new place in the list. */
  onHold: () => void;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const [open, setOpen] = useState(false);
  const splittable = row.legs.length > 0 && row.total > 0;

  return (
    <View style={!first && styles.rowSeparator}>
      {/* The row goes to Trade. The amounts on the right are their own target and open the
          breakdown instead — a nested pressable wins over the one around it, so the two do not
          fight, and the split matches what each half is about: the asset, and what you hold of it. */}
      {/* onLongPress is here for its side effect as much as its handler: once Pressability has
          fired a long press it suppresses the tap, so releasing after a hold does not also open
          the trade page. The drag itself is armed by a timer on the wrapper, which survives the
          small finger drift that cancels a Pressable's press. */}
      <Pressable style={styles.rowInner} onPress={() => onTrade?.()} onLongPress={onHold} delayLongPress={220}>
        <View style={styles.assetCell}>
          <TokenIcon symbol={row.symbol} uri={row.icon} size={30} />
          <View style={styles.assetText}>
            {/* The ticker alone. What the company is belongs on the Trade directory, where you are
                choosing between assets; here you already know what you hold. */}
            <Text style={styles.sym}>{displaySymbol(row.symbol)}</Text>
            {row.price != null ? <Text style={styles.sub}>{fmtUsd(row.price)}</Text> : null}
          </View>
        </View>
        <Pressable
          style={styles.amtCol}
          hitSlop={8}
          disabled={!splittable}
          onPress={() => setOpen((o) => !o)}>
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
        </Pressable>
      </Pressable>

      {open ? (
        <View style={styles.legs}>
          {/* Balance first: it is the part that can be spent without unwinding anything. Which
              protocol holds the rest is a detail for the Earn tab; here the question is only how
              much of the total is free and how much is working. */}
          <Leg label={t('vault.balance')} amount={row.free} symbol={row.symbol} />
          {row.legs.map((leg, i) => (
            <Leg
              key={`${leg.protocol}-${leg.kind}-${i}`}
              label={t(leg.kind === 'staked' ? 'vault.yielding' : 'vault.lending')}
              amount={leg.amount}
              earned={leg.earned}
              symbol={row.symbol}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One line of the breakdown, indented to the asset name rather than to its icon.
 *
 * A position splits into what was put in and what it has made, the same way the row's total does
 * above it, so the green figure answers "which of these is actually earning, and how much".
 */
function Leg({label, amount, earned = 0, symbol}: {label: string; amount: number; earned?: number; symbol: string}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={styles.legRow}>
      <Text style={styles.legLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.legAmt}>
        {earned > 0 ? (
          <>
            <Amount v={fmt(amount - earned)} size={13} weight="600" />{' '}
            <Text style={styles.legEarned}>
              + <Amount v={fmt(earned)} size={12} color={c.success} weight="600" />
            </Text>{' '}
          </>
        ) : (
          <>
            <Amount v={fmt(amount)} size={13} weight="600" />{' '}
          </>
        )}
        {displaySymbol(symbol)}
      </Text>
    </View>
  );
}


export function VaultHomeScreen() {
  const headerHeight = useHeaderHeight();
  const tabBarHeight = useBottomTabBarHeight();
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const bal = useVaultBalances(network);
  const pos = useVaultPositions(bal.vault, network);
  const lp = useVaultLp(bal.vault, network);
  const flows = useFlows(bal.vault, network);

  // The hooks load once on mount; after that the data refreshes only on pull-to-refresh. Refetching on
  // every focus flashed the loading state each time the tab was opened.

  const [hidden, setHidden] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  const catalog = useAssetCatalog(network);
  // Priced from the catalog the rows actually render, so an asset that exists only in the live
  // catalog — every Ondo stock on mainnet — is no longer left without a price.
  const catalogSymbols = useMemo(() => catalog.map((a) => a.symbol), [catalog]);
  const [priceNonce, setPriceNonce] = useState(0);
  const prices = usePrices(network, priceNonce, catalogSymbols);
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
      const legs = pos.positions
        .filter((p) => p.symbol === a.symbol && Number(p.formatted) > 0)
        .map((p) => {
          const raw = flows.flows ? earnedRaw(p, flows.flows) : null;
          return {
            protocol: p.protocolName,
            kind: p.kind as 'staked' | 'supplied',
            amount: Number(p.formatted),
            earned: raw != null ? Number(formatUnits(raw, p.decimals)) : 0,
          };
        })
        // Yielding above lending, always, rather than whatever order the positions arrived in.
        .sort((x, y) => Number(x.kind === 'supplied') - Number(y.kind === 'supplied'));
      const total = free + yielding + lending;
      return {legs, symbol: a.symbol, icon: a.icon, address: a.address, free, yielding, lending, earned, total, usd: usdValue(total, a.symbol, prices), price: usdValue(1, a.symbol, prices), stable: a.kind === 'stable', category: assetCategory(a.category)};
    });
  }, [catalog, bal.balances, pos.positions, flows.flows, network, prices]);

  /**
   * Tapping an asset's name opens Trade on a pair for it.
   *
   * The quote is a stable coin the vault actually HOLDS, because a pair the user cannot fund is a
   * dead end: with USDT and no USDC, the pair is ASSET/USDT. Dollars are interchangeable enough
   * that USDC wins when both are funded, and it is the fallback when neither is.
   *
   * A stable coin trades against another stable coin, so USDC opens as USDC/USDT. On a network
   * with only one, there is no second side and the name does nothing rather than opening a pair
   * against itself.
   *
   * The destination is the Trade screen PUSHED over the Overview, the same component the tab
   * renders, so the Trade tab keeps whatever pair the user last left it on.
   */
  const tradeFor = useCallback(
    (row: Row): (() => void) | null => {
      const held = (sym: string) => (rows.find((r) => r.symbol === sym)?.total ?? 0) > 0;
      const options = catalog.filter((a) => a.kind === 'stable').map((a) => a.symbol).filter((s) => s !== row.symbol);
      const quote =
        options.find((s) => s === 'USDC' && held(s)) ??
        options.find(held) ??
        options.find((s) => s === 'USDC') ??
        options[0];
      if (!quote) return null;
      // Pushed, not a tab switch: it is a detour into one pair, with a back button out of it.
      return () => nav.navigate('TradePair', {base: row.symbol, quote});
    },
    [rows, catalog, nav],
  );


  // Category filter, the web's grouping: whichever categories this network's assets use, Crypto
  /**
   * What the Overview lists: the starred assets, plus anything the vault holds.
   *
   * Starring happens on an asset's trade page, and the defaults are the assets any vault is
   * expected to hold. A balance shows whether or not it is starred — money must not be able to
   * disappear from this screen because of a display preference.
   */
  const favorites = useFavoriteSet(network);
  const {sort: sortByOrder, save: saveOrder, key: orderKey} = useAssetOrder(network);
  // A row held for dragging must not also scroll the page under it.
  const [dragging, setDragging] = useState(false);
  const shown = useMemo(
    () => sortByOrder(rows.filter((r) => favorites.has(r.symbol) || r.total > 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, network, orderKey, [...favorites].sort().join(',')],
  );

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
    // Prices too: a pull that refreshed the balances but left last minute's prices behind moved
    // the amounts and not the values, which reads as a bug.
    setPriceNonce((n) => n + 1);
  }, [bal, pos, lp]);
  React.useEffect(() => {
    if (!anyLoading) setPulled(false);
  }, [anyLoading]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical
      // A held row owns the vertical gesture; the page must not scroll out from under it.
      scrollEnabled={!dragging}
      style={styles.container}
      // The bar is translucent and the list runs under it, so the bottom padding has to be the
      // bar's real height or the last row can never be scrolled clear of it.
      contentContainerStyle={[styles.content, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
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

      <AssetList
        rows={shown}
        loading={bal.loading && !bal.balances}
        error={bal.error}
        onTrade={tradeFor}
        onReorder={saveOrder}
        onDragging={setDragging}
      />

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
  // paddingBottom is set inline from the tab bar's height; see the ScrollView.
  content: {flexGrow: 1, padding: 16, gap: 16},
  card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 6},
  // Labels only: the selected one is in the primary text colour, the rest grey.
  // Pages keep their own height (no stretch to the tallest neighbour).

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
  // The card carries only the side padding; the rows own their own vertical space, so the first
  // row is not sitting under the card's 16 AND its own 12. The 4 tops it up to the 16 the rest of
  // the app's grouped lists use.
  /**
   * The row in hand, over the ones it is passing.
   *
   * The negative side margins cancel the card's own padding so the lifted surface runs the whole
   * width of the row, edge to edge. Without them it was inset by 16 on each side and read as a
   * smaller card floating inside the list rather than the row itself being picked up.
   */
  lifted: {
    zIndex: 2,
    elevation: 6,
    marginHorizontal: -16,
    paddingHorizontal: 16,
    backgroundColor: c.cardAlt,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: {width: 0, height: 4},
  },
  listCard: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 4},
  list: {gap: 0},
  // The separator sits on TOP of every row: one between the header and the first asset, one
  // between each pair of rows, and none trailing the last.
  rowSeparator: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  rowInner: {flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 10},
  // Indented to the asset NAME, not its icon: a 28pt icon and the cell's 10pt gap above it.
  legs: {paddingLeft: 38, paddingBottom: 12, gap: 8},
  legRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  legLabel: {flex: 1, color: c.subtext, fontSize: 13},
  legAmt: {color: c.text, fontSize: 13, fontVariant: ['tabular-nums']},
  legEarned: {color: c.success, fontSize: 12},
  assetCell: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1},
  // Sized to the icon and the name, never to the cell: the gap to its right is the row's.
  badge: {width: 28, height: 28, borderRadius: 14, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center'},
  badgeText: {color: c.subtext, fontSize: 10, fontWeight: '700'},
  assetText: {flexShrink: 1, minWidth: 0},
  sym: {color: c.text, fontSize: 15, fontWeight: '600'},
  amtCol: {alignItems: 'flex-end'},
  amt: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
  sub: {color: c.subtext, fontSize: 12, marginTop: 2},
  amtEarned: {color: c.success, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
  chev: {color: c.subtext, fontSize: 18, width: 16, textAlign: 'right'},
  // The card's padding frames the list: the last row (or its open details) adds no bottom padding,
  // so the space below the last asset equals the space above the header.
  depositBtn: {backgroundColor: c.accent, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 2},
  depositText: {color: c.onAccent, fontSize: 14, fontWeight: '700'},
});

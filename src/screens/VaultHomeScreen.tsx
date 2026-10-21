import {useHeaderHeight} from '@react-navigation/elements';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import React, {useCallback, useMemo, useState} from 'react';
import {ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Svg, {Circle, Line, Path} from 'react-native-svg';
import type {RootStackParamList} from '@/App';
import {MarketRow} from '@/components/MarketRow';
import {HoldingRow, MASK} from '@/components/HoldingRow';
import {Amount} from '@/components/Amount';
import {ReceiveDialog} from '@/components/ReceiveDialog';
import {Sheet} from '@/components/Sheet';
import {PortfolioPie, type PieSlice} from '@/components/PortfolioPie';
import {useNetwork, networkLabel} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useSyncFeeReserve} from '@/vault/stableCoinAsGas';
import {useReorder} from '@/components/useReorder';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {useFlows} from '@/vault/useFlows';
import {earnedRaw} from '@/vault/flows';
import {usePrices} from '@/vault/usePrices';
import {useMarketStats, type MarketStat, type MarketStatMap} from '@/vault/useMarketStats';

import {usdValue, fmtUsd} from '@/core/prices';
import {fmtNum, displaySymbol} from '@/core/format';

import {useAssetCatalog} from '@/core/asset-catalog';
import {assetCategory, type AssetCategory} from '@/core/assets';
import {isAssetsList, useFavorites, useWatchLists, watchListLabel, watchListNumber} from '@/core/favorites-store';
import {getFlag, setFlag, HIDE_BALANCES} from '@/core/prefs';
import {useWatchDraft} from '@/core/watch-draft';
import {balanceOfSymbol} from '@/vault/read';
import {getPendingChanges} from '@/vault/risk';
import {useVaultGeneration} from '@/core/vault-generation';
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

/** Send (arrow out, up-right) / Receive (arrow in, down-left) / History (clock) / Security (shield) action icons. */
function ActionIcon({name, color, size = 22}: {name: 'send' | 'receive' | 'history' | 'pending'; color: string; size?: number}) {
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
      ) : name === 'pending' ? (
        // Security: what is waiting out the timelock (lucide shield).
        <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...c} />
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


/**
 * What the eye leaves behind.
 *
 * Dots only — no currency sign in front of the total, because "$••••••" still tells a shoulder
 * that the vault is denominated in dollars and roughly how many digits it holds. A fixed-width run
 * of dots says nothing about either.
 */
const MASK_TOTAL = '••••••';

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
  hidden,
  onTrade,
  onReorder,
  onDragging,
  reorder,
  markets,
  stats,
}: {
  rows: Row[];
  loading: boolean;
  error: string | null;
  /** The eye above the total is off: every figure that is the user's own is masked. */
  hidden: boolean;
  /**
   * Draw these rows as a MARKET list — price, day move and cap — rather than as holdings.
   *
   * True for a list of the user's own, false for "Assets". It used to be inferred from `stats`
   * being null, which conflated the layout with the data and meant the holdings rows could not
   * have the day's move at all: the figures were there, withheld because of how the list reads.
   */
  markets: boolean;
  /** Price, day change and market cap by symbol, for the whole catalog — see {useMarketStats}. */
  stats: MarketStatMap;
  /**
   * Can these rows be picked up and dragged into a new order?
   *
   * Watch lists only. A list someone curated has no order of its own — they chose what is on it,
   * so they choose the sequence — but "Assets" is sorted by what each holding is WORTH, and a
   * hand-placed row in a list that sorts itself is a rule fighting a fact: the balances move on
   * their own, so the row the user dragged to the top leaves it the next time a price does.
   */
  reorder: boolean;
  onTrade: (row: Row) => (() => void) | null;
  /** The new order, by symbol, once a drag settles. */
  onReorder: (symbols: string[]) => void;
  /** The parent stops scrolling while a row is in hand. */
  onDragging: (active: boolean) => void;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();

  // Long press and drag to reorder — see {useReorder}.
  const drag = useReorder({
    items: rows,
    enabled: reorder,
    onReorder: (next) => onReorder(next.map((r) => r.symbol)),
    onDragging,
  });

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
            const props = drag.rowProps(i);
            return (
              <Animated.View key={r.address} {...props} style={[drag.from === i && styles.lifted, props.style]}>
                <AssetRow
                  row={r}
                  first={i === 0}
                  hidden={hidden}
                  onTrade={onTrade(r)}
                  onHold={drag.onHold(i)}
                  markets={markets}
                  stat={stats.get(r.symbol)}
                />
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
  hidden,
  onTrade,
  onHold,
  markets,
  stat,
}: {
  row: Row;
  first: boolean;
  /** Mask the balance and its value. The unit price under the ticker is market data and stays. */
  hidden: boolean;
  /** Null when this asset has nothing to trade against, which leaves the name inert. */
  onTrade: (() => void) | null;
  /** A long press picks the row up so it can be dragged to a new place in the list. Undefined on
   *  a list that sorts itself — see {AssetList}'s `reorder`. */
  onHold?: () => void;
  /**
   * Show what the asset is doing rather than what is held of it.
   *
   * Off on "Assets", where the question is what you hold. On a list of your own it is the other
   * way round: those are assets you are WATCHING, most of them at a balance of zero, so a column
   * of dashes and another of "$0.00" said nothing at all. Here the row carries price, the day's
   * move and the market cap instead, and no balance at all.
   */
  markets: boolean;
  /** This asset's figures, absent while they load and for anything the catalog has no id for. */
  stat: MarketStat | undefined;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const splittable = row.legs.length > 0 && row.total > 0;

  if (markets)
    return (
      <MarketRow
        symbol={row.symbol}
        icon={row.icon}
        price={row.price}
        change24h={stat?.change24h}
        marketCap={stat?.marketCap}
        first={first}
        onPress={() => onTrade?.()}
        onLongPress={onHold}
      />
    );

  return (
    <>
      <HoldingRow
        symbol={row.symbol}
        icon={row.icon}
        price={row.price}
        change24h={stat?.change24h}
        total={row.total}
        earned={row.earned}
        usd={row.usd}
        hidden={hidden}
        first={first}
        onPress={() => onTrade?.()}
        onLongPress={onHold}
        onAmountPress={splittable ? () => setOpen((o) => !o) : undefined}
      />
      {open ? (
        <View style={styles.legs}>
          {/* Balance first: it is the part that can be spent without unwinding anything. Which
              protocol holds the rest is a detail for the Earn tab; here the question is only how
              much of the total is free and how much is working. */}
          <Leg label={t('vault.balance')} amount={row.free} symbol={row.symbol} hidden={hidden} />
          {row.legs.map((leg, i) => (
            <Leg
              key={`${leg.protocol}-${leg.kind}-${i}`}
              label={t(leg.kind === 'staked' ? 'vault.yielding' : 'vault.lending')}
              amount={leg.amount}
              earned={leg.earned}
              symbol={row.symbol}
              hidden={hidden}
            />
          ))}
        </View>
      ) : null}
    </>
  );
}

/**
 * One line of the breakdown, indented to the asset name rather than to its icon.
 *
 * A position splits into what was put in and what it has made, the same way the row's total does
 * above it, so the green figure answers "which of these is actually earning, and how much".
 */
function Leg({label, amount, earned = 0, symbol, hidden}: {label: string; amount: number; earned?: number; symbol: string; hidden: boolean}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={styles.legRow}>
      <Text style={styles.legLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.legAmt}>
        {hidden ? (
          <>{MASK} </>
        ) : earned > 0 ? (
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
  const flows = useFlows(bal.vault, network);
  // Queued changes, counted on the Pending action. Re-read on focus: one call, and a change queued
  // elsewhere (or by someone else holding the key) is exactly what this badge is for.
  const legacy = useVaultGeneration((g) => g.generation) === 'v1.0.3';
  const [pendingCount, setPendingCount] = useState(0);
  useFocusEffect(
    useCallback(() => {
      if (bal.vault) getPendingChanges(bal.vault, network).then((p) => setPendingCount(p.length));
      // The earned ledger, too: this tab mounts at launch and stays up, so a deposit recorded since
      // (from Earn, say) never reached it, and its rows lacked the earned the Earn tab showed. No
      // loading state of its own, so re-reading it on focus flashes nothing.
      flows.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bal.vault, network, legacy]),
  );

  // The hooks load once on mount; after that the data refreshes only on pull-to-refresh. Refetching on
  // every focus flashed the loading state each time the tab was opened.

  // Survives a relaunch, the way the zero-balance filter below does: see HIDE_BALANCES.
  const [hidden, setHidden] = useState(() => getFlag(HIDE_BALANCES));
  const toggleHidden = () => {
    const next = !hidden;
    setFlag(HIDE_BALANCES, next);
    setHidden(next);
  };
  const [receiveOpen, setReceiveOpen] = useState(false);
  // The holdings-distribution sheet, opened from the pie icon on the Assets list's header.
  const [showDistribution, setShowDistribution] = useState(false);
  const {height: screenHeight} = useWindowDimensions();

  const catalog = useAssetCatalog(network);
  // The keeper sweeps auto-yield around this vault's fee float; this tab is up whenever the app is.
  useSyncFeeReserve(network, bal.vault, bal.balances, catalog);
  // Priced from the catalog the rows actually render, so an asset that exists only in the live
  // catalog — every Ondo stock on mainnet — is no longer left without a price.
  const catalogSymbols = useMemo(() => catalog.map((a) => a.symbol), [catalog]);
  const [priceNonce, setPriceNonce] = useState(0);
  const prices = usePrices(network, priceNonce, catalogSymbols);
  /**
   * Day change and market cap, for the watch lists.
   *
   * Asked for the whole catalog rather than per list, because the pager renders every list at
   * once and swiping between them must not each time start a request to a metered third party.
   * One answer covers all of them, and it refreshes on the same pull the prices do.
   */
  const marketStats = useMarketStats(network, catalogSymbols, priceNonce);
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
   * What the Overview lists: the starred assets, plus anything the vault holds worth more than a
   * dime.
   *
   * Starring happens on an asset's trade page, and the defaults are the assets any vault is
   * expected to hold. A balance shows whether or not it is starred — money must not be able to
   * disappear from this screen because of a display preference — but it is judged by VALUE, not
   * amount: a holding worth over $0.10 earns a row, so a dust leftover or a scrap of a near-zero
   * token does not clutter the list. A starred asset shows at any balance, dust included, because
   * the user asked for it; the stablecoins, BTC and ETH are seeded starred, so none of them is
   * ever hidden by this.
   */
  /**
   * Every watch list on this network, and the orders for all of them.
   *
   * The pager renders one page per list, so the per-list hooks (`useAssetOrder`, `useFavoriteSet`)
   * cannot be used here: a hook called once per list changes its call count the moment a list is
   * added or deleted, which React will not have. Reading the whole `order` map once and building a
   * sorter per list from it keeps the hook count fixed whatever the user does.
   */
  const watch = useWatchLists(network);
  const beginDraft = useWatchDraft((s2) => s2.begin);
  const orders = useFavorites((s) => s.order);
  const saveOrder = useFavorites((s) => s.setOrder);
  /** Where this list's rows were dragged to, by symbol. Empty until the user has moved one. */
  const rankFor = (listId: string) =>
    new Map((orders[`${network}:${listId}`] ?? []).map((sym, i) => [sym, i]));
  /**
   * How a watch list is arranged: BIGGEST MARKET CAP first, unless the user has hand-arranged the
   * whole list.
   *
   * Cap is the default because a watch list is read as a market — the rows carry price, the day's
   * move and the cap, and nothing about the vault — so the useful order is the one every market
   * table uses. It replaces catalog order, which put a $2bn stock above ether for no reason the
   * list could show.
   *
   * A manual drag can override it, but ONLY while it still describes every row on the list. The
   * moment a new asset is starred it is not in that saved order, so the arrangement no longer
   * covers the list and is treated as stale: the whole list — the new asset included — falls back
   * to market cap, which is where someone adding an asset to a MARKET list expects to find it.
   * (Before, a newly starred asset dropped to the end in add order, below the saved block, and
   * read as "sorted by when I added it".) Re-dragging the full list restores a hand order.
   *
   * Caps arrive after the first paint, so a list drawn before they land is in catalog order and
   * re-sorts once when they do.
   */
  /** How big the market thinks this asset is. Zero for one the catalog has no figure for, which
   *  sorts it last wherever the cap is the tie-break. */
  const capOf = (symbol: string) => marketStats.get(symbol)?.marketCap ?? 0;
  const sortFor = (listId: string) => {
    const rank = rankFor(listId);
    return <T extends {symbol: string}>(items: T[]): T[] => {
      // Honour a hand order only while it still names every row — otherwise a new addition has no
      // place in it and the list sorts by cap, so the new row lands in its market-cap position.
      const handArranged = items.length > 0 && items.every((it) => rank.has(it.symbol));
      return [...items].sort((a, b) => {
        if (handArranged) {
          const ra = rank.get(a.symbol) ?? Infinity;
          const rb = rank.get(b.symbol) ?? Infinity;
          if (ra !== rb) return ra < rb ? -1 : 1;
        }
        return capOf(b.symbol) - capOf(a.symbol);
      });
    };
  };
  // A row held for dragging must not also scroll the page under it.
  const [dragging, setDragging] = useState(false);
  /**
   * Hide the assets holding nothing.
   *
   * The list is the watch list plus whatever the vault holds, so a starred asset sits at zero
   * waiting to be funded — useful when setting up, noise once there are a dozen of them. Off by
   * default, and it never hides a balance: only rows that are empty anyway.
   */
  /**
   * The rows, funded ones first.
   *
   * What the vault actually holds is what the screen is for; a starred asset sitting at zero is a
   * placeholder waiting to be funded, and a dozen of them pushed the real balances below the fold.
   * The saved drag order still decides the arrangement WITHIN each group, so an order the user set
   * is kept, not overridden — a row that is dragged while empty simply takes that place once it
   * has a balance. With "hide 0" on every row is funded and the split is a no-op.
   */
  /**
   * The rows one list shows, funded ones first.
   *
   * A user's own list is EXACTLY what was starred onto it and nothing else — that is what makes it
   * worth creating.
   *
   * "Assets" is editable like any other list, with one rule of its own: ANYTHING FUNDED IS
   * ALWAYS SHOWN. A balance cannot go missing because of how someone arranged their rows, so
   * un-starring an asset the vault holds hides it from every other list and not from this one.
   *
   * What starring decides here is the empty rows — which assets are on screen ready to be funded.
   * It starts as the core set (every stablecoin, plus bitcoin and ether, seeded in {loadLists}),
   * because those are what a vault is funded in and what fees are paid from, and a row that is
   * already there is a row someone can act on. From there it is theirs to change.
   */
  const rowsForList = (listId: string): Row[] => {
    const held = isAssetsList(listId);
    const starred = new Set(watch.lists.find((l) => l.id === listId)?.symbols ?? []);
    const visible = held
      ? rows.filter((r) => starred.has(r.symbol) || (r.usd ?? 0) > 0.1)
      : rows.filter((r) => starred.has(r.symbol));
    // A list of the user's own keeps the order they dragged it into: they chose what is on it,
    // so they choose the sequence, and it shows no balance to sort by anyway.
    if (!held) return sortFor(listId)(visible);
    /**
     * "Assets" sorts itself: BIGGEST HOLDING FIRST.
     *
     * The question this list answers is where the money is, and the answer is a ranking — so the
     * list simply is that ranking, rather than an arrangement the user has to build and then
     * maintain as the balances move. It replaces three rules that were each a guess at the same
     * thing: stablecoins first out of the catalog, then funded rows above empty ones, then
     * whatever had been dragged where. Dragging is gone from this list with them (see
     * {AssetList}'s `reorder`) — a hand-placed row cannot survive in a list that re-sorts every
     * time a price ticks, and watching one jump after a refresh reads as the app losing the
     * change rather than as a value ranking doing its job.
     *
     * Value, not amount: 0.4 ETH is a bigger holding than 900 of a token worth a tenth of a cent,
     * and the row's own right-hand figure is the dollar value, so the list is ordered by the
     * number the rows are read down.
     *
     * Equal values are broken by MARKET CAP, the same default the watch lists sort by. That is
     * what orders the empty rows — an asset starred and waiting to be funded has no value to rank,
     * and all of them tie at nothing, so below the holdings the list reads biggest-asset-first
     * instead of in whatever order the catalog happens to list them.
     */
    return [...visible].sort((a, b) => {
      const byValue = (b.usd ?? 0) - (a.usd ?? 0);
      return byValue !== 0 ? byValue : capOf(b.symbol) - capOf(a.symbol);
    });
  };

  // Total portfolio value: every asset (free + yielding + lending).
  const totalUsd = useMemo(() => {
    let sum = 0;
    let any = false;
    rows.forEach((r) => {
      if (r.usd != null) {
        sum += r.usd;
        any = true;
      }
    });
    return any ? sum : null;
  }, [rows]);

  // Holdings distribution for the pie: EVERY asset the vault actually holds, largest first — no
  // dust threshold, so a small position still appears in the legend (its slice may be too thin to
  // see, but it is listed). The total the shares are taken against is the sum of exactly what is
  // shown.
  const distribution = useMemo(() => {
    const held: PieSlice[] = rows
      .filter((r) => (r.usd ?? 0) > 0)
      .map((r) => ({symbol: r.symbol, icon: r.icon, usd: r.usd as number}))
      .sort((a, b) => b.usd - a.usd);
    return {held, total: held.reduce((s, x) => s + x.usd, 0)};
  }, [rows]);

  // The pull spinner belongs to a pull only, never to the first load.
  const anyLoading = bal.loading || pos.loading;
  const [pulled, setPulled] = useState(false);
  const refreshing = pulled && anyLoading;
  const onRefresh = useCallback(() => {
    // Same guard as the Earn tab: with no vault the hooks start no load, `anyLoading` never moves,
    // and the flag would stay armed to put a spinner on whatever load came next.
    if (!bal.vault) return;
    setPulled(true);
    bal.refresh();
    pos.refresh();
    flows.refresh();
    // Prices too: a pull that refreshed the balances but left last minute's prices behind moved
    // the amounts and not the values, which reads as a bug.
    setPriceNonce((n) => n + 1);
  }, [bal, pos, flows]);
  React.useEffect(() => {
    if (!anyLoading) setPulled(false);
  }, [anyLoading]);

  /**
   * One page per watch list, swiped sideways — the same pager the Market directory uses for its
   * categories, so the gesture means the same thing in both places.
   *
   * The pager takes the TALLEST page and an animated negative bottom margin pulls whatever follows
   * back up to the page actually showing; without it every list would be as tall as the longest.
   */
  const pagerRef = React.useRef<ScrollView>(null);
  /**
   * The tab row follows the pager.
   *
   * With more lists than fit the line, swiping to one off the right-hand edge left the row showing
   * the lists you had moved away from and no sign of the one you were looking at. Each chip
   * reports its x and width as it lays out, and the row scrolls just far enough to bring the
   * active one fully inside — only when it is actually out of view, so a tap on a visible tab does
   * not drag the row around for no reason.
   */
  const tabsRef = React.useRef<ScrollView>(null);
  const tabBox = React.useRef<Record<string, {x: number; w: number}>>({});
  const tabViewW = React.useRef(0);
  const tabScrollX = React.useRef(0);
  const revealTab = (id: string) => {
    const box = tabBox.current[id];
    const view = tabViewW.current;
    if (!box || view <= 0) return;
    const left = tabScrollX.current;
    const right = left + view;
    // 12 of breathing room, so the chip never ends up flush against the edge it was clipped by.
    if (box.x < left) tabsRef.current?.scrollTo({x: Math.max(0, box.x - 12), animated: true});
    else if (box.x + box.w > right) tabsRef.current?.scrollTo({x: box.x + box.w - view + 12, animated: true});
  };
  const pagerX = React.useRef(new Animated.Value(0)).current;
  const [pageW, setPageW] = useState(0);
  /**
   * Each page's measured height.
   *
   * Keyed by NETWORK and list, not by list alone. "Assets" is the one list id every network
   * shares (`DEFAULT_LIST_ID`), so a single key handed Ethereum's measurement to Robinhood the
   * instant the chain was switched — and the pager sizes itself from these numbers, so the new
   * network's pages were laid out against the old one's.
   */
  const [pageH, setPageH] = useState<Record<string, number>>({});
  const hkey = (id: string) => `${network}:${id}`;
  const pages = watch.lists;
  const activeIdx = Math.max(0, pages.findIndex((l) => l.id === watch.activeId));
  const pickList = (id: string) => {
    watch.select(network, id);
    const i = pages.findIndex((l) => l.id === id);
    if (i >= 0 && pageW > 0) pagerRef.current?.scrollTo({x: i * pageW, animated: true});
    revealTab(id);
  };
  const onPagerSettle = (x: number) => {
    if (pageW <= 0) return;
    const l = pages[Math.max(0, Math.min(pages.length - 1, Math.round(x / pageW)))];
    if (!l) return;
    if (l.id !== watch.activeId) watch.select(network, l.id);
    revealTab(l.id);
  };
  /**
   * Put the pager back on the active page.
   *
   * A list added or removed while it is mounted leaves it parked on a page that has moved — and so
   * does a change of network, which brings its own lists and its own selection. `pages.length` does
   * not notice that one: both networks can have two lists, and the pager stayed where it was.
   *
   * `pagerX` is set by hand alongside the scroll because the page HEIGHT is interpolated from that
   * value rather than read from the layout, and a programmatic scroll is not guaranteed to emit an
   * onScroll. When it did not, the pager kept the height belonging to whichever page it had been
   * showing — which is how a long watch list ended up clipped to the Assets page's height.
   */
  React.useEffect(() => {
    if (pageW <= 0) return;
    pagerRef.current?.scrollTo({x: activeIdx * pageW, animated: false});
    pagerX.setValue(activeIdx * pageW);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, pages.length, pageW]);
  const knownH = pages.map((l) => pageH[hkey(l.id)]);
  const allKnown = pages.length > 1 && pageW > 0 && knownH.every((h) => h != null);
  const maxH = allKnown ? Math.max(...(knownH as number[])) : 0;
  const pagerStyle = allKnown
    ? {
        height: maxH,
        marginBottom: pagerX.interpolate({
          inputRange: pages.map((_, i) => i * pageW),
          outputRange: (knownH as number[]).map((h) => h - maxH),
          extrapolate: 'clamp' as const,
        }),
      }
    : undefined;

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
          <Pressable onPress={toggleHidden} hitSlop={10}>
            <EyeIcon off={hidden} color={c.subtext} />
          </Pressable>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalValue}>{hidden ? MASK_TOTAL : totalUsd != null ? fmtUsd(totalUsd) : '—'}</Text>
          {/* Holdings distribution, right after the figure it breaks down. Disabled while balances
              are hidden: the sheet would show the very values the eye toggle is masking. */}
          <Pressable
            style={styles.distBtn}
            onPress={() => setShowDistribution(true)}
            disabled={hidden}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityState={{disabled: hidden}}
            accessibilityLabel={t('mobile.trade.distribution')}>
            <Svg width={24} height={24} viewBox="0 0 24 24">
              {/* Two-tone solid pie: the faint full circle is the whole, the accent sector a slice. */}
              <Circle cx={12} cy={12} r={9} fill={c.subtext} fillOpacity={0.22} />
              <Path d="M12 12 L12 3 A9 9 0 0 1 17.3 19.3 Z" fill={hidden ? c.border : c.accent} />
            </Svg>
          </Pressable>
        </View>
        <View style={styles.actions}>
          {([
            {label: t('vault.send'), icon: 'send', onPress: () => nav.navigate('Payments')},
            {label: t('vault.receive'), icon: 'receive', onPress: () => setReceiveOpen(true)},
            {label: t('mobile.app.history'), icon: 'history', onPress: () => nav.navigate('Transactions')},
            // v1.0.3 vaults have no pending-changes surface.
            ...(legacy ? [] : [{label: t('mobile.vault.timelock_page'), icon: 'pending', onPress: () => nav.navigate('PendingChanges')}] as const),
          ] as const).map((a) => (
            <Pressable key={a.icon} style={styles.action} onPress={a.onPress}>
              <View style={styles.actionCircle}>
                <ActionIcon name={a.icon} color={c.accent} />
                {a.icon === 'pending' && pendingCount > 0 ? (
                  <View style={styles.actionBadge}>
                    <Text style={styles.actionBadgeText}>{pendingCount}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.actionLabel}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/**
        * The lists, scrolling sideways, then "hide 0" pinned at the end.
        *
        * A tap selects, a tap on the one already in front opens the directory to edit what is on
        * it, and the + makes another. The row scrolls on its own so a dozen lists do not squeeze
        * the control beside them; `hide 0` sits outside the scroller because it is about the rows
        * below, not about which list is in front.
        */}
      <View style={styles.listHead}>
        <ScrollView
          ref={tabsRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabScroll}
          contentContainerStyle={styles.tabRow}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onLayout={(e) => (tabViewW.current = e.nativeEvent.layout.width)}
          onScroll={(e) => (tabScrollX.current = e.nativeEvent.contentOffset.x)}>
          {watch.lists.map((l) => {
            const on = l.id === watch.activeId;
            return (
              <Pressable
                key={l.id}
                hitSlop={8}
                accessibilityRole="button"
                onLayout={(e) => {
                  const {x, width} = e.nativeEvent.layout;
                  tabBox.current[l.id] = {x, w: width};
                }}
                /** A tap selects the list; a tap on the one already in front opens it for editing. */
                onPress={() => {
                  if (!on) return pickList(l.id);
                  nav.navigate('Watchlist');
                }}>
                <Text style={[styles.listTitle, on && styles.listTitleOn]}>
                  {watchListLabel(
                    l,
                    isAssetsList(l.id)
                      ? t('mobile.home.all_assets')
                      : t('mobile.home.watch_list_n', {n: watchListNumber(watch.lists, l.id)}),
                  )}
                </Text>
              </Pressable>
            );
          })}
          {/* Straight to the list, unnamed. Asking for a name in a sheet first made the first
              thing a new list demanded be the least interesting thing about it — the page it opens
              has the name as a field at the top and the assets underneath, which is where both
              questions actually get answered. */}
          <Pressable
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.home.new_list')}
            onPress={() => {
              // No list yet: the page opens on a draft and the first tick creates it. Creating it
              // here meant the Overview gained an empty list and, if the visit starred nothing,
              // visibly lost it again on the way back.
              beginDraft();
              nav.navigate('Watchlist');
            }}>
            <Text style={styles.listAdd}>＋</Text>
          </Pressable>
        </ScrollView>
      </View>
      <View onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
        {pageW > 0 ? (
          <Animated.ScrollView
            ref={pagerRef as never}
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            // One list, nothing to swipe to; and a row held for dragging owns the gesture.
            scrollEnabled={pages.length > 1 && !dragging}
            nestedScrollEnabled
            style={pagerStyle}
            onScroll={Animated.event([{nativeEvent: {contentOffset: {x: pagerX}}}], {useNativeDriver: false})}
            scrollEventThrottle={16}
            onMomentumScrollEnd={(e) => onPagerSettle(e.nativeEvent.contentOffset.x)}>
            {pages.map((l) => (
              <View key={l.id} style={{width: pageW}}>
                <View
                  onLayout={(e) => {
                    // The layout event is recycled before a state updater runs.
                    const h = e.nativeEvent.layout.height;
                    const k = hkey(l.id);
                    setPageH((prev) => (prev[k] === h ? prev : {...prev, [k]: h}));
                  }}>
                  <AssetList
                    rows={rowsForList(l.id)}
                    loading={bal.loading && !bal.balances}
                    error={bal.error}
                    hidden={hidden}
                    markets={!isAssetsList(l.id)}
                    reorder={!isAssetsList(l.id)}
                    stats={marketStats}
                    onTrade={tradeFor}
                    onReorder={(symbols) => saveOrder(network, symbols)}
                    onDragging={setDragging}
                  />
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

      {/* How the vault's holdings are distributed across assets — a donut and a legend, dust (under
          a dollar) left out so it does not clutter the picture. */}
      <Sheet
        visible={showDistribution}
        title={t('mobile.trade.distribution')}
        onClose={() => setShowDistribution(false)}
        height={Math.round(screenHeight * 0.618)}>
        <View style={{marginTop: 16}}>
          <PortfolioPie slices={distribution.held} total={distribution.total} />
        </View>
      </Sheet>
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
  totalValue: {color: c.text, fontSize: 34, fontWeight: '800'},
  actions: {flexDirection: 'row', justifyContent: 'space-around', marginTop: 16, paddingTop: 18, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  action: {alignItems: 'center', gap: 8},
  actionCircle: {width: 54, height: 54, borderRadius: 27, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center'},
  actionLabel: {color: c.text, fontSize: 13, fontWeight: '600'},
  actionBadge: {position: 'absolute', top: -2, right: -2, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center'},
  actionBadgeText: {color: '#fff', fontSize: 12, fontWeight: '700'},
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
  // Inset to the cards' own content, not to the page: "Watch list" and "hide 0" line up with
  // "Total value" and the eye in the hero card above, which is the row this one echoes. At 4 they
  // hung off both edges, further out than anything they sit over.
  listHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: -6},
  // The total value and the distribution pie icon beside it, on one line in the hero card.
  totalRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2},
  distBtn: {flexShrink: 0},
  // The same weight and colour as "hide 0" across from it: the two ends of this row are both
  // labels on the list below, not a heading over a control. The one in front takes the text
  // colour, which is the only thing distinguishing it — a pill or an underline would make the row
  // heavier than the list it labels.
  listTitle: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  listTitleOn: {color: c.text},
  /**
   * flexShrink lets the scroller give way to "hide 0" rather than pushing it off the row.
   *
   * The gap belongs on the SCROLLER, not inside it: content padding scrolls away with the content,
   * so with enough lists to fill the row the last chip slid right up against "hide 0" and the two
   * read as one run of text. A margin holds the gap open whatever the scroll position; the small
   * padding inside is just so the ＋ is not flush to the edge it scrolls past.
   */
  tabScroll: {flexGrow: 0, flexShrink: 1, marginRight: 18},
  tabRow: {flexDirection: 'row', alignItems: 'center', gap: 16, paddingRight: 4},
  // The row's own grey, like the list names and "hide 0" beside it. In accent it was the loudest
  // thing on a line of labels, and the one thing on it nobody needs to find in a hurry.
  listAdd: {color: c.subtext, fontSize: 15, fontWeight: '600'},
  listCard: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 4},
  list: {gap: 0},
  // Indented to the asset NAME, not its icon: a 28pt icon and the cell's 10pt gap above it.
  legs: {paddingLeft: 38, paddingBottom: 12, gap: 8},
  legRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  legLabel: {flex: 1, color: c.subtext, fontSize: 13},
  legAmt: {color: c.text, fontSize: 13, fontVariant: ['tabular-nums']},
  legEarned: {color: c.success, fontSize: 12},
  // Sized to the icon and the name, never to the cell: the gap to its right is the row's.
  badge: {width: 28, height: 28, borderRadius: 14, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center'},
  badgeText: {color: c.subtext, fontSize: 10, fontWeight: '700'},
  chev: {color: c.subtext, fontSize: 18, width: 16, textAlign: 'right'},
  // The card's padding frames the list: the last row (or its open details) adds no bottom padding,
  // so the space below the last asset equals the space above the header.
  depositBtn: {backgroundColor: c.accent, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 2},
  depositText: {color: c.onAccent, fontSize: 14, fontWeight: '700'},
});

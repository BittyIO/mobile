import {useHeaderHeight} from '@react-navigation/elements';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList, TradeParams} from '@/App';
import {BottomTabBarHeightContext} from '@react-navigation/bottom-tabs';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Alert, Animated, Keyboard, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type TextStyle} from 'react-native';
import Svg, {Circle, Ellipse, Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {TradeMenu} from '@/components/TradeMenu';
import {WatchlistMenu} from '@/components/WatchlistMenu';
import {ProtocolChip} from '@/components/ProtocolIcon';
import {ammAdapters, intentAdapters, venueNames, isNamedProtocol} from '@/core/protocols';
import {fetchVaultVersions, currentServices, type VaultVersionsCatalog} from '@/vault/versions';
import {isAssetsList, useFavorites, useWatchLists, watchListLabel, watchListNumber} from '@/core/favorites-store';
import {useWatchDraft} from '@/core/watch-draft';
import {Amount} from '@/components/Amount';
import {ConfirmButton} from '@/components/Button';
import {PercentSlider} from '@/components/PercentSlider';
import {ClearBtn} from '@/components/ClearBtn';
import {FundRow} from '@/components/FundRow';
import {useEndCaret} from '@/components/useEndCaret';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {showTx, showToast, ToastHost} from '@/components/Toast';
import {PickerSheet} from '@/components/AssetPicker';
import {PriceChart} from '@/components/PriceChart';
import {CategoryTabs} from '@/components/ui';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {positionToken} from '@/vault/position-token';
import {susdsRate} from '@/vault/yielding';
import {LIMIT_APP_DATA_HASHES} from '@/core/cow';
import {usePrices} from '@/vault/usePrices';
import {getFlag, setFlag, getPref, setPref, SHOW_OTHER_ORDERS, LAST_PAIR} from '@/core/prefs';
import {usdValue, fmtUsd} from '@/core/prices';
import {balanceOfSymbol} from '@/vault/read';
import {FEE_WETH, resolveFeeReserve, reserveHeld, useWethFeeCoin} from '@/vault/stableCoinAsGas';
import {FINISHED_WINDOWS, finishedSince, setSlippageBps, slippageBps, useFinishedWindow, type FinishedWindow} from '@/core/prefs';
import {relayGasFor} from '@/vault/fee-quote';
import {intentPrepCalls, needsRelayerApproval} from '@/vault/limit';
import {Sheet} from '@/components/Sheet';
import {FormSheet} from '@/components/FormSheet';
import {AvailableLine} from '@/components/AvailableLine';
import {OrderRow, OrderDetailLines, fmtPrice, type OrderPart, type OrderValue} from '@/components/OrderRow';
import {describeOrder} from '@/vault/tx-actions';
import {useConfirmAction, useConfirmLocal} from '@/components/ConfirmAction';
import {fetchProtocolApy, EMPTY_APY, type ProtocolApy} from '@/vault/apy';
import {marketSell, buildMarketSell, poolSpotPrice, quotePreview} from '@/vault/trade';
import {PositionPanel} from '@/components/PositionPanel';
import {AssetPickRow} from '@/components/AssetPickRow';
import {fetchPosition, type Position} from '@/vault/position';
import {placeUniswapXLimit, uniswapXAdapter, UniswapXNoQuoteError} from '@/vault/uniswapx';
import {placeLimitOrder, prepareIntent, cancelLimitOrders, fetchRecentOrders, type CowOrder} from '@/vault/limit';
import {cancelledAt, cancelledAtAny, recordCancelled} from '@/vault/cancel-log';
import {placeTwap, fetchTwapSchedules, cancelTwap, type TwapSchedule} from '@/vault/twap';
import {
  effectiveStatus,
  fmtIn,
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
import {relayVaultMulticall, type VaultCall} from '@/vault/relay';
import {VAULT_DEFI_ABI} from '@/core/abi';
import {fetchTrades, type MarketTrade} from '@/vault/market-trades';
import {attemptTrade, reportFailedAttempt, useVaultAttempts} from '@/vault/attempts';
import {adapterByName} from '@/core/protocols';
import {ASSET_CATEGORIES, ammLiquidKnown, assetCategory, assetMeta, isAmmLiquid, isKnownAsset, underlyingOf, type AssetCategory} from '@/core/assets';
import {fmtNum, fmtShort, displaySymbol, floor6, round6} from '@/core/format';
import {formatUnits, parseUnits, type Address} from 'viem';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useAssetPick} from '@/core/asset-pick';
import {activeVaultAddress, useActiveVaultAddress} from '@/core/active-vault';
import {useAllowancesOff} from '@/vault/risk';

/**
 * What a market swap may fill from its quote before the router refuses it.
 *
 * The owner's, not the app's — see {slippageBps}. A liquid pair fills inside a tenth of a
 * percent and a thin one can need several, so a single figure was either refusing good fills or
 * accepting bad ones depending on what was being traded.
 */
const SLIPPAGE_CHOICES = [10, 50, 100, 200, 500];
type Mode = 'Market' | 'Limit' | 'TWAP';

/** The three places a market order can draw on, ticked one by one in the source sheet. */
type FundKey = 'vault' | 'sky' | 'aave';
const FUND_KEYS: FundKey[] = ['vault', 'sky', 'aave'];
type Side = 'buy' | 'sell';
// The asset-directory categories, plus a synthetic "selected" tab that lists what is already on
// the watch list (so it can be unticked without finding each row down the real categories).
type DirCategory = AssetCategory | 'selected';
/**
 * The two tabs this screen shows. Cancelled orders are not among them — an order that never
 * happened is a thing you look up, not something that belongs beside the orders you are managing,
 * so the whole of it lives on the pushed Order History instead.
 */
/**
 * The two lists the panel offers.
 *
 * `recent` replaced `finished`, and it is a different question rather than a rename. "Finished"
 * asked the reader to know whether an order was finished — and for half of what sits in that list
 * nobody can: a TWAP one slot into twelve is neither done nor undone, an attempt that failed never
 * started, a partially filled limit order is both. So the tab stopped sorting by outcome and
 * started sorting by time: everything that happened lately, newest first, with each row saying for
 * itself how it ended.
 */
type Tab = 'open' | 'recent';
// "Valid for" presets, shared by Limit and TWAP. Keyed by seconds so switching modes keeps the
// selection consistent. The label is `n` + the translated unit abbreviation ("1D", "7D").
const DAY = 'vault.day_abbrev';
const VALID_PRESETS = [
  {n: 1, unit: DAY, s: 86400},
  {n: 7, unit: DAY, s: 604800},
  {n: 30, unit: DAY, s: 2592000},
  {n: 180, unit: DAY, s: 15552000},
];
/** A year. CoW will not hold an order beyond its own horizon, and neither should the field. */
const MAX_VALID_DAYS = 365;


// CoW's partner fee is baked into the on-chain amounts (buy grosses up the sell side; sell discounts the
// buy side); back it out so the displayed price matches what the user entered. Display-only.
const PARTNER_FEE = 0.002;

const fmtN = fmtNum;
/** Trim to token-sized precision, so a split never carries float noise into a withdrawal. */
/** The Buy / Sell bar's own height: 14 of top padding, a 50pt button, 18 of bottom padding. */
const BAR_HEIGHT = 82;
// Short amount for the quote box's Min received. Like fmtShort (which truncates, so a floor is never
// overstated), but a sub-0.01 value shows 3 significant digits instead of fmtShort's 7-decimal tail.
const fmtQuote = (n: number): string =>
  Math.abs(n) >= 0.01 || n === 0 ? fmtShort(n) : Number(n.toPrecision(3)).toString();
// The Bitty fee, to 2 significant figures — so a small fee keeps its meaning ("0.012", not the
// "0.01" a 2-decimal cap rounds it to) while a larger one still reads with 2 decimals like other
// amounts. It is an informational figure, so rounding (rather than truncating) is fine here.
const fmtFee = (n: number): string =>
  n === 0 ? '0' : Math.abs(n) >= 1 ? fmtShort(n) : Number(n.toPrecision(2)).toString();

/**
 * The watch list's name, as the screen's title, editable in place.
 *
 * Its own component, subscribing to the store itself, for one reason: the header is set through
 * `navigation.setOptions`, and an inline arrow passed there is a NEW element type on every call —
 * React would unmount and remount the field, losing the caret on each keystroke. A stable
 * component set once keeps its focus while the name changes underneath it.
 *
 * "Assets" is not a name anyone chose, so there it is plain text.
 */
function WatchlistTitle({network}: {network: Network}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const watch = useWatchLists(network);
  /**
   * A draft has no list to read a name off, and nothing to rename.
   *
   * The typed name is held in the draft store until the first tick creates the list, which is
   * what makes naming-before-adding work. Subscribed here rather than passed in: this component
   * is set once through `setOptions` so typing cannot remount it.
   */
  const drafting = useWatchDraft((st) => st.drafting);
  const draftName = useWatchDraft((st) => st.name);
  const setDraftName = useWatchDraft((st) => st.setName);
  const builtIn = !drafting && isAssetsList(watch.active?.id);
  // One past the lists that already exist, since this one is not among them yet.
  const draftNumber = watch.lists.filter((l) => !isAssetsList(l.id)).length + 1;
  const fallback = drafting
    ? t('mobile.home.watch_list_n', {n: draftNumber})
    : builtIn
      ? t('mobile.home.all_assets')
      : t('mobile.home.watch_list_n', {n: watchListNumber(watch.lists, watch.active?.id ?? '')});
  if (builtIn) return <Text style={styles.navTitle}>{fallback}</Text>;
  return (
    <TextInput
      style={styles.navTitleInput}
      value={drafting ? draftName : watch.active?.name ?? ''}
      onChangeText={(v) => (drafting ? setDraftName(v) : watch.active && watch.rename(network, watch.active.id, v))}
      placeholder={fallback}
      placeholderTextColor={c.subtext}
      maxLength={24}
      returnKeyType="done"
      textAlign="center"
      selectTextOnFocus
    />
  );
}


/**
 * Trade — the market directory on the tab; on the pushed pair screen the chart, the ORDERS list
 * Cancelled). A fixed Buy/Sell bar sits at the bottom; pressing either opens the order form as a bottom
 * sheet (Market / Limit / TWAP) pre-set to that side. Market swaps via Uniswap V3; Limit/TWAP post CoW
 * intents (relayer approved once per sell token). All relayed, signed on-device.
 */
/** Quick fractions of a source, the shortcut people reach for instead of typing a number. */
/**
 * Text with the searched-for run picked out in the accent, so a result says WHY it matched — a hit
 * on a company name is otherwise indistinguishable from one on the ticker beside it.
 *
 * One occurrence, the first, which is the one the ranking sorted on.
 */
function Highlight({
  text,
  q,
  style,
  numberOfLines,
}: {
  text: string;
  q: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const c = useColors();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {text.slice(0, i)}
      <Text style={{color: c.accent}}>{text.slice(i, i + q.length)}</Text>
      {text.slice(i + q.length)}
    </Text>
  );
}

/** Magnifier / clear, drawn on the same 24×24 grid as the tab icons. */
function SearchIcon({open, color, size = 20}: {open: boolean; color: string; size?: number}) {
  const c = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {open ? (
        <Path d="M6 6l12 12M18 6 6 18" {...c} />
      ) : (
        <>
          <Circle cx={11} cy={11} r={7} {...c} />
          <Path d="M20 20l-4.3-4.3" {...c} />
        </>
      )}
    </Svg>
  );
}

export function TradeScreen() {
  const headerHeight = useHeaderHeight();
  // Read through the context, not the hook: this screen is also PUSHED from the Overview, and
  // there it sits outside the tab navigator, where the hook throws. No bar means no gap to leave.
  const tabBarHeight = React.useContext(BottomTabBarHeightContext) ?? 0;
  const {t, company, words, language} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const unlocked = useWallet((s) => s.unlocked);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);

  /**
   * The server's service catalog, for protocol NAMES the vendored registry cannot supply.
   *
   * Same source the Allow list reads, cached per network by the client, so this costs one
   * request per network per launch.
   */
  const [versions, setVersions] = useState<VaultVersionsCatalog | null>(null);
  useEffect(() => {
    let live = true;
    fetchVaultVersions(network).then((v) => live && setVersions(v));
    return () => {
      live = false;
    };
  }, [network]);
  const services = useMemo(() => currentServices(versions), [versions]);
  // Also what `pairAmmLiquid` below is read from (each row carries its guard category), so this
  // re-renders when the answer to "does this pair get a Market tab" lands.
  const assets = useAssetCatalog(network);
  const stables = useMemo(() => assets.filter((a) => a.kind === 'stable'), [assets]);

  // The tab has no params, so it starts from the pair last traded — reopening on a default while
  // the user has been watching one asset all week is a small, daily annoyance.
  const [lastBase, lastQuote] = (getPref(LAST_PAIR) ?? '').split('/');
  const [baseSym, setBaseSym] = useState(
    (lastBase && assets.some((a) => a.symbol === lastBase) ? lastBase : null) ??
      assets.find((a) => a.kind !== 'stable')?.symbol ??
      'WETH',
  );
  const rememberedQuote = lastQuote && stables.some((a) => a.symbol === lastQuote) ? lastQuote : null;
  const [quoteSym, setQuoteSym] = useState(rememberedQuote ?? stables[0]?.symbol ?? 'USDC');
  /**
   * Whether the quote on screen is a CHOICE or the app's own guess.
   *
   * A guess is corrected once balances land (see `preferredQuote` below). The pair last traded, a
   * pair handed over by another screen, and a pick from the sheet are all choices, and a choice is
   * never moved out from under the user — not even to a coin they hold more of.
   */
  const quoteChosen = useRef(rememberedQuote != null);
  /**
   * A network switch keeps the pair only where both sides exist there.
   *
   * Robinhood has no USDC or USDT, so a USDC quote becomes USDG on arrival and USDG becomes USDC
   * again on the way back; a base the new network lacks falls back to its first non-stable asset.
   *
   * Keyed on the CATALOG, not on the network. The catalog is fetched, so for a frame or two after
   * the switch `stables` is still the old chain's list — and a check that runs then asks "is USDC
   * one of this network's stablecoins" of the network being left, which answers yes. Depending on
   * `network` alone, that was the only time it ever ran: switching to Robinhood kept USDC, and
   * switching back to Sepolia kept the USDG it had eventually been given, each wrong pair outliving
   * the chain it belonged to. Re-running when the list lands is what actually corrects it.
   *
   * Joined symbols rather than the arrays themselves: `useAssetCatalog` hands back a new array on
   * every render, and the question here is only which tickers are in it.
   */
  const assetKey = assets.map((a) => a.symbol).join(',');
  const stableKey = stables.map((a) => a.symbol).join(',');
  useEffect(() => {
    // Nothing to check against yet. An empty catalog answers "no" to everything, which would reset
    // a perfectly good pair to WETH on every cold launch.
    if (assets.length === 0) return;
    if (!assets.some((a) => a.symbol === baseSym)) setBaseSym(assets.find((a) => a.kind !== 'stable')?.symbol ?? assets[0]?.symbol ?? 'WETH');
    // Provisional: the new network's balances are not in yet, so `preferredQuote` cannot run here.
    // Clearing the flag is what lets it correct this once they are.
    if (!stables.some((s) => s.symbol === quoteSym)) {
      quoteChosen.current = false;
      setQuoteSym(stables[0]?.symbol ?? 'USDC');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, assetKey, stableKey]);
  /**
   * A pair handed over by another screen — tapping an asset on the Overview opens Trade on it.
   *
   * Applied on arrival and whenever the parameters change, so tapping a second asset while Trade is
   * already the visible tab moves the pair rather than being ignored. Each side is checked against
   * the network's own catalog first: a stale pair from a previous network must not strand the
   * screen on an asset that does not exist here.
   */
  /**
   * One component, two screens.
   *
   * Both the TAB and the PUSHED copy are the trading screen for one pair — chart, orders, Buy and
   * Sell. The tab opens on the pair last traded; a push names its own. Keeping them in one file
   * means the pair UI has a single definition.
   *
   * The third route, Watchlist, is the odd one: the same asset directory with no prices and a star
   * on every row, pushed from the Overview to choose what that list holds. The question there is
   * which assets to keep, not what they cost, and a price beside a star invites a tap that would
   * leave the screen.
   */
  const route = useRoute();
  const routeName = route.name;
  const isWatchlist = routeName === 'Watchlist';
  const isPair = !isWatchlist;
  const toggleFavorite = useFavorites((st) => st.toggle);
  /**
   * The watch list this page is editing — always the one the Overview has in front.
   *
   * The page is reached by tapping that list's own name, so "which list am I starring onto" is
   * never a question it has to ask. Renaming and deleting live here for the same reason: this is
   * the page about the list, where the Overview's row is only the way to choose one.
   */
  const watch = useWatchLists(network);
  const builtIn = isAssetsList(watch.active?.id);
  const drafting = useWatchDraft((st) => st.drafting);
  const draftName = useWatchDraft((st) => st.name);
  const endDraft = useWatchDraft((st) => st.end);
  // A draft is empty by definition — the previously active list's ticks are not this list's.
  const onList = new Set(drafting ? [] : watch.active?.symbols ?? []);
  /**
   * The first tick is what creates the list.
   *
   * `add` writes the name typed into the nav bar and selects the new list in the same call, so
   * the `toggle` straight after it lands on the right one — the store is read through `get()`,
   * not through this render's snapshot.
   */
  const star = (symbol: string) => {
    if (drafting) {
      watch.add(network, draftName);
      endDraft();
    }
    toggleFavorite(network, symbol);
  };
  /** What an unnamed list is called: "Assets" for the built-in one, "Watch list #2" for the rest. */
  const listFallback = builtIn
    ? t('mobile.home.all_assets')
    : t('mobile.home.watch_list_n', {n: watchListNumber(watch.lists, watch.active?.id ?? '')});
  const listName = watchListLabel(watch.active, listFallback);

  /**
   * The list's name IS the screen's title, and deleting it is the bar button beside it.
   *
   * Set once per route, not per render: the title is a focused text field while it is being
   * edited, and re-supplying `headerTitle` with a fresh inline component would remount it and
   * swallow the caret. `WatchlistTitle` subscribes to the store itself so the header updates
   * without the options being set again.
   */
  useEffect(() => {
    if (!isWatchlist) return;
    nav.setOptions({headerTitle: () => <WatchlistTitle network={network} />});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWatchlist, network]);
  /**
   * The ⋯ menu, as the bar's right-hand item — the same shape the Trade screen uses.
   *
   * It was a bare bin, which handed the one destructive action on the page the most prominent
   * spot in the bar and left nowhere to put anything else. The menu holds Share and Delete, and
   * the confirmation still lives here: the menu asks, this screen does.
   */
  // A draft is not on the Overview yet, so there is nothing to remove or to share.
  const canDelete = !builtIn && !drafting && watch.lists.length > 1;
  const listSymbols = watch.active?.symbols ?? [];
  /**
   * Star a shared list's tickers onto the one in front, and report how many were recognised.
   *
   * Matched against THIS network's catalog, by the symbol as stored and as displayed — a shared
   * "ETH" has to find WETH, which is what the row is labelled. Already-starred tickers are
   * skipped rather than toggled off, so importing a list that overlaps the current one adds to
   * it instead of punching holes in it. Zero means nothing matched, and the sheet says so rather
   * than closing on a no-op.
   */
  const importSymbols = (incoming: string[]): number => {
    const want = new Set(incoming.map((x) => x.toUpperCase()));
    // A draft holds nothing yet; the list in front belongs to whatever was open before it.
    const already = new Set(drafting ? [] : watch.active?.symbols ?? []);
    const hits = assets.filter(
      (a) =>
        !already.has(a.symbol) &&
        (want.has(a.symbol.toUpperCase()) || want.has(displaySymbol(a.symbol).toUpperCase())),
    );
    if (hits.length === 0) return 0;
    // An import is a first tick like any other: it is what creates the list.
    if (drafting) {
      watch.add(network, draftName);
      endDraft();
    }
    hits.forEach((a) => toggleFavorite(network, a.symbol));
    return hits.length;
  };
  useEffect(() => {
    if (!isWatchlist) return;
    nav.setOptions({
      /**
       * No ⋯ on "Assets".
       *
       * That list cannot be renamed, shared or deleted — it is the vault's own holdings, not a
       * list anyone made — which left the menu holding one row, Import, behind a tap. A menu with
       * one item in it is a worse version of the item. The curated lists keep theirs.
       *
       * A DRAFT always gets the button, whatever list was in front when it started. `builtIn`
       * reads the still-active list, which is "Assets" for anyone who hit New list from there —
       * so the one page that most wants an importer, a list with nothing on it yet, was the one
       * page with no way to reach one.
       */
      headerRight: builtIn && !drafting
        ? undefined
        : () => (
        <WatchlistMenu
          label={listName}
          symbols={listSymbols}
          canDelete={canDelete}
          canShare={!builtIn}
          onDelete={() =>
            confirm({
              title: t('mobile.home.delete_list'),
              message: t('mobile.home.delete_list_msg', {name: listName}),
              action: t('mobile.home.delete_list'),
              danger: true,
              run: () => {
                if (watch.active) watch.remove(network, watch.active.id);
                nav.goBack();
              },
            })
          }
          onImport={importSymbols}
          importOnly={drafting}
        />
      ),
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWatchlist, canDelete, builtIn, drafting, listName, listSymbols.join(','), network]);

  /**
   * An abandoned draft is just forgotten.
   *
   * Nothing was created, so there is nothing to delete and the Overview never saw it — which is
   * the whole point of deferring creation to the first tick.
   */
  useEffect(() => {
    if (!isWatchlist) return;
    return () => endDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWatchlist]);

  /**
   * The ⋯ menu, for every route this screen serves except the watch list.
   *
   * Set here rather than in the navigator because it needs the base asset, which only this screen
   * knows — and because the same component has to carry it on the TAB, where the navigator's own
   * `headerRight` is the network switcher, and on the PUSHED pair page, where there is none. One
   * `setOptions` covers both: a tab screen's options win over the navigator's.
   *
   * `TradeMenu` is a module-scope component so the element's type is stable; the arrow rebuilt on
   * each run only changes props, and the open sheet survives.
   */
  useEffect(() => {
    if (isWatchlist) return;
    nav.setOptions({headerRight: () => <TradeMenu symbol={baseSym} stack={routeName === 'TradePair'} />});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWatchlist, baseSym, routeName]);


  const params = useRoute().params as TradeParams;
  const wantBase = params?.base;
  const wantQuote = params?.quote;
  useEffect(() => {
    if (wantBase && assets.some((a) => a.symbol === wantBase)) {
      setBaseSym(wantBase);
      // Arriving on a specific asset (tapped on the Overview) scopes the orders card to this pair,
      // not every pair — so turn "Others" off, as choosing a pair leg does.
      setOthers(false);
    }
    if (wantQuote && stables.some((a) => a.symbol === wantQuote)) {
      quoteChosen.current = true;
      setQuoteSym(wantQuote);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantBase, wantQuote]);

  // Written whenever the pair settles, so the tab reopens on it next launch.
  useEffect(() => {
    if (baseSym && quoteSym) setPref(LAST_PAIR, `${baseSym}/${quoteSym}`);
  }, [baseSym, quoteSym]);

  const [tab, setTab] = useState<Tab>('open');
  /**
   * How far back Finished reaches, set in the ⋯ sheet — see {useFinishedWindow}.
   *
   * Cut by the SAME clock the list is sorted on, which is when each row was placed. Sorting by one
   * time and cutting by another would take rows out of the middle of the list rather than off the
   * end, and a record with holes in it reads as a bug. The cost is that an old order which filled
   * yesterday falls outside a short window; the longer windows are there for exactly that.
   */
  const finishedWindow = useFinishedWindow((s) => s.window);
  const setFinishedWindow = useFinishedWindow((s) => s.setWindow);
  /** The span picker, opened by tapping the Finished tab when it is already the one in front. */
  const [windowOpen, setWindowOpen] = useState(false);

  // Order form (in the bottom sheet)
  const [sheetSide, setSheetSide] = useState<Side | null>(null);
  /**
   * The side the sheet is SHOWING, which outlives `sheetSide`.
   *
   * Closing clears `sheetSide` while the card is still sliding out, and everything the form keyed
   * on it changed halfway through the animation — the confirm button went from Buy's green to
   * Sell's red on its way off screen, which reads as the trade having failed, and a closing BUY
   * sheet flipped its pay leg to the base asset, found no balance of it and printed "exceeds
   * balance" in red under the Total as it left. This keeps the sheet looking like the sheet that
   * was just confirmed until it is actually gone.
   *
   * Declared here, beside the state it stands in for, because the pay leg is derived from it far
   * above the sheet's own markup — keyed on `sheetSide`, that derivation was the one place the
   * flip still got through.
   */
  const lastSide = useRef<Side>('buy');
  if (sheetSide) lastSide.current = sheetSide;
  const shownSide = sheetSide ?? lastSide.current;
  const [mode, setMode] = useState<Mode>('Market');
  // Market trade slippage in 24 hours at $0: the owner turned market trading off (see `marketOk`).
  const tradeVault = useActiveVaultAddress(network);
  const marketOff = useAllowancesOff(tradeVault, network).marketTrades;
  /**
   * Which balance of the PAY asset funds the order: the vault's free balance, its Sky savings, or its
   * Aave supply. Chosen in the order sheet, and it never hides Market — a market swap withdraws from
   * the position and swaps the proceeds in one transaction, and a limit or TWAP order withdraws in
   * the preparation transaction so the tokens are free in the vault when a solver settles it.
   */
  const [spendSource, setSpendSource] = useState<'free' | 'yield' | 'lend'>('free');
  const [amount, setAmount] = useState('');
  /**
   * Where a market order's money comes from: a tick per source, and how much of it to take.
   *
   * Only the vault is ticked to begin with, so the order's available balance is the vault's balance
   * until the user says otherwise. Ticking a source makes its WHOLE balance available and fills the
   * row with it; the percentages and the field then take less without changing what is available.
   */
  const [fundOn, setFundOn] = useState<Record<FundKey, boolean>>({vault: true, sky: false, aave: false});
  const [fundAmt, setFundAmt] = useState<Record<FundKey, string>>({vault: '', sky: '', aave: ''});
  const [receiveInput, setReceiveInput] = useState('');
  const [price, setPrice] = useState('');
  const [priceEdited, setPriceEdited] = useState(false);
  const [parts, setParts] = useState('10');
  const [validSec, setValidSec] = useState(86400); // 1D — the first preset in both sets
  /**
   * A typed validity in days, empty whenever a preset is the active answer.
   *
   * Kept beside `validSec` rather than derived from it, so the field shows what was typed and the
   * chips can still light up for the values they cover. CoW rejects an order that has already
   * expired and caps how far ahead one may sit, so the days are clamped to a sane band.
   */
  const [validDays, setValidDays] = useState('');
  /**
   * The chip to fall back to when the days field is left empty.
   *
   * Clearing the field used to leave the row with NOTHING lit: `validDays` was empty, so the chips
   * stopped claiming the value, while `validSec` still held the custom one they could not match —
   * so the order carried a validity nothing on screen named. Blurring an empty field now returns to
   * the preset that was last chosen, which is the answer the user can see.
   */
  const lastPreset = useRef(VALID_PRESETS[0].s);
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const [orders, setOrders] = useState<CowOrder[]>([]);
  // Cancelling is a relayed transaction like any other, so it asks first.
  const {ask, sheet: confirmSheet} = useConfirmAction();
  // Nothing on chain, so the system alert rather than the fee sheet — see {useConfirmLocal}.
  const confirm = useConfirmLocal();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancellingAll, setCancellingAll] = useState(false);
  /**
   * Whether a limit or TWAP order still needs an on-chain transaction before it can be posted.
   *
   * Almost always it does not: once the vault has a CoW clone, the pair allowlisted and the sell
   * token approved to the settlement relayer, signing an order is entirely off-chain and costs
   * nothing. Read from the chain rather than remembered for the life of the screen, which is what
   * made the app re-approve an already-approved token after every restart.
   */
  const [intentSetup, setIntentSetup] = useState<{needed: boolean; approve: boolean} | null>(null);
  /**
   * Which rows are open, as a SET of keys rather than one id.
   *
   * It held a single id, so opening any row closed whichever was already open — two orders could
   * never be read side by side, and a tap meant to open one silently folded away another the user
   * was still looking at. The open orders and the market trades below them share this state; their
   * keys are an order uid and a transaction hash, which cannot collide.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** The TWAP schedule whose "everything else" sheet is open, by appData. */
  const [twapInfo, setTwapInfo] = useState<string | null>(null);
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  /**
   * Off on arrival. The page is opened on one pair, so the orders under it should be that pair's;
   * seeing every order the vault has ever placed is the exception, and the user asks for it.
   *
   * Once they have asked, it stays asked. Re-ticking the same box on every visit is the kind of
   * small friction that makes a filter feel broken.
   */
  const [showOthers, setShowOthers] = useState(() => getFlag(SHOW_OTHER_ORDERS));
  const setOthers = (v: boolean) => {
    setFlag(SHOW_OTHER_ORDERS, v);
    setShowOthers(v);
  };
  const toggleOthers = () => setOthers(!showOthers);
  const [marketTrades, setMarketTrades] = useState<MarketTrade[]>([]);
  /**
   * When each filled limit/TWAP part was settled, by order uid.
   *
   * Two sources, because neither has both halves: CoW says which transaction filled an order and
   * never when, the transfer feed says when a transaction happened and does not know about orders.
   */
  const [fillAt, setFillAt] = useState<Map<string, number>>(() => new Map());
  /** Order uid → when the transaction that cancelled it landed. See {cancelTimes}. */
  const [cancelAt, setCancelAt] = useState<Map<string, number>>(() => new Map());

  const balances = useVaultBalances(network);
  const weth = useWethFeeCoin(network, balances.vault);
  const positions = useVaultPositions(balances.vault, network);

  /**
   * The stablecoin to quote in when the app is choosing: one the vault actually HOLDS, USDC first.
   *
   * Quoting in a coin with a zero balance opens a dead screen — Max is 0, Buy has nothing to spend,
   * and the first thing the user has to do is swap into the quote before they can use it. USDC
   * leads because it is the deepest side of nearly every pool here; any other held stable beats an
   * empty USDC, and if the vault holds no stablecoin at all the catalog order decides, as before.
   */
  const preferredQuote = (exclude?: string): string | undefined => {
    const held = (sym: string) => Number(balanceOfSymbol(balances.balances, sym) || 0) > 0;
    const options = stables.map((a) => a.symbol).filter((sy) => sy !== exclude);
    return (
      options.find((sy) => sy === 'USDC' && held(sy)) ??
      options.find(held) ??
      options.find((sy) => sy === 'USDC') ??
      options[0]
    );
  };

  /**
   * Correct the opening guess once the balances arrive.
   *
   * The first frame knows nothing about what the vault holds — the state initialiser runs before
   * the balance read — so the quote starts as the catalog's first stablecoin and is moved here to
   * one with something in it. Runs once: the flag is set before the move, so a later refresh that
   * changes which coins are held does not reshuffle the pair while the user is looking at it.
   */
  useEffect(() => {
    if (quoteChosen.current || !balances.balances) return;
    quoteChosen.current = true;
    const want = preferredQuote(baseSym);
    if (want) setQuoteSym(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balances.balances]);
  // Pull-to-refresh: re-reads prices, the pool quote, the chart, balances and orders together.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [pulled, setPulled] = useState(false);
  const prices = usePrices(network, refreshNonce);
  const base = assets.find((a) => a.symbol === baseSym);
  // The intent adapter Limit goes to: CoW, or UniswapX where it stands in for CoW (Robinhood).
  // TWAP is CoW's alone.
  const cowIntent = adapterByName(network, 'CoW Swap');
  const uxIntent = cowIntent ? null : uniswapXAdapter(network);
  const intent = cowIntent ?? uxIntent;

  // The base asset's position + P&L, computed on the server from the vault's swap history. Re-read
  // whenever the asset, network or a pull changes — the panel above the action shows it when the
  // vault actually holds some, so a pair it has never touched carries no empty card.
  //
  // Three states, not two: `undefined` is a fetch still in flight (the sheet shows dashes),
  // `null` is a fetch that answered "nothing" (the sheet shows zeros, which is then true), and a
  // Position is the figures. Collapsing the first two into null painted a full panel of zeros
  // that snapped to the real numbers a beat later — and kept the PREVIOUS asset's figures on
  // screen while a new pair's fetch was still out.
  const [position, setPosition] = useState<Position | null | undefined>(undefined);
  // Whether the full position sheet is open — opened from the Today P&L on the header line.
  const [showPosition, setShowPosition] = useState(false);
  useEffect(() => {
    const vault = balances.vault;
    if (!vault || !baseSym) {
      setPosition(null);
      return;
    }
    let live = true;
    setPosition(undefined);
    fetchPosition(vault, network, baseSym)
      .then((p) => live && setPosition(p))
      .catch(() => live && setPosition(null));
    return () => {
      live = false;
    };
  }, [balances.vault, baseSym, network, refreshNonce]);

  // The vault's whole portfolio value — the SAME figure the Overview shows: every asset's free +
  // yielding + lending holding, priced off the shared catalog prices. The position sheet's pie takes the asset's share against this, so the slice is measured
  // against what the user reads as their portfolio rather than a spot-only subset — and it needs no
  // server round-trip, since the holdings and prices are already loaded here.
  const portfolioValue = useMemo(() => {
    if (!balances.balances) return 0;
    let sum = 0;
    for (const a of assets) {
      const free = Number(balanceOfSymbol(balances.balances, a.symbol) || 0);
      const held = positions.positions
        .filter((p) => p.symbol === a.symbol)
        .reduce((s, p) => s + Number(p.formatted), 0);
      const v = usdValue(free + held, a.symbol, prices);
      if (v != null) sum += v;
    }
    return sum;
  }, [assets, balances.balances, positions.positions, prices]);

  const usdcAsset = useMemo(() => stables.find((s) => s.symbol === 'USDC') ?? stables[0], [stables]);
  const quoteAsset = assets.find((a) => a.symbol === quoteSym);

  // Order-form denomination: you always enter the PAY leg. A sell pays the base (e.g. ETH); a buy pays
  // the quote (e.g. USDC). So the Amount field + Max button sit on a DIFFERENT asset per side.
  const paysBase = shownSide !== 'buy';
  // The asset the pay leg spends. onSubmit re-derives it locally; this is the same thing, needed
  // at render time for the funding rows' APY.
  const spendAsset = paysBase ? base : quoteAsset;
  const spendSym = paysBase ? baseSym : quoteSym;
  const recvSym = paysBase ? quoteSym : baseSym;
  const freeSpend = balanceOfSymbol(balances.balances, spendSym);
  // Held to the field's own six places from here on: see {floor6}. Everything that compares a
  // typed amount against this balance has to be working from the same number.
  const freeNum = floor6(Number(freeSpend));

  // What a MARKET order can reach beyond the free balance. A market swap is one transaction, so the
  // vault can withdraw from a position and swap the proceeds in the same multicall — but only from
  // positions that pay out instantly: Sky savings and an Aave supply. Lido is excluded, its unstake
  // is a multi-day queue. A limit or TWAP order settles later, off-chain, so it can spend only what
  // it is pointed at: the free balance, or the savings share sold as itself.
  const instant = useMemo(() => {
    const sky = positions.positions.find((p) => p.kind === 'staked' && p.protocolName === 'Sky' && p.symbol === spendSym);
    const aave = positions.positions.find((p) => p.kind === 'supplied' && p.symbol === spendSym);
    return {
      sky: sky ? {protocol: sky.protocol, amount: Number(sky.formatted), position: sky} : null,
      aave: aave ? {protocol: aave.protocol, amount: Number(aave.formatted), position: aave} : null,
    };
  }, [positions.positions, spendSym]);

  const sourceAmount = floor6(spendSource === 'yield' ? instant.sky?.amount ?? 0 : spendSource === 'lend' ? instant.aave?.amount ?? 0 : 0);

  /**
   * How much of the spend asset this order must leave in the vault for the relayer's fee.
   *
   * The fee is billed from a vault stablecoin AFTER the call runs, and the coin is picked from what
   * the vault HOLDS — so when the asset being spent is the only funded stablecoin, the fee comes
   * out of the very balance the swap is emptying. Spending all of it made the relay revert at the
   * charge and report `fee-leg-failed`, with nothing wrong with the trade itself.
   *
   * EVERY mode, not just Market. A limit or TWAP order's own transaction is setup and approval,
   * so the fee for THAT is payable from the full balance — which is why this was once gated to
   * market orders. But the balance leaves later, when a solver settles the order, and a maxed
   * limit buy hands CoW every last unit of the only coin the vault can be billed in. The vault
   * wakes up unable to pay for anything, days after the screen that did it was closed, and the
   * only way out is sending money in from outside.
   *
   * Where the reserve comes OFF differs by mode and is handled by {keepBack}: a market order
   * takes it out of the funding caps, since it may also withdraw from a position in the same
   * transaction, while a limit or TWAP order simply holds it back from the free balance.
   */
  const reserve = resolveFeeReserve({
    network,
    vault: balances.vault,
    heldStables: [
      ...stables.map((a) => ({symbol: a.symbol, amount: Number(balanceOfSymbol(balances.balances, a.symbol))})),
      ...(weth ? [{symbol: FEE_WETH, amount: Number(balanceOfSymbol(balances.balances, FEE_WETH) || 0), usd: weth.usd}] : []),
    ],
    spendSymbol: spendSym,
  });
  const feeReserve = reserve.keep;
  /**
   * The float this order may not touch, as ONE row definition for both source sheets.
   *
   * The sheets are different components by design — limit and TWAP pick exactly one source, a
   * market order draws on several and so has a tick and a slider per row — and each has its own
   * inert variant. What they must not have is their own idea of what the row SAYS, which is why
   * the label and the figure are built here and handed to both.
   *
   * Null unless the float is in the coin being spent: a reserve sitting in another stablecoin
   * takes nothing away from this order and has no business in its sheet.
   */
  const reserveRow =
    feeReserve > 0
      ? {
          label: `${displaySymbol(spendSym)} ${t('mobile.trade.fee_reserved')}`,
          // What is held back, not what was asked for — see {reserveHeld}.
          sub: `${fmtNum(reserveHeld(feeReserve, freeNum))} ${displaySymbol(spendSym)}`,
        }
      : null;

  // Paying from the free balance, a market order may also top up from the positions in the same
  // transaction, so its available figure includes them. A named position spends only itself.
  // Either way the reserve comes off the top: offering a Max the relay cannot charge against is
  // offering an order that always fails.
  /**
   * The funding plan: how much of this order is pulled out of each position.
   *
   * Nothing by default, so a market order's available balance is the VAULT's balance and no more.
   * The user opens the source sheet and slides a position in when they want the order to reach
   * further, which withdraws and swaps in the same transaction.
   */
  // The ceiling on each source. The vault's has the relayer's reserve taken off it, so the last of
  // the fee coin can never be spent however far the user pushes the row.
  // Four places, or fewer if the asset has fewer. A raw position balance carries a long float tail
  // and ticking a row wrote it straight into the field as 40.001594; four is short enough to read
  // and still finer than anyone trades to. Flooring rather than rounding also means Max can never
  // ask for more than the position holds, which would fail at the withdrawal.
  const fundDp = Math.min(spendAsset?.decimals ?? 4, 4);
  const fundFloor = (v: number) => Math.floor(v * 10 ** fundDp) / 10 ** fundDp;
  const fundCap: Record<FundKey, number> = {
    vault: Math.max(0, fundFloor(freeNum - feeReserve)),
    sky: fundFloor(instant.sky?.amount ?? 0),
    aave: fundFloor(instant.aave?.amount ?? 0),
  };
  /** What a source is currently contributing to the order. */
  const fundPick = (k: FundKey): number => (!fundOn[k] ? 0 : Math.min(Number(fundAmt[k]) || 0, fundCap[k]));
  const planSky = fundPick('sky');
  const planAave = fundPick('aave');

  const reachable =
    spendSource !== 'free'
      ? sourceAmount
      : mode === 'Market'
        ? // The CAPACITY the ticks unlock, not the amounts chosen inside them: ticking a position
          // is what makes its balance reachable, and how much of it the order takes is a separate
          // question answered by the row. So the figure under the pay input moves on a tick alone.
          FUND_KEYS.reduce((n, k) => n + (fundOn[k] ? fundCap[k] : 0), 0)
        : freeNum;
  // Spending from a named position leaves the free balance alone, so only the shortfall against the
  // reserve has to be held back. Spending from the free balance, the whole reserve comes out of the
  // same pot. Outside a market order the reserve is zero and this is the plain reachable figure.
  const keepBack =
    mode === 'Market' ? 0 : spendSource !== 'free' ? Math.max(0, feeReserve - freeNum) : feeReserve;
  /**
   * Rounded, and rounded with the SAME function the field's Max goes through.
   *
   * Max fills `round6(sum of the chosen sources)` while this held the raw sum, and when that sum's
   * binary form sits a hair under its decimal value the field comes out a millionth ABOVE the
   * ceiling — so pressing Max reported that the amount exceeded the available balance. It is the
   * same noise that printed "10.199999999999999" under the field once Available began showing the
   * figure in full. The inputs are floored to six places (see {floor6}), so this rounding has
   * nothing left to round and cannot name more than the vault holds.
   */
  const spendBal = String(round6(Math.max(0, reachable - keepBack)));
  /**
   * What one source can actually put into a limit or TWAP order.
   *
   * The source sheet listed raw balances while the form deducted the fee float from them, so a row
   * read 9.98 over a field that refused anything above 8.98 — and the inert reserve row underneath
   * then looked like it was being counted twice. Same arithmetic as {keepBack}: the float comes out
   * of the free balance first, and a position gives up only what the free balance cannot cover.
   *
   * The market sheet needs none of this: its rows ARE {fundCap}, which is already net.
   */
  const spendableFrom = (source: 'free' | 'yield' | 'lend', held: number) =>
    round6(Math.max(0, floor6(held) - (source === 'free' ? feeReserve : Math.max(0, feeReserve - freeNum))));


  /**
   * Gas this particular order will burn, so the fee line moves with what the order actually does.
   *
   * A market order is a swap, plus one withdrawal for every position it draws on — which is why
   * funding a trade out of Sky and Aave costs visibly more than spending the free balance. A limit
   * or TWAP order swaps nothing on chain: its transaction is the allowlist and adapter setup that
   * has to be mined before the order can be posted.
   */
  // Live APY for the two positions a market order can draw on, so each funding row says what
  // giving that money up costs. Aave is rated per asset, Sky per adapter.
  const [posApy, setPosApy] = useState<ProtocolApy>(EMPTY_APY);
  useEffect(() => {
    if (!instant.sky && !instant.aave) return;
    let live = true;
    fetchProtocolApy({
      network,
      aaveAssets: instant.aave && spendAsset ? [spendAsset.address as Address] : [],
      skyProtocols: instant.sky ? [instant.sky.protocol] : [],
      lidoProtocols: [],
    })
      .then((a) => live && setPosApy(a))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [network, instant.sky?.protocol, instant.aave?.protocol, spendAsset?.address]);
  const skyApy = instant.sky ? posApy.protocolApy.get(instant.sky.protocol.toLowerCase()) ?? null : null;
  const aaveApy = spendAsset ? posApy.assetApy.get(spendAsset.address.toLowerCase()) ?? null : null;


  /**
   * Change one source and restate the pay amount, so the two always agree. The pay field stays
   * typable; whichever the user touched last is the one that leads.
   */
  const applyFunding = (on: Record<FundKey, boolean>, amt: Record<FundKey, string>) => {
    setFundOn(on);
    setFundAmt(amt);
    const total = round6(
      FUND_KEYS.reduce((n, k) => n + (on[k] ? Math.min(Number(amt[k]) || 0, fundCap[k]) : 0), 0),
    );
    // Through applyPay, not setAmount: it also re-derives the Receive field, which otherwise sat
    // at whatever the previous amount implied until the price happened to move.
    applyPay(total > 0 ? String(total) : '');
  };

  /**
   * The pay field's Max.
   *
   * For a market order the ceiling IS the ticked sources' balances, so maxing the amount has to
   * fill those rows too — otherwise the field jumps to the total while the sheet still shows the
   * old, smaller selection, and the two controls describe different orders. Unticked sources are
   * left alone: Max means all of what you chose to use, not all of everything.
   */
  const maxPay = () => {
    if (mode !== 'Market') return applyPay(spendBal);
    applyFunding(
      fundOn,
      FUND_KEYS.reduce(
        (m, k) => ({...m, [k]: fundOn[k] ? String(fundCap[k]) : ''}),
        {} as Record<FundKey, string>,
      ),
    );
  };

  /** Tick or untick a source: ticking fills the row with everything it holds, unticking empties it. */
  const toggleFunding = (k: FundKey) => {
    const on = {...fundOn, [k]: !fundOn[k]};
    applyFunding(on, {...fundAmt, [k]: on[k] ? String(fundCap[k]) : ''});
  };

  const payTokenAddr = spendAsset?.address as Address | undefined;
  const buyTokenAddr = (paysBase ? quoteAsset : base)?.address as Address | undefined;
  useEffect(() => {
    if (mode === 'Market' || !intent || !owner || !payTokenAddr || !buyTokenAddr) {
      setIntentSetup(null);
      return;
    }
    let live = true;
    const vault = activeVaultAddress(network)!;
    (async () => {
      const approve = await needsRelayerApproval({vault, network, intentProtocol: intent, token: payTokenAddr});
      const calls = await intentPrepCalls({
        vault,
        network,
        intentProtocol: intent,
        tokens: [payTokenAddr, buyTokenAddr],
        approveToken: approve ? payTokenAddr : undefined,
      });
      if (live) setIntentSetup({needed: calls.length > 0, approve});
    })().catch(() => live && setIntentSetup({needed: true, approve: true}));
    return () => {
      live = false;
    };
  }, [mode, intent, owner, network, payTokenAddr, buyTokenAddr]);

  const feeGas = useMemo(
    () =>
      mode === 'Market'
        ? relayGasFor({swap: 1, withdraw: (planSky > 0 ? 1 : 0) + (planAave > 0 ? 1 : 0)})
        : relayGasFor({setup: true}),
    [mode, planSky, planAave],
  );
  /**
   * Three answers, not two: a figure, a zero, or nothing.
   *
   * A market swap is always relayed, so it is always quoted. A limit or TWAP order on a vault that
   * is already set up — adapter cloned, pay token approved to the settlement relayer — is signed
   * and posted off-chain and sends no transaction at all, so the honest figure is $0 and the line
   * now says so. It used to hide instead, which left "free" and "not worked out yet"
   * indistinguishable on the one line whose job is to prevent a surprise.
   *
   * While the probe is still in flight `intentSetup` is null and the cost is genuinely UNKNOWN, so
   * there the line stays hidden rather than claiming a zero it cannot back.
   */
  const feeApplies = mode === 'Market' || intentSetup?.needed === true;
  const feeFree = mode !== 'Market' && intentSetup?.needed === false;
  // Until the balances are in, the figure is unknown — not zero. Showing 0 reads as "you have
  // nothing", so the line shows a dash, Max is withheld, and nothing is flagged as over balance.
  const balKnown = balances.balances != null;
  // More than the vault can pay: flagged as the user types, and the order is not sent.
  const overBalance = balKnown && Number(amount) > 0 && Number(amount) > Number(spendBal);

  // Off-chain oracle price (CoinGecko) — only a fast-loading fallback for the display before the pool
  // quote lands. NEVER used for the trade itself: on a testnet it's the mainnet price and diverges from
  // the pool the swap actually routes through.
  const oraclePrice = useMemo(() => {
    const b = prices.get(baseSym);
    const q = prices.get(quoteSym);
    if (!b) return null;
    return q ? b / q : b;
  }, [prices, baseSym, quoteSym]);

  // Whether BOTH legs are flagged AMM-liquid by the guard. The tokenized stocks are not: a pool may
  // exist for one, but with too little depth to price anything — CRCL's 1% pool quotes ~8% under the
  // market. So for those pairs the pool is ignored entirely, here and in the mode switch.
  const pairAmmLiquid = isAmmLiquid(network, baseSym) && isAmmLiquid(network, quoteSym);

  // Live Uniswap pool price (quote per 1 base) for THIS network's pool — the price the market swap
  // executes at. Re-quoted whenever the pair or network changes.
  const [poolPrice, setPoolPrice] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    setPoolPrice(null);
    if (base && quoteAsset && pairAmmLiquid) {
      poolSpotPrice(network, base.address, quoteAsset.address)
        .then((p) => live && setPoolPrice(p))
        .catch(() => live && setPoolPrice(null));
    }
    return () => {
      live = false;
    };
  }, [network, base?.address, quoteAsset?.address, pairAmmLiquid, refreshNonce]);

  // A pool price only counts when it shares a universe with the oracle. A near-empty pool passes the
  // server's liquidity>0 test yet prices nothing — Sepolia's vault-WETH/USDC pool holds dust and
  // quotes ETH at ~$4 against a ~$2,500 oracle — and showing that as "the price the swap executes at"
  // is a worse error than the oracle, which is right to within the testnet's own spread. So a pool
  // more than ~3x off the oracle is treated as no price at all, the way an illiquid stock pool is.
  // With no oracle to check against, the pool stands on its own, as it did before.
  const livePoolPrice =
    poolPrice != null &&
    (!(oraclePrice != null && oraclePrice > 0) ||
      (poolPrice > oraclePrice / 3 && poolPrice < oraclePrice * 3))
      ? poolPrice
      : null;

  // For a liquid pair the pool is authoritative — it is where a market order executes — with the
  // oracle standing in until the quote lands (or when the pool quote is nonsense, see above). For an
  // illiquid one the pool is not a price at all, so the market rate is the only honest seed.
  const pairPrice = pairAmmLiquid ? livePoolPrice ?? oraclePrice : oraclePrice;

  // USDC per sUSDS, so an order whose sell leg is the savings share is valued by what it is worth
  // rather than by its number of shares — 81.0067 sUSDS is 90 USDC, and reading that as 81 priced the
  // order about 8% low. An aToken is one-for-one with its underlying and needs no rate.
  const [shareRate, setShareRate] = useState(1);
  useEffect(() => {
    let live = true;
    susdsRate(network).then((r) => live && setShareRate(r));
    return () => {
      live = false;
    };
  }, [network]);

  /**
   * The TWAP schedules, by appData.
   *
   * A TWAP is not one order: it is N part orders, each posted when its slot comes round, all
   * sharing the schedule's salted appData. CoW knows nothing of the schedule, so the part count —
   * and therefore how far along the TWAP is — can only come from the record kept at placement.
   */
  const [twaps, setTwaps] = useState<Map<string, TwapSchedule>>(() => new Map());

  const refreshOrders = () => {
    if (!owner) return;
    const vault = activeVaultAddress(network)!;
    fetchRecentOrders(vault, network).then(setOrders).catch(() => setOrders([]));
    // Completed market swaps leave no order record — they're recovered from the vault's transfer
    // feed, which is also where a CoW fill's timestamp comes from.
    fetchTrades(vault, network)
      .then(({trades, fillAt: at, cancelAt: cancels}) => {
        setMarketTrades(trades);
        setFillAt(at);
        setCancelAt(cancels);
      })
      .catch(() => {
        setMarketTrades([]);
        setFillAt(new Map());
        setCancelAt(new Map());
      });
    fetchTwapSchedules(vault, network)
      .then((rows) => setTwaps(new Map(rows.map((r) => [r.appData.toLowerCase(), r]))))
      .catch(() => setTwaps(new Map()));
  };
  // Orders cancelled in this session, applied over the orderbook until it catches up.
  const [cancelledUids, setCancelledUids] = useState<Set<string>>(() => new Set());
  const markCancelled = (uids: string[]) => {
    // Nothing else will ever know when this happened: CoW records no cancellation date and a
    // cancel moves no tokens, so the transfer feed has nothing to match. See {cancel-log}.
    recordCancelled(uids);
    setCancelledUids((cur) => {
      const next = new Set(cur);
      for (const u of uids) next.add(u.toLowerCase());
      return next;
    });
    // The orderbook lags the chain: refresh now and again shortly after, so the list settles on its
    // own once CoW has indexed the invalidation.
    refreshOrders();
    for (const ms of [2000, 6000]) setTimeout(refreshOrders, ms);
  };
  useEffect(refreshOrders, [owner, network, status]);
  // Poll so a fill / expiry moves an order out of Open without needing a remount.
  useEffect(() => {
    const id = setInterval(refreshOrders, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, network]);

  /**
   * Choosing either leg of the pair turns "Others" back off.
   *
   * The flag is sticky on purpose — re-ticking it on every visit would make the filter feel broken
   * — but deliberately picking an asset is a statement about which pair you are here for, and the
   * orders under the chart went on listing every pair the vault has ever traded. The filter stays
   * asked for as long as the pair is left alone; changing the pair answers the question again.
   */
  const pickedPairLeg = () => setOthers(false);

  const selectAsset = (sym: string) => {
    setBaseSym(sym);
    if (sym === quoteSym) {
      const other = stables.find((s) => s.symbol !== sym);
      if (other) setQuoteSym(other.symbol);
    }
    pickedPairLeg();
  };
  /**
   * The market directory: every asset the network has, by category.
   *
   * It lives here rather than on the Overview because this is where choosing an asset leads
   * somewhere. The Overview answers "what do I own"; a list of tokenized stocks the vault has
   * never held belongs on the tab where you go to buy one.
   */
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // "selected" is a synthetic first category — the assets already on this list — so the user can
  // reach them in one tab and untick any without hunting down the real categories. Only on the
  // watch list, and only while the list has something on it.
  const [category, setCategory] = useState<DirCategory>('crypto_native');
  const categories = useMemo(
    () => ASSET_CATEGORIES.filter((k) => assets.some((a) => assetCategory(a.category) === k)),
    [assets],
  );
  /**
   * What the Selected tab remembers, so unticking an asset there leaves it on the tab (unchecked,
   * ready to re-tick) instead of removing it. It gathers whatever is on the list each time the tab
   * is entered and never shrinks on a untick — only a fresh screen (a new mount) starts it empty.
   */
  const [selSnapshot, setSelSnapshot] = useState<Set<string>>(new Set());
  const rememberSelected = () =>
    setSelSnapshot((prev) => {
      const next = new Set(prev);
      onList.forEach((s) => next.add(s));
      return next;
    });
  // Assets the vault actually holds, worth more than a dime — counted as Selected whether or not
  // they are on the list, the same rule the Overview's Assets list uses. Judged by VALUE, not
  // amount, so a dust leftover does not earn a row. The free (spendable) balance is what matters on
  // a trade directory, so that is what is priced.
  const heldSet = useMemo(() => {
    const s = new Set<string>();
    if (!balances.balances) return s;
    for (const a of assets) {
      const amt = Number(balanceOfSymbol(balances.balances, a.symbol) || 0);
      if (amt <= 0) continue;
      const v = usdValue(amt, a.symbol, prices);
      if (v != null && v > 0.1) s.add(a.symbol);
    }
    return s;
  }, [assets, balances.balances, prices]);
  // The tab exists while anything is on the list, held over $0.10, OR has been shown on it this
  // session (so the row you just unticked keeps its place).
  const showSelected = isWatchlist && (onList.size > 0 || selSnapshot.size > 0 || heldSet.size > 0);
  useEffect(() => {
    const valid: DirCategory[] = showSelected ? ['selected', ...categories] : categories;
    if (valid.length && !valid.includes(category)) setCategory(valid[0]);
  }, [categories, category, showSelected]);


  /** One directory row: icon, name, localised company, and what one of it costs. */
  const assetRow = (a: (typeof assets)[number], i: number) => {
    /**
     * On "Assets", a funded row cannot be unticked.
     *
     * That list shows everything the vault holds whatever the ticks say — a balance must never
     * go missing behind someone's arrangement — so offering a tick that appears to remove it
     * would be offering a control that does nothing. What the ticks decide there is the EMPTY
     * rows: which assets sit on screen ready to be funded.
     *
     * Marked in the quiet colour rather than the accent, and the row does not respond: a tick
     * that is a statement of fact should not look like one the user just made.
     */
    // On "Assets", a funded row cannot be unticked: that list shows everything held whatever the
    // ticks say, so a tick there is a statement of fact (the muted mark), not a control.
    const pinned = isWatchlist && builtIn && totalOf(a.symbol) > 0;
    // Editing the watch list, a check takes the price's place — the same blue tick every picker in
    // the app uses for "chosen"; only chosen rows carry a mark, so the list reads as what is on it.
    // On a pair directory the row shows the price instead, lined up at the right edge as a column.
    return (
      <AssetPickRow
        key={a.symbol}
        asset={a}
        first={i === 0}
        query={query.trim()}
        disabled={pinned}
        value={isWatchlist ? undefined : fmtUsd(usdValue(1, a.symbol, prices))}
        check={isWatchlist ? (onList.has(a.symbol) ? 'accent' : pinned ? 'muted' : 'none') : 'none'}
        onPress={() => (isWatchlist ? star(a.symbol) : openPair(a.symbol))}
      />
    );
  };

  /**
   * The categories sit side by side and swipe, the way they did on the Overview.
   *
   * A tap on a tab scrolls the pager there, so the list always slides in from the side it came
   * from. The pager is only as tall as the page in view: each page reports its height, the pager
   * takes the tallest, and an animated negative bottom margin pulls the content below back up to
   * the page actually showing — otherwise every category would be as tall as the longest one.
   */
  /**
   * Search shares the category line rather than taking a row of its own: the directory is already
   * a header, a pager and a card, and a fourth band pushed the first asset off the first screen.
   * Open, the field takes the line and the categories step aside — nothing to switch between while
   * the results span every category anyway.
   */
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  // Read in the keyboard listener, which must not be re-subscribed on every keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;
  /**
   * Putting the keyboard away with nothing typed puts the search away too, and the categories and
   * the magnifier come back.
   *
   * Dismissing is how someone says they changed their mind, and leaving an empty field holding the
   * category line meant the only way out was finding the ✕. A query that HAS been typed survives —
   * the list scrolls the keyboard down on drag, and losing the results at that point would undo
   * the search for the sake of tidiness.
   */
  useEffect(() => {
    if (!searching) return;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      if (!queryRef.current.trim()) setSearching(false);
    });
    return () => sub.remove();
  }, [searching]);
  const pagerRef = React.useRef<ScrollView>(null);
  const pagerX = React.useRef(new Animated.Value(0)).current;
  const [pageW, setPageW] = useState(0);
  const [pageH, setPageH] = useState<Record<string, number>>({});
  const realPages = categories.length > 0 ? categories : (['crypto_native'] as AssetCategory[]);
  // "Selected" leads, before Crypto, when there is anything to show there.
  const pages: DirCategory[] = showSelected ? ['selected', ...realPages] : realPages;
  /**
   * Changing category takes the page back to the top.
   *
   * Each category is a different length and the pager shrinks to whichever is showing, so arriving
   * at a short one from the bottom of a long one left the scroll position past the end of the new
   * list entirely: swiping from the foot of Stocks to ETF showed an empty screen, with the ETFs
   * above the fold and no indication they were there. The header is a chart and a category row, so
   * going to the top is also going to the start of the list.
   */
  const pageRef = React.useRef<ScrollView>(null);
  const toTop = () => pageRef.current?.scrollTo({y: -headerHeight, animated: true});
  const pickCategory = (k: DirCategory) => {
    if (k === 'selected') rememberSelected();
    setCategory(k);
    const i = pages.indexOf(k);
    if (i >= 0 && pageW > 0) pagerRef.current?.scrollTo({x: i * pageW, animated: true});
    if (k !== category) toTop();
  };
  const onPagerSettle = (x: number) => {
    if (pageW <= 0) return;
    const k = pages[Math.max(0, Math.min(pages.length - 1, Math.round(x / pageW)))];
    if (k && k !== category) {
      if (k === 'selected') rememberSelected();
      setCategory(k);
      toTop();
    }
  };
  const knownH = pages.map((k) => pageH[k]);
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
  // A new network is a different catalog: start from the first category again.
  useEffect(() => {
    setPageH({});
    pagerRef.current?.scrollTo({x: 0, animated: false});
  }, [network]);
  // Open on the "Selected" tab when the list has assets on it — that is what the watch-list editor
  // is for. Once, on first layout (by when the stored list is loaded), then the user navigates
  // freely. Falls through to the first real category when nothing is selected.
  const landedRef = React.useRef(false);
  useEffect(() => {
    if (landedRef.current || !isWatchlist || pageW <= 0) return;
    landedRef.current = true;
    const target: DirCategory = showSelected ? 'selected' : pages[0];
    if (target === 'selected') rememberSelected();
    setCategory(target);
    const i = pages.indexOf(target);
    if (i >= 0) pagerRef.current?.scrollTo({x: i * pageW, animated: false});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageW, isWatchlist, showSelected]);

  /** Every asset in one category, dollars first. */
  /**
   * Search runs over the whole catalog, by ticker or by the company name in the user's language.
   *
   * Ticker matches come first. Someone typing "A" almost always means an asset called A, not the
   * dozen whose description happens to contain the letter, and mixing the two in catalog order
   * buried the obvious answer.
   *
   * Within each group the match's position in the text decides: one that STARTS with what was
   * typed sorts above one that merely contains it, so "A" puts AAVE over BABA and Apple over
   * Banana. Equal positions keep the catalog's own order, the sort being stable.
   */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const byPosition = (text: (a: (typeof assets)[number]) => string) => (x: (typeof assets)[number], y: (typeof assets)[number]) =>
      text(x).toLowerCase().indexOf(q) - text(y).toLowerCase().indexOf(q);
    const symbolOf = (a: (typeof assets)[number]) => displaySymbol(a.symbol);
    const nameOf = (a: (typeof assets)[number]) => company(a.symbol, a.tokenName) ?? '';

    const bySymbol = assets.filter((a) => symbolOf(a).toLowerCase().includes(q)).sort(byPosition(symbolOf));
    const hit = new Set(bySymbol.map((a) => a.address));
    const byName = assets.filter((a) => !hit.has(a.address) && nameOf(a).toLowerCase().includes(q)).sort(byPosition(nameOf));
    return [...bySymbol, ...byName];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, assets, company]);

  const inCategory = (k: DirCategory) =>
    k === 'selected'
      ? assets.filter((a) => selSnapshot.has(a.symbol) || onList.has(a.symbol) || heldSet.has(a.symbol))
      : assets
          .filter((a) => assetCategory(a.category) === k)
          .sort((x, y) => Number(y.kind === 'stable') - Number(x.kind === 'stable'));

  /** The pair to open for a directory row, quoted in a stable coin the vault actually holds. */
  const openPair = (symbol: string) => {
    const quote = preferredQuote(symbol);
    if (!quote) return;
    nav.navigate('TradePair', {base: symbol, quote});
  };


  // Asset pickers: a sheet with icons, for the base and the quote side of the pair.
  const [picker, setPicker] = useState<'base' | 'quote' | 'source' | 'slippage' | null>(null);
  // Read once into state so the sheet redraws on a change; written through on every pick.
  const [slippage, setSlippage] = useState(() => slippageBps());
  /**
   * Choosing an asset is a PAGE now, not a sheet — see {SelectAssetScreen}.
   *
   * The list is long enough to scroll, and in a sheet the drag that scrolls it is the drag that
   * dismisses it: reaching for something near the bottom threw the sheet away. The answer comes
   * back through {useAssetPick}, applied by the effect below.
   */
  const pickBase = () =>
    nav.navigate('SelectAsset', {slot: 'base', selected: baseSym, exclude: quoteSym});
  const pickQuote = () =>
    nav.navigate('SelectAsset', {slot: 'quote', selected: quoteSym, exclude: baseSym});
  const assetPick = useAssetPick();
  useEffect(() => {
    const {slot, symbol, clear} = assetPick;
    if (!slot || !symbol) return;
    if (slot === 'quote') {
      quoteChosen.current = true;
      setQuoteSym(symbol);
      pickedPairLeg();
    } else {
      selectAsset(symbol);
    }
    clear();
    // Keyed on the SEQUENCE, not the symbol: re-picking the same asset is a new answer, and an
    // effect watching the value alone would ignore it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetPick.seq]);
  // Quote rows: the stablecoins, nothing else. A position is not a token you pick here — a market
  // order draws on it automatically, and a limit order spends the free balance only.
  /**
   * What the vault holds of one asset, EVERYWHERE: its free balance plus every yielding and lending
   * position in it.
   *
   * The pickers listed symbols and nothing else, so choosing what to trade meant leaving the sheet
   * to find out whether there was anything to trade with — and a balance sitting in Earn looked
   * like no balance at all. Positions carry the UNDERLYING symbol, so an aUSDC supply counts as
   * USDC here, which is the figure the user thinks in.
   */
  const totalOf = (sym: string): number =>
    Number(balanceOfSymbol(balances.balances, sym) || 0) +
    positions.positions
      .filter((p) => p.symbol === sym && (p.kind === 'staked' || p.kind === 'supplied'))
      .reduce((n, p) => n + Number(p.formatted || 0), 0);

  /**
   * The funding sources, for the only picker still a sheet.
   *
   * Three rows and nothing to scroll, so a sheet is right here — it was the long asset lists that
   * could not live in one, and those are a page now. See {SelectAssetScreen}.
   */
  /**
   * The limit/TWAP sources, drawn with the market sheet's rows — tick, quick percentages, an amount
   * typed in place — but the tick picks ONE: a CoW order sells a single token, so it can be pointed
   * at the free balance or at one position, never both. Each row's ceiling is {spendableFrom}.
   */
  const rateTag = (apy: number | null) => (apy != null ? ` · ${t('mobile.earn.apy_rate', {rate: apy.toFixed(2)})}` : '');
  const limitSources = (
    [
      {key: 'free', label: displaySymbol(spendSym), held: freeNum, rate: ''},
      // A position's row carries its rate, as the Earn rows do: leaving an order funded from
      // one open costs nothing, and what it keeps paying while it waits is the reason why.
      ...(instant.sky ? [{key: 'yield', label: `${displaySymbol(spendSym)} ${t('vault.yielding')}`, held: instant.sky.amount, rate: rateTag(skyApy)}] : []),
      ...(instant.aave ? [{key: 'lend', label: `${displaySymbol(spendSym)} ${t('vault.lending')}`, held: instant.aave.amount, rate: rateTag(aaveApy)}] : []),
    ] as {key: 'free' | 'yield' | 'lend'; label: string; held: number; rate: string}[]
  ).map((r) => {
    const cap = spendableFrom(r.key, r.held);
    const sub = r.key === 'free' ? `${t('vault.balance')} · ${fmtNum(cap)}` : `${fmtNum(cap)} ${displaySymbol(spendSym)}${r.rate}`;
    return {...r, cap, sub};
  });

  // Plain (no thousands separators, so Number() round-trips) price string for the input default.
  const priceToInput = (p: number) => (p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toPrecision(4));

  const openSheet = (side: Side) => {
    setSheetSide(side);
    if (marketOff && intentable && mode === 'Market') setMode('Limit');
    setSpendSource('free');
    setStatus('idle');
    setErr(null);
    setAmount('');
    setReceiveInput('');
    setValidDays('');
    setFundOn({vault: true, sky: false, aave: false});
    setFundAmt({vault: '', sky: '', aave: ''});
    setPriceEdited(false);
    setPrice(pairPrice ? priceToInput(pairPrice) : '');
  };

  // Seed the Limit/TWAP price with the live pair price — and re-seed when the authoritative pool price
  // arrives (it can replace a fast oracle fallback), as long as the user hasn't typed their own.
  useEffect(() => {
    if (sheetSide && !priceEdited && pairPrice) setPrice(priceToInput(pairPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetSide, pairPrice, priceEdited]);

  // Price is always quote-per-base. Market prices strictly off the POOL (what it executes at); Limit/TWAP
  // use the entered price. The receive leg follows from the pay leg: sell → quote = base×price, buy →
  // base = quote÷price.
  const effPrice = mode === 'Market' ? livePoolPrice ?? 0 : Number(price) || 0;

  // Pay ⇄ Receive are both editable and kept in sync through the price. sell: receive = pay×price;
  // buy: receive = pay÷price (and the inverse when the user edits Receive).
  const toField = (n: number): string => (!isFinite(n) || n <= 0 ? '' : String(Number(n < 1 ? n.toPrecision(6) : n.toFixed(6))));
  const applyPay = (t: string) => {
    setAmount(t);
    const p = Number(t);
    setReceiveInput(effPrice > 0 && p > 0 ? toField(paysBase ? p * effPrice : p / effPrice) : '');
  };
  const applyReceive = (t: string) => {
    setReceiveInput(t);
    const r = Number(t);
    setAmount(effPrice > 0 && r > 0 ? toField(paysBase ? r / effPrice : r * effPrice) : '');
  };
  // Re-derive Receive from the pay amount whenever the price or side changes (a Limit price edit, the
  // pool quote landing, or a Buy/Sell flip), so the two stay consistent without a feedback loop.
  useEffect(() => {
    if (!sheetSide) return;
    const p = Number(amount);
    if (effPrice > 0 && p > 0) setReceiveInput(toField(paysBase ? p * effPrice : p / effPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effPrice, paysBase, sheetSide]);

  /**
   * The market estimate and Min received, from the Universal route quote (v2/v3/v4) — the REAL
   * output for THIS pay amount, with price impact and pool fees in it. The price × amount above is
   * only a seed for instant feedback; it ignores depth, so it overstated both numbers on anything
   * but a dust trade. This runs the SAME quote the swap itself uses, debounced so a keystroke does
   * not spam it, and corrects the receive field + drives the real Min received below.
   */
  const [mktQuote, setMktQuote] = useState<{est: string; guard: string} | null>(null);
  useEffect(() => {
    const recvAsset = paysBase ? quoteAsset : base;
    if (mode !== 'Market' || !spendAsset || !recvAsset || !(Number(amount) > 0)) {
      setMktQuote(null);
      return;
    }
    let live = true;
    const h = setTimeout(() => {
      quotePreview({
        network,
        mode: 'sell',
        sellToken: spendAsset.address,
        buyToken: recvAsset.address,
        amount,
        slippageBps: slippage,
      })
        .then((q) => {
          if (!live) return;
          setMktQuote(q ? {est: q.est, guard: q.guard} : null);
          if (q) setReceiveInput(toField(Number(q.est)));
        })
        .catch(() => live && setMktQuote(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, amount, spendSym, recvSym, network, slippage]);

  /**
   * Which stablecoin the relayer should charge its fee to.
   *
   * Prefer a HELD coin that is not the one being spent as the pay leg, so maxing out USDC still
   * leaves USDT to cover gas. Then any held coin — including the pay leg, which is fine: the fee
   * is charged after the operation and what is left over covers a fraction of a cent.
   *
   * The last resort is the COIN BEING SPENT, not the quote. It used to be the quote, which on a
   * stablecoin pair is the other stablecoin: trading USDC for USDT on a vault holding no USDT
   * nominated USDT to pay the fee, and the vault reverts a fee it cannot transfer — which the
   * relayer reports as "the fee leg failed" with no mention of the coin. Falling back to the pay
   * leg cannot do that, because an order that can be placed at all has a balance of it.
   *
   * `held` is empty while the balances are still loading, which is exactly when the fallback
   * matters and exactly when it was wrong.
   */
  const pickFeeCoin = (excludeAddr?: string): Address => {
    const held = stables.filter((s) => Number(balanceOfSymbol(balances.balances, s.symbol)) > 0);
    const ex = excludeAddr?.toLowerCase();
    const preferred = ex ? held.find((s) => s.address.toLowerCase() !== ex) : held[0];
    const spent = ex ? stables.find((s) => s.address.toLowerCase() === ex) : undefined;
    return ((preferred ?? held[0] ?? spent ?? quoteAsset)?.address ?? quoteSym) as Address;
  };

  // The same checks onSubmit makes, so the button is disabled rather than erroring on tap.
  const canConfirm =
    !!sheetSide && unlocked && !!owner && !!base && !!quoteAsset &&
    Number(amount) > 0 &&
    (mode === 'Market' ? !marketOff : Number(price) > 0) &&
    (mode !== 'TWAP' || Number(parts) >= 2) &&
    !overBalance;

  const onSubmit = async () => {
    const side = sheetSide;
    if (!side || !unlocked || !owner || !base || !quoteAsset) return;
    // Everything the order needs is read off now, because the sheet closes before the work starts.
    const amt = amount;
    if (!(Number(amount) > 0)) return setErr(t('vault.enter_amount')), setStatus('error');
    if (mode !== 'Market' && !(Number(price) > 0)) return setErr(t('vault.enter_limit_price')), setStatus('error');
    if (overBalance) return setErr(t('vault.insufficient_balance', {token: displaySymbol(spendSym)})), setStatus('error');
    setStatus('busy');
    setErr(null);
    /**
     * Both legs, in the user's words: "Pay 100 USDC to buy 0.1 ETH" / "Sell 0.1 ETH for 250 USDC".
     *
     * It named ONE leg, and the wrong one: `spendSym` is what the order PAYS, so a buy of ETH with
     * USDC announced itself as "Buy 100 USDC" — a coin the user was not buying, in an amount that
     * belonged to the other side of the trade. Naming both ends removes the question of which one
     * the figure refers to.
     *
     * The receive figure is the field's own, falling back to the price-derived amount when the user
     * left it to auto-fill. If neither is available (no pool price yet) the line states only what is
     * certain — what is being paid.
     */
    const toastRecv =
      Number(receiveInput) > 0
        ? Number(receiveInput)
        : effPrice > 0 && Number(amt) > 0
          ? paysBase
            ? Number(amt) * effPrice
            : Number(amt) / effPrice
          : 0;
    // Through the same formatter the order rows use, not the raw field: what the user typed can be
    // "12.212123121", and a toast reporting the trade should read like the row the trade becomes.
    const payLeg = `${fmtShort(Number(amt))} ${displaySymbol(spendSym)}`;
    const recvLeg = `${fmtShort(toastRecv)} ${displaySymbol(recvSym)}`;
    // Named, so a failure recorded in the catch below reads exactly as the toast did.
    const toastTitle =
      toastRecv > 0
        ? t(side === 'buy' ? 'mobile.trade.pay_to_buy' : 'mobile.trade.pay_to_sell', {pay: payLeg, receive: recvLeg})
        : `${t('vault.pay')} ${payLeg}`;
    const tx = showTx(
      toastTitle,
      network,
      // A market order is relayed and has a hash. A limit or TWAP order is SIGNED and posted to
      // CoW's order book — nothing is broadcast, so the header must not claim to be broadcasting.
      // (The first intent order of a pair also mines a one-off setup transaction inside
      // `prepareIntent`, which reports no hash of its own and has never been announced either.)
      {broadcast: mode === 'Market'},
    );
    // Closed straight away: a limit order first mines its setup transaction, and with no spinner on
    // the button an open sheet looked like a tap that did nothing. The badge and the orders list
    // carry it from here, and a failure raises a toast.
    setSheetSide(null);
    try {
      const acct = await getSigner();
      const vault = activeVaultAddress(network)!;
      // You always sell the PAY leg for the RECEIVE leg: sell base→quote, buy quote→base. Exact-in.
      const recvAsset = (paysBase ? quoteAsset : base);
      // Nothing was sent, so the header's spinner has to come down with it.
      if (!spendAsset || !recvAsset) return tx.done();
      const sellToken = spendAsset.address as Address;
      const buyToken = recvAsset.address as Address;
      // Charge gas to a stablecoin that isn't the pay leg (so a max-USDC trade pays gas from USDT).
      const feeCoin = pickFeeCoin(sellToken);

      // What has to come out of a position before the tokens can be spent.
      //
      // A named source (Yielding / Lending) withdraws exactly the amount from that adapter. The free
      // balance withdraws nothing unless a MARKET order runs past it, in which case the difference
      // comes out of the positions — Sky first, then Aave — since that swap is one transaction.
      // Rounded up so the order has enough, capped at what each position holds.
      const dec = spendAsset.decimals;
      const up = (v: number) => Math.ceil(v * 10 ** dec) / 10 ** dec;
      const withdrawCall = (protocol: Address, take: number): VaultCall => ({
        abi: VAULT_DEFI_ABI,
        functionName: 'withdraw',
        args: [protocol, sellToken, parseUnits(up(take).toFixed(dec) as `${number}`, dec)],
      });
      const withdrawCalls: VaultCall[] = [];
      // What the vault will still be holding when the swap is done, and how much short of the
      // relayer's reserve that leaves it. Anything missing is withdrawn alongside the trade: the
      // fee is charged after the call, so the coin has to be there by then. See {feeReserve}.
      const freeAfterSwap = Math.max(0, Number(freeSpend) - (spendSource === 'free' ? Number(amount) : 0));
      const topUp = Math.max(0, feeReserve - freeAfterSwap);
      if (spendSource !== 'free' && mode === 'Market') {
        // A market swap needs the underlying in hand, and it withdraws and swaps in one transaction.
        const from = spendSource === 'yield' ? instant.sky : instant.aave;
        if (from) withdrawCalls.push(withdrawCall(from.protocol, Math.min(Number(amount) + topUp, from.amount)));
      } else if (spendSource === 'free' && mode === 'Market') {
        // The funding rows say where the money comes from; the amount says how much is needed. They
        // normally agree, because moving a row restates the amount — but the pay field is still
        // typable, and ticking a source makes its WHOLE balance available, so an amount typed after
        // the fact can outrun what the rows selected. Each ticked position therefore gives what it
        // was set to, and then tops up to its balance if the order is still short.
        const sources = [
          {pos: instant.sky, on: fundOn.sky, picked: planSky},
          {pos: instant.aave, on: fundOn.aave, picked: planAave},
        ];
        let need = Math.max(0, Number(amount) + topUp - Number(freeSpend));
        const takes = sources.map(({pos, on, picked}) => {
          if (!pos || !on) return 0;
          const take = Math.min(need, picked);
          need = round6(need - take);
          return take;
        });
        for (let i = 0; i < sources.length && need > 0; i++) {
          const {pos, on, picked} = sources[i];
          if (!pos || !on) continue;
          const extra = Math.min(need, pos.amount - picked);
          takes[i] += extra;
          need = round6(need - extra);
        }
        sources.forEach(({pos}, i) => {
          if (pos && takes[i] > 0) withdrawCalls.push(withdrawCall(pos.protocol, takes[i]));
        });
      }

      if (mode === 'Market') {
        if (withdrawCalls.length) {
          const {setup, swap} = await buildMarketSell({network, vault, sellToken, buyToken, sellAmount: amount, slippageBps: slippage});
          const {hash} = await relayVaultMulticall({account: acct, vault, network, calls: [...withdrawCalls, ...setup, swap], stableCoin: feeCoin});
          tx.success(hash);
        } else {
          // marketSell bundles any required allowlist setup ahead of the swap; exact-in, works both sides.
          const {hash} = await marketSell({account: acct, vault, network, sellToken, buyToken, sellAmount: amount, slippageBps: slippage, stableCoin: feeCoin});
          tx.success(hash);
        }
      } else {
        if (!intent) throw new Error(t('mobile.trade.cow_unavailable'));
        // Bundle the one-time setup (allowlist assets, register the intent adapter so the vault clones it,
        // approve the relayer) — plus any Sky top-up — into a single mined tx before posting, so the USDC is
        // in the vault when the order settles.
        // Funded from a position, the order sells the POSITION'S OWN TOKEN — sUSDS, or the aToken —
        // rather than unwinding it first. The balance keeps earning while the order sits open, and
        // an order that never fills has cost the user nothing. The amount is typed in the underlying
        // and converted at the position's rate, capped at what it holds.
        const from = spendSource === 'yield' ? instant.sky : spendSource === 'lend' ? instant.aave : null;
        const pt = from ? await positionToken(vault, network, from.position) : null;
        if (spendSource !== 'free' && !pt) throw new Error(t('mobile.trade.cow_unavailable'));
        const payToken = pt ? pt.address : sellToken;
        const payAmount = pt
          ? formatUnits(
              (() => {
                const raw = parseUnits((Number(amount) / pt.rate).toFixed(pt.decimals) as `${number}`, pt.decimals);
                return raw > pt.max ? pt.max : raw;
              })(),
              pt.decimals,
            )
          : amount;

        // Asked of the chain, not of a Set that empties on restart: an unlimited allowance is
        // already there after the first order, and approving it again costs a relay fee for nothing.
        const needApprove = await needsRelayerApproval({vault, network, intentProtocol: intent, token: payToken});
        await prepareIntent({account: acct, vault, network, intentProtocol: intent, tokens: [payToken, buyToken], approveToken: needApprove ? payToken : undefined, stableCoin: feeCoin});
        // Minimum received (what the user wants), in the receive leg's units. Falls back to the
        // price-derived amount if they left the field to auto-fill. Bounded decimals so parseUnits round-trips.
        const recvNum = Number(receiveInput) > 0 ? Number(receiveInput) : effPrice > 0 && Number(amount) > 0 ? (paysBase ? Number(amount) * effPrice : Number(amount) / effPrice) : 0;
        if (!(recvNum > 0)) {
          tx.done();
          setErr(t('mobile.trade.enter_receive'));
          setStatus('error');
          return;
        }
        const minRecv = recvNum.toFixed(Math.min(recvAsset.decimals, 8));
        if (mode === 'Limit' && uxIntent) {
          // A UniswapX limit order sells the token itself: the free balance, not a position's share.
          if (pt) throw new Error(t('mobile.trade.uniswapx_free_only'));
          await placeUniswapXLimit({account: acct, vault, network, sellToken: payToken, buyToken, sellAmount: payAmount, buyAmount: minRecv, validSeconds: validSec}).catch((e) => {
            throw e instanceof UniswapXNoQuoteError ? new Error(t('mobile.trade.uniswapx_no_quote')) : e;
          });
        } else if (mode === 'Limit') {
          await placeLimitOrder({account: acct, vault, network, intentProtocol: intent, sellToken: payToken, buyToken, sellAmount: payAmount, buyAmount: minRecv, kind: 'sell', validSeconds: validSec});
        } else {
          const n = Math.max(1, parseInt(parts || '1', 10));
          await placeTwap({account: acct, vault, network, intentProtocol: intent, sellToken: payToken, buyToken, totalSell: payAmount, totalMinBuy: minRecv, parts: n, partDuration: Math.max(60, Math.floor(validSec / n))});
        }
        /**
         * Done, with no hash to wait on.
         *
         * An intent order is a signature posted to CoW's book, so there is nothing to confirm and
         * nothing to track — the order itself appears in the list below. Saying so is not optional:
         * the toast opens on Submitting and an in-flight toast never times out on its own, so a
         * path that returned without this left it spinning for the rest of the session. It was
         * invisible before the toast existed, because this mode asked for no header spinner.
         */
        tx.success();
      }
      setStatus('done');
      // CoW indexes a new order a moment after accepting it; look again so it lands in Open.
      refreshOrders();
      for (const ms of [2000, 6000]) setTimeout(refreshOrders, ms);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      tx.error(msg);
      /**
       * The server records every attempt it is ASKED about, refusals included — so for anything the
       * relay route saw, re-reading the list is all this needs to do.
       *
       * It cannot see the ones that fail earlier. A market order is quoted and built here first: no
       * route for the pair, a quote that will not come back, an adapter the vault has not got, and
       * this throws before the relay is ever called. Those were written down nowhere once the local
       * record went, so the attempt simply vanished — which is the gap this reports. See
       * {reportFailedAttempt}.
       */
      const recvA = paysBase ? quoteAsset : base;
      if (mode === 'Market' && spendAsset && recvA && owner) {
        const raw = (amt: number, dec: number) =>
          parseUnits(round6(Math.max(0, amt)).toFixed(dec) as `${number}`, dec);
        void reportFailedAttempt({
          vault: activeVaultAddress(network)!,
          network,
          signer: owner,
          reason: msg,
          sellToken: spendAsset.address,
          sellAmount: raw(Number(amt), spendAsset.decimals).toString(),
          buyToken: recvA.address,
          buyAmount: raw(toastRecv, recvA.decimals).toString(),
        }).finally(refreshOrders);
      } else {
        refreshOrders();
      }
      setErr(msg);
      setStatus('error');
    }
  };

  const onCancel = async (o: CowOrder) => {
    if (!owner || !quoteAsset) return;
    if (!intent) return showToast('error', t('mobile.trade.cannot_cancel'), t('mobile.trade.cow_unavailable'));
    setCancelling(o.uid);
    const tx = showTx(t('mobile.actions.cancel_intent'), network);
    try {
      const acct = await getSigner();
      tx.success(await cancelLimitOrders({account: acct, vault: activeVaultAddress(network)!, network, intentProtocol: intent, uids: [o.uid as `0x${string}`], stableCoin: pickFeeCoin()}));
      markCancelled([o.uid]);
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setCancelling(null);
    }
  };

  const onCancelAll = async (uids: string[]) => {
    if (!owner || !quoteAsset || uids.length === 0) return;
    if (!intent) return showToast('error', t('mobile.trade.cannot_cancel'), t('mobile.trade.cow_unavailable'));
    setCancellingAll(true);
    const tx = showTx(t('mobile.actions.cancel_intents', {count: uids.length}), network);
    try {
      const acct = await getSigner();
      tx.success(await cancelLimitOrders({account: acct, vault: activeVaultAddress(network)!, network, intentProtocol: intent, uids: uids as `0x${string}`[], stableCoin: pickFeeCoin()}));
      markCancelled(uids);
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setCancellingAll(false);
    }
  };

  /**
   * Only orders/trades for the current pair unless "Show others" is on — and only ones this build
   * can actually read.
   *
   * An order whose legs cannot be named is dropped outright. `assetMeta` answers an unknown token
   * with a shortened ADDRESS and a guessed 18 decimals, so such a row printed an address where a
   * symbol belongs, next to an amount and a price divided by the wrong scale. That is the "address
   * and random numbers" row; not listing it is better than listing it wrong.
   */
  const namedOrders = useMemo(
    () => orders.filter((o) => isKnownAsset(network, o.sellToken) && isKnownAsset(network, o.buyToken)),
    [orders, network],
  );
  /**
   * Until the first balance read lands the pair is the app's own GUESS.
   *
   * `preferredQuote` moves the quote to a coin the vault actually holds the moment balances
   * arrive, so filtering against the opening guess listed, for that moment on a first visit, the
   * orders of a pair the user never chose — and they vanished on the next render, which is why
   * leaving the tab and coming back "fixed" it. An empty list until the pair settles is the honest
   * answer. A failed read counts as settled: the pair will not move after one, and refusing to
   * list anything because the balances are unavailable would be a worse lie.
   */
  const pairSettled = balances.balances != null || balances.error != null;
  const pairSet = new Set([base?.address.toLowerCase(), quoteAsset?.address.toLowerCase()]);
  // An order funded from a position sells the position's token (sUSDS, aUSDC), which stands for
  // the pair's stablecoin — matched through its underlying, or the order vanished from Open.
  const pairToken = (a: string): boolean =>
    pairSet.has(a.toLowerCase()) || [baseSym, quoteSym].includes(underlyingOf(network, a) ?? '');
  const inPair = (o: CowOrder): boolean => pairToken(o.sellToken) && pairToken(o.buyToken);
  // A savings share or an aToken counts as its underlying: an order selling sUSDS for CRCL is a
  // USDC-priced buy, limit or TWAP, and pricing it per share would be meaningless.
  // A leg held as a receipt token reads, and prices, as its underlying: what the user typed and
  // what the order is worth. sUSDS converts at the savings rate; an aToken is one-for-one.
  const legRate = (addr: string) => (assetMeta(network, addr).symbol === 'sUSDS' ? shareRate : 1);
  const stableLike = (addr: string) => {
    const under = underlyingOf(network, addr);
    return stables.some((st) => (under ? st.symbol === under : st.address.toLowerCase() === addr.toLowerCase()));
  };
  const marketInPair = (m: MarketTrade): boolean => pairSet.has(m.sold.address.toLowerCase()) && pairSet.has(m.bought.address.toLowerCase());

  /**
   * Open a row, and go to the pair it belongs to.
   *
   * With "others" ticked the list carries orders from every pair the vault has traded, and
   * tapping one used to expand it against a chart and a price for a different asset entirely —
   * the panel said CRCL while everything above it said ETH. Tapping an order is a statement about
   * which order you are looking at, so the screen follows it.
   *
   * The quote leg is whichever side is a stablecoin, which is how the pair picker is built; a leg
   * held as a receipt token resolves to what it stands for, since an order selling sUSDS is a
   * USDC-quoted order and there is no sUSDS pair to switch to. If neither side is a stablecoin,
   * or the base is not in the catalog, there is no pair to show and the row simply opens.
   */
  const showPairFor = (sellToken: string, buyToken: string) => {
    const legs = [sellToken, buyToken].map(
      (addr) => underlyingOf(network, addr) ?? assetMeta(network, addr as Address).symbol,
    );
    const quote = legs.find((sym) => stables.some((st) => st.symbol === sym));
    const next = legs.find((sym) => sym !== quote);
    if (!quote || !next || !assets.some((a) => a.symbol === next)) return;
    setBaseSym(next);
    setQuoteSym(quote);
  };
  /**
   * " @112.3" — what a trade actually went at, appended to the leg a row names.
   *
   * On a FINISHED row this is the average fill, worked out from the executed amounts rather than
   * from the price that was asked for: a limit order can fill below its limit and a TWAP almost
   * never fills every slot at one price, so the order's own terms are a different number from
   * what it got. Empty when there is nothing to divide — an unfilled row says what it wants, not
   * what it did.
   */
  const atPrice = (n: number) => {
    const p = fmtPrice(n);
    return p ? ` @${p}` : '';
  };

  /** How a schedule ended, in the words both lists use — see {twapVerdict}. */
  const twapStatus = (g: TwapGroup) => twapVerdict(g, t) ?? undefined;

  const openOrderRow = (key: string, sellToken: string, buyToken: string, isExpanded: boolean) => {
    // Only line the pair up when OPENING a row. Collapsing one should leave the chart on whatever
    // pair the user is looking at, not jump it to the order being closed.
    if (!isExpanded) showPairFor(sellToken, buyToken);
    toggleExpanded(key);
  };

  /**
   * A part order belongs to a schedule; it is not an order the user placed.
   *
   * The appData is the only link — CoW has no notion of a TWAP — and a schedule's is salted at
   * placement, so an order is a part IFF its appData matches one the server recorded. (Comparing
   * against the fixed limit appData instead, as the row badge still does for an orphan, cannot
   * distinguish a part from a limit order placed by anything else.)
   */
  const partOf = (o: CowOrder): TwapSchedule | undefined => (o.appData ? twaps.get(o.appData.toLowerCase()) : undefined);

  /**
   * The side word for an order BADGE, which is not the word the Buy / Sell buttons use.
   * Chinese carries 买入 / 卖出 on the buttons — full verbs, which is what an action wants — and
   * 买 / 卖 here, which is what a label in a pill wants.
   */
  const sideWord = (isBuy: boolean) => t(isBuy ? 'mobile.trade.buy_short' : 'mobile.trade.sell_short');

  /**
   * One row per TWAP schedule, not one per part. See `splitTwapGroups` for why the total comes from
   * the schedule rather than from the parts CoW happens to have posted.
   */
  const {plainOrders, twapGroups} = useMemo(
    () => {
      const {plain, groups} = splitTwapGroups(namedOrders, twaps, cancelledUids);
      return {plainOrders: plain, twapGroups: groups};
    },
    [namedOrders, twaps, cancelledUids],
  );

  /**
   * Everything a TWAP row and its sheet both need, worked out once.
   *
   * The row draws the parts and the sheet draws the terms, and both are derived from the same
   * representative part — so this is a function rather than a block inside the list, which is
   * where it used to live when only the list needed it.
   */
  const twapFacts = (g: TwapGroup) => {
    const o = g.rep;
    // Named and sized as the underlying when a leg is a receipt token, as the limit rows are.
    const legMeta = (addr: string) => {
      const m = assetMeta(network, addr as Address);
      return {...m, symbol: underlyingOf(network, addr) ?? m.symbol};
    };
    const sellM = legMeta(o.sellToken);
    const buyM = legMeta(o.buyToken);
    const sellStable = stableLike(o.sellToken);
    const buyStable = stableLike(o.buyToken);
    // The SCHEDULE's size, not the part's: one part is a tenth of what the user asked for, and a
    // row claiming to be the order has to state the order's own amounts.
    const partSell = Number(formatUnits(BigInt(o.sellAmount), sellM.decimals)) * legRate(o.sellToken);
    const partBuy = Number(formatUnits(BigInt(o.buyAmount), buyM.decimals)) * legRate(o.buyToken);
    /**
     * The limit price the schedule was placed at.
     *
     * A TWAP has one, same as a limit order — every part carries it. Read off a PART: the ratio is
     * the same at any size, and the parts are what exist. Quoted in the stable leg where there is
     * one, as everywhere else in this list, and the partner fee backed out so it matches what was
     * typed into the form.
     */
    const pxBase = sellStable || buyStable
      ? (sellStable ? partSell : partBuy) / (sellStable ? partBuy : partSell)
      : partBuy / partSell;
    return {
      o,
      sellM,
      buyM,
      isBuy: sellStable,
      partSell,
      partBuy,
      twapPx: pxBase / (o.kind === 'buy' ? 1 + PARTNER_FEE : 1 - PARTNER_FEE),
    };
  };

  /**
   * When a slot that has not gone out yet is due, as a distance rather than a time.
   *
   * The question a running TWAP is asked is "when is the next one", and a wall-clock stamp makes
   * the reader do the arithmetic — ten of them down a column, all reading the same date, makes
   * them do it ten times. It also has to fit where a status word fits: this sits in the same slot
   * as Filled and Open on the posted lines, and the amount beside it is the side that shrinks.
   *
   * One unit, floored — ninety minutes reads "in 1h", the convention everywhere else. A slot whose
   * time has passed and which the keeper has not posted yet says so instead of counting backwards:
   * the schedule's clock and the keeper's are not the same clock.
   */
  const fmtDue = (at: number): string => fmtIn(at, t);

  // The schedule the Details sheet is showing, looked up live rather than held in state: a part
  // posting or filling while the sheet is open should change what it says.
  const infoGroup = twapInfo ? twapGroups.find((x) => x.appData === twapInfo) : undefined;
  const infoFacts = infoGroup ? twapFacts(infoGroup) : null;
  const infoWhen = infoGroup
    ? twapTimeLine(infoGroup, {
        cancelled: infoGroup.parts.reduce<number | undefined>(
          (at, pt) => at ?? cancelAt.get(pt.uid.toLowerCase()),
          undefined,
        ) ?? cancelledAtAny(infoGroup.parts.map((pt) => pt.uid)),
      })
    : null;

  const [cancellingTwap, setCancellingTwap] = useState<string | null>(null);
  /**
   * Cancelling a TWAP is two things, not one: invalidate the part orders already posted, and tell
   * the server to stop posting the rest. Cancelling the open part alone left the cron to post the
   * next slot a minute later.
   */
  const onCancelTwap = async (g: TwapGroup) => {
    if (!owner) return;
    if (!intent) return showToast('error', t('mobile.trade.cannot_cancel'), t('mobile.trade.cow_unavailable'));
    setCancellingTwap(g.appData);
    const tx = showTx(t('mobile.actions.cancel_intent'), network);
    try {
      const acct = await getSigner();
      await cancelTwap({
        account: acct,
        vault: activeVaultAddress(network)!,
        network,
        intentProtocol: intent,
        appData: g.appData,
        openPartUids: g.openUids as `0x${string}`[],
        stableCoin: pickFeeCoin(),
      });
      markCancelled(g.openUids);
      refreshOrders();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setCancellingTwap(null);
    }
  };

  const visibleOrders = showOthers ? plainOrders : pairSettled ? plainOrders.filter(inPair) : [];
  const visibleTwaps = showOthers ? twapGroups : pairSettled ? twapGroups.filter((g) => inPair(g.rep)) : [];
  // Open is the live list; Recently is the HISTORY — finished, cancelled, expired — with open
  // orders left out, since those are not history and already have the Open tab. Both tabs are built
  // on every render (they are the pager's two pages), so these take the tab rather than reading the
  // current one.
  const twapsFor = (which: Tab) =>
    which === 'open' ? visibleTwaps.filter((g) => g.bucket === 'open') : visibleTwaps.filter((g) => g.bucket !== 'open');
  // Market swaps are always complete → they belong under Finished.
  const marketFinished = showOthers ? marketTrades : pairSettled ? marketTrades.filter(marketInPair) : [];
  /**
   * Market swaps this device sent that reverted, or were never included.
   *
   * Under Finished with the completed ones, because they are the same thing seen through: an
   * attempt that has stopped. They come from {usePending} rather than the transfer feed — a
   * reverted swap moves nothing, so there is no transfer to rebuild it from and the list it
   * belongs in had no way to know it ever happened.
   *
   * Matched to the pair by SYMBOL: the record keeps what the user was shown, not addresses.
   */
  /**
   * Market swaps the relayer was asked for and did not complete, from the SERVER.
   *
   * Not confirmed, rather than failed: one still in flight belongs on screen too, and one that has
   * confirmed arrives in the feed below as a real swap. The order history reads the same list with
   * the same rule, so the two cannot disagree — see {attempts} there.
   */
  const {attempts: relayed} = useVaultAttempts(balances.vault, network, refreshNonce);
  const failedSwaps = useMemo(() => {
    const pair = new Set([displaySymbol(baseSym), displaySymbol(quoteSym)]);
    return relayed
      .filter((a) => a.status !== 'confirmed')
      .map((a) => ({a, trade: attemptTrade(a, network)}))
      .filter(
        (x) =>
          !!x.trade &&
          (showOthers ||
            (pair.has(displaySymbol(x.trade.sold.symbol)) &&
              pair.has(displaySymbol(x.trade.bought.symbol)))),
      );
  }, [relayed, network, showOthers, baseSym, quoteSym]);

  /**
   * Is this row inside the Recently window? See {finishedWindow}.
   *
   * ONE predicate, because the count on the tab and the rows in the list have to agree about it.
   * They did not: the cut lived in the render and the count was worked out separately, so choosing
   * 24 hours shortened the list and left "Recently (18)" above it.
   *
   * A row whose time could not be worked out — a swap the feed gave no timestamp for, which falls
   * back to a block number — is KEPT. A block number is not a unix time, so it is older than every
   * cutoff and testing it would hide the row for ever.
   */
  const finishedSinceSecs = finishedSince(finishedWindow);
  const inRecentWindow = (at: number) => at <= 1_000_000_000 || at >= finishedSinceSecs;
  /** A market swap's clock, named so the count and the row cannot read it differently. */
  const tradeAt = (m: MarketTrade) => m.ts ?? m.blockNum;

  /**
   * What each tab holds, as a count beside its label.
   *
   * Keyed by TAB, not by bucket. It used to tally the three order buckets, which worked while the
   * second tab was one of them; Recently is every bucket inside the window, so counting buckets
   * and showing a tab meant converting between the two at every use. The window applies to
   * Recently alone — an open order is not history and is never cut.
   */
  const counts = useMemo(() => {
    const c: Record<Tab, number> = {open: 0, recent: 0};
    const add = (bucket: OrderBucket, at: number) => {
      // An open order is counted on Open alone — it is never part of Recently, which is history.
      if (bucket === 'open') c.open += 1;
      else if (inRecentWindow(at)) c.recent += 1;
    };
    visibleOrders.forEach((o) => add(orderBucket(effectiveStatus(o, cancelledUids)), placedAt(o)));
    // One per SCHEDULE. Counting parts made a ten-part TWAP look like ten open orders.
    visibleTwaps.forEach((g) => add(g.bucket, twapPlacedAt(g)));
    marketFinished.forEach((m) => add('finished', tradeAt(m)));
    failedSwaps.forEach(({a}) => add(a.status === 'submitted' ? 'open' : 'finished', a.at));
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleOrders, visibleTwaps, marketFinished, failedSwaps, finishedWindow]);
  const ordersFor = (which: Tab) =>
    which === 'open'
      ? visibleOrders.filter((o) => orderBucket(effectiveStatus(o, cancelledUids)) === 'open')
      : visibleOrders.filter((o) => orderBucket(effectiveStatus(o, cancelledUids)) !== 'open');
  const openUids = visibleOrders.filter((o) => effectiveStatus(o, cancelledUids) === 'open').map((o) => o.uid);
  const TABS: {key: Tab; label: string}[] = [
    {key: 'open', label: t('vault.orders_open_short')},
    {key: 'recent', label: t('mobile.trade.recent')},
  ];

  /**
   * The tabs, as a pager: the label row and the swipe are two ways of moving the same selection.
   *
   * `tabPageH` is kept per tab so the pager can stand at the taller of the two and hand the
   * difference back — the asset directory's pager above does the same, and the note there explains
   * why the height cannot simply follow the page in view.
   */
  const tabPagerRef = React.useRef<ScrollView>(null);
  const tabX = React.useRef(new Animated.Value(0)).current;
  const [tabPageW, setTabPageW] = useState(0);
  const [tabPageH, setTabPageH] = useState<Record<string, number>>({});
  const tabIndex = (k: Tab) => TABS.findIndex((x) => x.key === k);
  /** Tapping the tab that is already showing asks how far back Recently reaches. */
  const pickTab = (k: Tab) => {
    if (k === tab) {
      if (k === 'recent') setWindowOpen(true);
      return;
    }
    setTab(k);
    if (tabPageW > 0) tabPagerRef.current?.scrollTo({x: tabIndex(k) * tabPageW, animated: true});
  };
  const onTabSettle = (x: number) => {
    if (tabPageW <= 0) return;
    const k = TABS[Math.max(0, Math.min(TABS.length - 1, Math.round(x / tabPageW)))]?.key;
    if (k && k !== tab) setTab(k);
  };
  const tabH = TABS.map((x) => tabPageH[x.key]);
  const tabSized = tabPageW > 0 && tabH.every((h) => h != null);
  const tallestTab = tabSized ? Math.max(...(tabH as number[])) : 0;
  const tabPagerStyle = tabSized
    ? {
        height: tallestTab,
        marginBottom: tabX.interpolate({
          inputRange: TABS.map((_, i) => i * tabPageW),
          outputRange: (tabH as number[]).map((h) => h - tallestTab),
          extrapolate: 'clamp' as const,
        }),
      }
    : undefined;
  // Market needs a pool on BOTH legs: the tokenized stocks are registered without the AMM-liquid bit
  // (no Uniswap market prices them) and the savings share has no pool either, so those pairs offer
  // the intent modes only.
  const marketable = pairAmmLiquid;
  // The owner can turn market trading off by setting market trade slippage in 24 hours to $0. Market
  // stays on the tabs, greyed: the sheet opens on Limit, and picking Market shows why it cannot be
  // placed — only there, never under Limit or TWAP.
  const marketOk = marketable && !marketOff;
  // Limit goes to the intent adapter, CoW or UniswapX; TWAP is a CoW order, offered only with CoW.
  const intentable = !!intent;
  const twapable = !!cowIntent;
  // Until the catalog has served guard categories, "not marketable" means "not known yet" — demoting
  // the default Market mode to Limit then would stick after the answer turned out to be yes.
  const ammKnown = ammLiquidKnown(network);
  // Keep the selected order type to one the network/pair actually supports: no AMM → no Market, no
  // intent adapter → no Limit/TWAP. If the current mode falls out of that set, drop to the first
  // that is still available.
  useEffect(() => {
    if (!ammKnown) return;
    const avail: Mode[] = [
      ...(marketable ? (['Market'] as Mode[]) : []),
      ...(intentable ? (['Limit'] as Mode[]) : []),
      ...(twapable ? (['TWAP'] as Mode[]) : []),
    ];
    if (avail.length && !avail.includes(mode)) setMode(avail[0]);
  }, [marketable, intentable, twapable, mode, ammKnown]);
  // Off when the read lands (the sheet may already be open on Market): over to Limit.
  useEffect(() => {
    if (marketOff && intentable && mode === 'Market') setMode('Limit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketOff, intentable]);
  // Market spends the vault balance and tops up from the positions by itself, so a named source has
  // no meaning there.
  useEffect(() => {
    if (mode === 'Market') setSpendSource('free');
  }, [mode]);

  // Switching order type starts the amounts over: what is spendable changes with it (Market reaches
  // the positions, Limit does not), so a figure typed under the old rules would silently be wrong.
  const onValidDays = (v: string) => {
    const digits = v.replace(/[^0-9]/g, '');
    setValidDays(digits);
    const n = Number(digits);
    if (n > 0) setValidSec(Math.min(n, MAX_VALID_DAYS) * 86400);
  };

  /**
   * The keyboard has gone: whatever is in the field now is the answer, so make it one the row shows.
   *
   * Empty (or a typed zero) hands the choice back to the chips. A number past the cap is rewritten
   * to the cap, because `onValidDays` clamps the SECONDS and left the text alone — so a field
   * reading "999" was really an order valid for 365 days.
   */
  const onValidDaysBlur = () => {
    const n = Number(validDays);
    if (!(n > 0)) {
      setValidDays('');
      setValidSec(lastPreset.current);
      return;
    }
    const clamped = Math.min(n, MAX_VALID_DAYS);
    setValidDays(String(clamped));
    setValidSec(clamped * 86400);
  };

  const explainMarketOff = () =>
    Alert.alert(t('mobile.trade.market_off_title'), t('mobile.trade.market_off'), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('mobile.vault.market_trade_loss_allowance'),
        onPress: () => {
          setSheetSide(null);
          nav.navigate('VaultRiskValue', {field: 'marketTradeDailyLossAllowance'});
        },
      },
    ]);
  const explainUntradable = () =>
    marketable && marketOff
      ? explainMarketOff()
      : Alert.alert(t('mobile.trade.not_tradable_title'), t('mobile.trade.not_tradable', {token: displaySymbol(baseSym)}));

  const pickMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setAmount('');
    setReceiveInput('');
    setValidDays('');
    setValidSec(lastPreset.current);
    setFundOn({vault: true, sky: false, aave: false});
    setFundAmt({vault: '', sky: '', aave: ''});
    setErr(null);
    setStatus('idle');
  };

  /**
   * No way to trade this pair here at all: no Market (a leg the guard cannot price, or no pool) and
   * no intent adapter for a Limit. The mode tabs were simply empty then, the sheet stayed on
   * Market, and a Buy or Sell opened a market form whose trade the vault refuses.
   */
  const untradable = ammKnown && !marketOk && !intentable;

  const MODES: {key: Mode; label: string}[] = [
    ...(marketable ? [{key: 'Market' as Mode, label: t('vault.market')}] : []),
    ...(intentable ? [{key: 'Limit' as Mode, label: t('vault.limit')}] : []),
    ...(twapable ? [{key: 'TWAP' as Mode, label: t('vault.twap')}] : []),
  ];
  /**
   * Who settles the order type currently selected.
   *
   * A market order goes to the AMM adapter and a limit or TWAP order is posted as an intent, so
   * the venue is the adapter category — read from the same registry the history rows name their
   * protocol from, not from a list kept here. A network without that category shows nothing.
   */
  /**
   * Who settles the order type currently selected, by name.
   *
   * The guard stores addresses and categories, not names, so an adapter deployed after this
   * build has none in the vendored registry — which is every chain's split trade adapter. The
   * server's service catalog does carry names (it is what the Allow list reads), so that is
   * asked first and the registry is the fallback. An adapter neither of them can name shows no
   * chip at all: a mark that cannot say what it is is worse than no mark.
   */
  const venues = useMemo(() => {
    const category = mode === 'Market' ? ('amm' as const) : ('intent' as const);
    const canonical = (category === 'amm' ? ammAdapters(network) : intentAdapters(network))[0];
    if (!canonical) return [];
    const service = services.find((s2) => s2.address.toLowerCase() === canonical.toLowerCase());
    const name =
      service?.name && isNamedProtocol(service.name) ? service.name : venueNames(network, category)[0];
    if (!name || !isNamedProtocol(name)) return [];
    // The catalog's icon travels with the name: a mark for an adapter deployed after this build
    // is not in the bundle, and the server has both.
    return [{name, uri: service?.icon}];
  }, [network, mode, services]);
  const busy = status === 'busy';
  // The sheet slides up and fills the screen below a strip of backdrop at the top: the keyboard then
  // opens over its lower half, where nothing is, so a tapped field is never covered and the sheet
  // itself never has to move.
  const insets = useSafeAreaInsets();
  const {height: screenHeight} = useWindowDimensions();
  // Same motion as every other sheet: rises, follows a downward drag, slides back out.
  // Tapping a prefilled field puts the caret after the number, not before it.
  const amountCaret = useEndCaret(amount);
  const priceCaret = useEndCaret(price);
  const partsCaret = useEndCaret(parts);
  const receiveCaret = useEndCaret(receiveInput);

  /**
   * The Buy / Sell bar gets out of the way while the page is being read.
   *
   * It is pinned over the bottom of a page that keeps going — the chart, the form, then every order
   * the pair has ever had — so on the part of the page furthest from "I want to trade now" it is
   * covering content and nothing else. Advancing down the page therefore drops it, and coming back
   * up brings it straight back, which is where the buttons are wanted.
   *
   * A THRESHOLD, not every pixel: a bar that follows the finger exactly flickers on the small
   * reversals a scroll always has, and the bounce at either end of the list is a direction change
   * too. Eight points of travel in one direction is a deliberate move; less is noise.
   *
   * Native driver, so the slide runs on the UI thread and does not stutter against the list it is
   * sliding over.
   */
  const barHidden = useRef(false);
  const barLast = useRef(0);
  const barY = useRef(new Animated.Value(0)).current;
  /**
   * How far it travels to be gone: its own height PLUS the offset it is parked at.
   *
   * Not a constant, and that was the bug. The bar sits `bottom: barBottom` above the screen edge,
   * so its top edge starts `barBottom + BAR_HEIGHT` up — and a fixed 142 left roughly twenty
   * points of it on screen, which is exactly the part with the top of the buttons in it. Measured
   * from where it actually is, it clears on every device rather than on the one it was tuned for.
   *
   * The extra 8 is for the hairline: a shadow or an antialiased edge peeking is the same bug again
   * at one pixel, and eight points of overshoot costs nothing.
   */
  const barBottom = Math.max(tabBarHeight, insets.bottom);
  const BAR_SLIDE = BAR_HEIGHT + barBottom + 8;
  /**
   * The top of the page, where the bar stays put whatever the scroll does.
   *
   * Two uses, and the same reason behind both: near the top the buttons are what the screen is
   * for. A page with less than this much to scroll never hides them either — there is nothing
   * underneath worth revealing, and a bar that disappears on a page that barely moves reads as a
   * glitch.
   */
  const BAR_ZONE = 140;
  const BAR_THRESHOLD = 8;
  // How far the finger must travel in ONE direction, since the last change, before the bar flips.
  // Eight points was too little — a drag's natural small reversals each cleared it, so the bar
  // flickered show/hide mid-scroll. A deliberate run is tens of points; this is the hysteresis that
  // tells the two apart.
  const BAR_REVEAL = 36;
  const showBar = (hide: boolean) => {
    if (barHidden.current === hide) return;
    barHidden.current = hide;
    Animated.timing(barY, {toValue: hide ? BAR_SLIDE : 0, duration: 180, useNativeDriver: true}).start();
  };
  const onPageScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = e.nativeEvent;
    const end = contentSize.height - layoutMeasurement.height;
    /**
     * Clamped at the end, because the RUBBER BAND is not a direction change.
     *
     * Reaching the bottom, iOS pulls the content past the last row and springs it back, and the
     * spring reports a decreasing offset — which this read as scrolling up, so the bar came back
     * exactly where there is most to look at. Clamping means the overscroll and its return are the
     * same position, which is what they are: the list did not move, the frame did.
     */
    const y = Math.min(contentOffset.y, end);
    // Nothing worth revealing: keep the bar if the page cannot scroll by even its own height. Keyed
    // to the bar, not a fixed 140 — the pushed pair screen has no tab bar, so its viewport is taller
    // and its scrollable distance correspondingly shorter, and a 140 floor there suppressed the hide
    // on lists that dismiss fine on the (tab-bar-shortened) in-tab screen.
    if (end <= BAR_HEIGHT) {
      showBar(false);
      barLast.current = y;
      return;
    }
    const dy = y - barLast.current;
    // Re-anchor and act only after a deliberate run (BAR_REVEAL), so small back-and-forth within a
    // drag neither re-anchors nor flips the bar — that back-and-forth was the flashing.
    if (Math.abs(dy) < BAR_REVEAL) return;
    barLast.current = y;
    // At the very end, leave it as it is. Momentum can still deliver a frame or two of reversal
    // after the clamp — the deceleration settling — and the end of the list is the last place the
    // bar should be reappearing over.
    if (y >= end - BAR_THRESHOLD) return;
    // Within BAR_ZONE of the top the bar stays: that part of the page is the trading half of it.
    showBar(dy > 0 && y > BAR_ZONE);
  };

  const onPull = () => {
    setPulled(true);
    setRefreshNonce((n) => n + 1);
    balances.refresh();
    refreshOrders();
    // The reads are short; the spinner clears on its own rather than waiting on each of them.
    setTimeout(() => setPulled(false), 1200);
  };

  /**
   * The two amount fields, hoisted so the sheet can order them as the web does.
   *
   * Each label follows its TOKEN, not the side: the base asset is always "Amount" and the
   * stablecoin always "Total". On a buy you pay the stablecoin, so Total is the pay field; on a
   * sell you pay the base, so Amount is. Labelling by side instead ("You pay") made the same
   * number change its name depending on which way round the trade was.
   */
  const payField = (
    <>
      {/* What can be spent, above the field that spends it — the same line the Earn form carries.
          It is the figure Max fills, less whatever the relayer's reserve holds back, so it is the
          real ceiling and not just the balance. Tapping it is Max. */}
      <AvailableLine amount={Number(spendBal)} symbol={spendSym} onPress={maxPay} />
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{shownSide === 'buy' ? t('vault.total') : t('vault.trade_amount')}</Text>
        <View style={styles.fieldRight}>
          <TextInput style={[styles.fieldInput, overBalance && styles.fieldInputOver]} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={c.subtext} value={amount} onChangeText={applyPay} {...amountCaret} />
          {/* One control, like the Send rows: Max over an empty field, Clear over a filled one.
              Offering Max beside a number the user has already typed asks them to work out
              whether it would replace what is there. */}
          {Number(amount) > 0 ? (
            <ClearBtn onPress={() => applyPay('')} />
          ) : balKnown && Number(spendBal) > 0 ? (
            <Pressable onPress={maxPay} style={styles.maxPill}>
              <Text style={styles.maxText}>{t('common.max')}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.sourcePill} onPress={() => setPicker('source')}>
            <TokenIcon symbol={spendSym} size={20} />
            <Text style={styles.fieldSym}>{displaySymbol(spendSym)}</Text>
            {spendSource !== 'free' ? (
              <Text style={styles.sourceTag}>{spendSource === 'yield' ? t('vault.yielding') : t('vault.lending')}</Text>
            ) : null}
          </Pressable>
        </View>
      </View>
      {/* The error stays with the field that caused it — the pay field, which is the base on a
          sell and the total on a buy, so it travels with it rather than sitting at a fixed place
          in the form. */}
      {overBalance ? (
        <Text style={styles.overText}>
          {t('vault.exceeds_balance')} · <Amount v={fmtNum(Number(spendBal))} /> {displaySymbol(spendSym)}
        </Text>
      ) : null}
    </>
  );
  const receiveField = (
    <View style={styles.field}>
      {/* The ≈ stays on a market order, where the figure really is an estimate that moves with
          the pool. A limit or TWAP order has a price the user set, so this side is exactly what
          it says — a ≥ implied the fill might be better than asked, which is not what it meant. */}
      <Text style={styles.fieldLabel}>
        {shownSide === 'buy' ? t('vault.trade_amount') : t('vault.total')}
        {mode === 'Market' ? ' ≈' : ''}
      </Text>
      <View style={styles.fieldRight}>
        <TextInput style={styles.fieldInput} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={c.subtext} value={receiveInput} onChangeText={applyReceive} {...receiveCaret} />
        <TokenIcon symbol={recvSym} size={20} />
        <Text style={styles.fieldSym}>{displaySymbol(recvSym)}</Text>
      </View>
    </View>
  );
  /** The base asset's line leads, the stablecoin total closes — with the slider between them. */
  const baseField = shownSide === 'buy' ? receiveField : payField;
  const totalField = shownSide === 'buy' ? payField : receiveField;
  /**
   * The pay amount as a whole percent of what is available, and the setter the slider drives.
   *
   * Driven off the PAY field in both directions, because that is the one bounded by a balance —
   * a percentage of what you are receiving has nothing to be a percentage of.
   */
  /**
   * What the order sheet puts ON TOP of itself: the funding sheet, the asset and slippage pickers,
   * and the toast host.
   *
   * Handed to {FormSheet} as its `overlay` because a sheet presented from OUTSIDE the order sheet
   * opens behind it — it belongs to a hierarchy the card is already covering. They were nested in
   * the Modal by hand before the chrome became a component; this is the same mounting point, named.
   */
  const orderOverlay = (
    <>
      {/* Funding, for a market order. One tickable row per source: the vault's own balance,
              and each position that pays out instantly. Ticking a row puts all of it into the
              order and opens the quick percentages and a field to take less. A market swap
              withdraws and trades in one transaction, so a position is a source like any other —
              its only cost is the yield it stops earning, which is why the rate is on the row.
              Limit and TWAP orders get the same rows, but the tick picks ONE source: they settle
              later and sell a single token. See {limitSources}. */}
          <Sheet
              visible={picker === 'source'}
              title={t('vault.asset')}
              onClose={() => setPicker(null)}
              // Ticks and amounts apply as they are made, so closing confirms: "Done", not ✕.
              done
              // Taller than a plain picker: three rows, each with a keypad target and a row of
              // fractions, and the keyboard has to leave something to read.
              height={Math.round(screenHeight * 0.8)}>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {mode === 'Market' ? (
                  <>
                {/* Labelled exactly as the limit sheet labels the same three things, so the two
                    read as one list with a tick added. */}
                {([
                  ['vault', displaySymbol(spendSym), `${t('vault.balance')} · ${fmtNum(fundCap.vault)}`] as const,
                  [
                    'sky',
                    `${displaySymbol(spendSym)} ${t('vault.yielding')}`,
                    `${fmtNum(fundCap.sky)} ${displaySymbol(spendSym)}${skyApy != null ? ` · ${t('mobile.earn.apy_rate', {rate: skyApy.toFixed(2)})}` : ''}`,
                  ] as const,
                  [
                    'aave',
                    `${displaySymbol(spendSym)} ${t('vault.lending')}`,
                    `${fmtNum(fundCap.aave)} ${displaySymbol(spendSym)}${aaveApy != null ? ` · ${t('mobile.earn.apy_rate', {rate: aaveApy.toFixed(2)})}` : ''}`,
                  ] as const,
                ] as const).map(([key, label, sub]) =>
                  fundCap[key] > 0 || key === 'vault' ? (
                    <FundRow
                      key={key}
                      label={label}
                      sub={sub}
                      symbol={spendSym}
                      cap={fundCap[key]}
                      on={fundOn[key]}
                      amount={fundAmt[key]}
                      onToggle={() => toggleFunding(key)}
                      onAmount={(v) => applyFunding({...fundOn, [key]: true}, {...fundAmt, [key]: v})}
                      onCommit={() => {
                        // Edited down to nothing means the source is out of the order, so the tick
                        // goes with it — otherwise a ticked row would keep its balance counted as
                        // available while contributing none of it.
                        if (!(Number(fundAmt[key]) > 0)) applyFunding({...fundOn, [key]: false}, {...fundAmt, [key]: ''});
                      }}
                    />
                  ) : null,
                )}
                  </>
                ) : (
                  limitSources.map((r) => (
                    <FundRow
                      key={r.key}
                      label={r.label}
                      sub={r.sub}
                      symbol={spendSym}
                      cap={r.cap}
                      on={spendSource === r.key}
                      amount={spendSource === r.key ? amount : ''}
                      // Ticking moves the order onto this source with all of it; unticking a
                      // position falls back to the free balance, which is always the default.
                      onToggle={() => {
                        const on = spendSource !== r.key;
                        setSpendSource(on ? r.key : 'free');
                        applyPay(on ? String(r.cap) : '');
                      }}
                      onAmount={(v) => {
                        setSpendSource(r.key);
                        applyPay(v);
                      }}
                      onCommit={() => {
                        if (!(Number(amount) > 0) && r.key !== 'free') setSpendSource('free');
                      }}
                    />
                  ))
                )}
                {/* The same row the limit sheet's list ends on, in this sheet's own language: a
                    FundRow that cannot be ticked. See {reserveRow}. */}
                {reserveRow ? (
                  <FundRow
                    inert
                    label={reserveRow.label}
                    sub={reserveRow.sub}
                    symbol={spendSym}
                    cap={0}
                    on={false}
                    amount=""
                    onToggle={() => {}}
                    onAmount={() => {}}
                    onCommit={() => {}}
                  />
                ) : null}
              </ScrollView>
            </Sheet>
          {/* Inside the order like the source picker above: a sheet presented from outside
              it would open behind the one the user is looking at. */}
          <PickerSheet
            visible={picker === 'slippage'}
            title={t('mobile.trade.max_slippage')}
            items={SLIPPAGE_CHOICES.map((bps) => ({key: String(bps), label: `${bps / 100}%`}))}
            selected={String(slippage)}
            onSelect={(key) => {
              const bps = Number(key);
              setSlippageBps(bps);
              setSlippage(bps);
            }}
            onClose={() => setPicker(null)}
          />
          <ToastHost />
    </>
  );

  const payPct = Number(spendBal) > 0 ? (Number(amount) / Number(spendBal)) * 100 : 0;
  const setPayPct = (p: number) => applyPay(p >= 100 ? spendBal : toField((Number(spendBal) * p) / 100));

  /**
   * Every row of ONE tab, newest first — see the list's own note at the panel below.
   *
   * A function of the tab rather than of `tab`, because both tabs are built at once now: they are
   * the two pages of a pager, so the one not being looked at has to exist to be swiped to.
   */
  const orderList = (which: Tab) => {
    const rows: {at: number; node: React.ReactElement<{last?: boolean}>}[] = [];
    for (const g of twapsFor(which)) {
      const {sellM, buyM, isBuy, partSell, partBuy, twapPx} = twapFacts(g);
      const key = `twap-${g.appData}`;
      const isExp = expanded.has(key);
      /**
       * The schedule's slots, oldest first — ALL of them, not just the posted ones.
       *
       * `g.parts` is what CoW has been given so far, newest first, and a TWAP is posted one
       * slot at a time as its clock comes round: an hour into a ten-part order, two orders
       * exist and eight do not. Listing only those two read as lost data, so the slots yet
       * to go out are listed too, each with the time it is due — which is the thing a reader
       * opening a running TWAP actually wants to know.
       */
      const slots = [...g.parts].reverse();
      const legM = isBuy ? buyM : sellM;
      const perPart = isBuy ? partBuy : partSell;
      /**
       * Every part line carries a price, filled or not.
       *
       * A filled one carries what it GOT; the rest carry what the schedule will take — the
       * limit the whole order was placed at, which is the same for every slot. Without it a
       * reader comparing the column had to hold the limit in their head from the Details
       * sheet to see whether a fill came in above or below it, and the slots still to come
       * gave no hint of what they were waiting for.
       */
      const canCancel = g.bucket === 'open' && !!intent;
      /**
       * A finished schedule states what it DID; a running one states what it is for.
       *
       * While parts are still going out, the figure that means something is the order's own
       * size — the thing the user asked for — with the fraction beside it saying how far in
       * it is. Once it is over, that number is a plan that no longer exists: a TWAP can end
       * cancelled or expired with two slots of ten behind it, and a row reading the full
       * amount claimed a trade that never happened. So a finished row adds up what actually
       * settled, on the leg it names, and drops the fraction — "3/3" next to a final total
       * is the same thing said twice, and "2/10" next to one is an apology.
       */
      const finished = g.bucket === 'finished';
      /** The quote leg actually paid or received, for the average below. */
      const settledQuote = g.parts.reduce(
        (sum, pt) =>
          sum +
          Number(
            formatUnits(
              BigInt((isBuy ? pt.executedSellAmount : pt.executedBuyAmount) ?? '0'),
              (isBuy ? sellM : buyM).decimals,
            ),
          ),
        0,
      );
      const settledAmt = g.parts.reduce(
        (sum, pt) =>
          sum +
          Number(
            formatUnits(
              BigInt((isBuy ? pt.executedBuyAmount : pt.executedSellAmount) ?? '0'),
              legM.decimals,
            ),
          ),
        0,
      );
      rows.push({at: twapPlacedAt(g), node: (
        <OrderRow
          key={key}
          badge={words(t('vault.twap'), sideWord(isBuy))}
          /* A schedule has no status of its own: it ended badly if it was called off, or if
             its window closed on slots it never got through. See {twapTimeLine}. */
          outcome={twapStatus(g)}
          /**
           * And WHEN — which the row never said at all.
           *
           * Every other finished row on this panel carries its time at the foot-right, and
           * a schedule's is the one most worth having: a TWAP runs for days, so "it
           * filled" without "when" leaves the reader to open the row and read the slots.
           * Filled says when the last slot landed, expired says when the window closed,
           * cancelled says when it was called off. See {twapTimeLine}.
           */
          outcomeAt={(() => {
            const line = twapTimeLine(g, {
              cancelled:
                g.parts.reduce<number | undefined>((at, pt) => at ?? cancelAt.get(pt.uid.toLowerCase()), undefined) ??
                cancelledAtAny(g.parts.map((pt) => pt.uid)),
              filled: twapFilledAt(g, (uid) => fillAt.get(uid)),
            });
            return line ? whenText(line, t, language) : undefined;
          })()}
          leg={{amount: fmtShort(finished ? settledAmt : perPart * g.total), symbol: legM.symbol}}
          /* The average of the slots that filled, which is the whole point of a TWAP and the
             one figure its row never carried. */
          price={fmtPrice(finished && settledAmt > 0 ? settledQuote / settledAmt : twapPx)}
          /**
           * The parts, and nothing else.
           *
           * A TWAP is a schedule, so what a reader opens it for is where the schedule has
           * got to — which slice filled at what, and when the next one goes out. The terms
           * it was placed on (pay, receive, limit price, window) are read once when the
           * order is placed and almost never again, so they are behind Details: six
           * label-and-value lines above the parts pushed the only live thing on the panel
           * off the bottom of a phone.
           */
          parts={Array.from({length: Math.max(g.total, slots.length)}, (_, i): OrderPart => {
            const pt = slots[i];
            if (!pt) {
              // Still to come. CoW is handed each slot as its turn arrives, one
              // `partDuration` after the last — so the time is arithmetic, not a lookup.
              const due = g.schedule.startTime + i * g.schedule.partDuration;
              return {
                label: `${fmtShort(perPart)} ${displaySymbol(legM.symbol)}${atPrice(twapPx)}`,
                state: fmtDue(due),
                pending: true,
              };
            }
            /**
             * A posted part: the asset, then the price it went at.
             *
             * It used to print both legs — "284.13 USDC → 3.33 CRCL" — which is the same
             * shape the ROW above was changed away from, and for the same reason: the two
             * figures are one trade said twice, and the part of it a reader compares
             * between lines is the price, which was the one thing not written down. The leg
             * shown is the one the row names, so a column of parts adds up to the order's
             * own total.
             *
             * The ratio is the EXECUTED one, fee and all — Details carries the limit the
             * schedule was placed at, and the gap between them is what a reader is looking
             * for.
             */
            const ps = effectiveStatus(pt, cancelledUids);
            const done = ps.toLowerCase().includes('fulfil');
            const sold = Number(formatUnits(BigInt(pt.executedSellAmount ?? '0'), sellM.decimals));
            const recv = Number(formatUnits(BigInt(pt.executedBuyAmount ?? '0'), buyM.decimals));
            const got = isBuy ? recv : sold;
            const px = got > 0 ? (isBuy ? sold : recv) / got : NaN;
            // Posted but not filled: the part's own size, with nothing to price.
            const sized = Number(
              formatUnits(BigInt((isBuy ? pt.buyAmount : pt.sellAmount) ?? '0'), legM.decimals),
            );
            return {
              // Filled: what it went at. Posted and waiting: what it is waiting for.
              label: `${fmtShort(done ? got : sized)} ${displaySymbol(legM.symbol)}${atPrice(done ? px : twapPx)}`,
              state: t(statusPill(ps).key),
            };
          })}
          onDetails={() => setTwapInfo(g.appData)}
          cancel={
            canCancel ? (
              <Pressable
                onPress={() =>
                  ask({
                    title: t('mobile.actions.cancel_intent'),
                    gas: relayGasFor({}),
                    run: () => onCancelTwap(g),
                  })
                }
                disabled={cancellingTwap === g.appData}
                hitSlop={8}>
                <Text style={styles.cancelInline}>
                  {cancellingTwap === g.appData ? t('mobile.trade.cancelling') : t('vault.cancel')}
                </Text>
              </Pressable>
            ) : undefined
          }
          expanded={isExp}
          onPress={() => openOrderRow(key, g.rep.sellToken, g.rep.buyToken, isExp)}
        />
      )});
    }
    for (const o of ordersFor(which).slice(0, 30)) {
      const es = effectiveStatus(o, cancelledUids);
      const sp = statusPill(es);
      const sellM = assetMeta(network, o.sellToken as Address);
      const buyM = assetMeta(network, o.buyToken as Address);
      // Receipt-token legs read as their underlying — see {legRate}.
      const legSym = (addr: string, fallback: string) => underlyingOf(network, addr) ?? fallback;
      const sellNum = Number(formatUnits(BigInt(o.sellAmount), sellM.decimals)) * legRate(o.sellToken);
      const buyNum = Number(formatUnits(BigInt(o.buyAmount), buyM.decimals)) * legRate(o.buyToken);
      const sellSym = legSym(o.sellToken, sellM.symbol);
      const buySym = legSym(o.buyToken, buyM.symbol);
      const fromPosition = !!underlyingOf(network, o.sellToken);
      // A TWAP part carries a salted appData; a limit order one of the fixed ones.
      const isTwap = !!o.appData && !LIMIT_APP_DATA_HASHES.has(o.appData.toLowerCase());
      // Price quoted in the stable leg when there is one, else base-per-quote by side. See {stableLike}.
      const sellIsStable = stableLike(o.sellToken);
      const buyIsStable = stableLike(o.buyToken);
      const px0 =
        sellIsStable || buyIsStable
          ? (sellIsStable ? sellNum : buyNum) / (sellIsStable ? buyNum : sellNum)
          : o.kind === 'buy'
            ? sellNum / buyNum
            : buyNum / sellNum;
      const px = px0 / (o.kind === 'buy' ? 1 + PARTNER_FEE : 1 - PARTNER_FEE);
      // Buy or sell the ASSET: paying a stablecoin to receive something else is a buy,
      // whichever way round CoW encodes it (every order is posted as a sell of the pay leg,
      // so o.kind would call a CRCL purchase a sell of USDC).
      const isBuy = sellIsStable && !buyIsStable;
      /**
       * An OPEN row starts expanded; everything else starts shut.
       *
       * An open order is the one the owner still has a decision to make about — its terms,
       * its deadline and its Cancel are the reason the row is on screen — so making them
       * all a tap away was asking for a tap that nobody would skip. A finished row is a
       * record and opens only when asked.
       *
       * The set therefore holds rows TOGGLED FROM their default rather than opened ones,
       * which is what lets both defaults live in one piece of state.
       */
      const isExp = es === 'open' ? !expanded.has(o.uid) : expanded.has(o.uid);
      const canCancel = es === 'open' && !!intent;
      const filled = es.toLowerCase().includes('fulfil');
      const filledAt = fillAt.get(o.uid.toLowerCase());
      const when = orderTimeLine(o, es, {
        filled: filledAt,
        cancelled: cancelAt.get(o.uid.toLowerCase()) ?? cancelledAt(o.uid),
      });
      // What it GOT, not what it asked for: a limit order can fill better than its limit.
      const execSell = Number(formatUnits(BigInt(o.executedSellAmount ?? '0'), sellM.decimals)) * legRate(o.sellToken);
      const execBuy = Number(formatUnits(BigInt(o.executedBuyAmount ?? '0'), buyM.decimals)) * legRate(o.buyToken);
      /**
       * What it GOT if it filled, what it ASKED if it has not — the Order history rows
       * read the same way. A row with no price at all was the common case here, since
       * most of what sits in Open and Cancelled never executed.
       */
      const avgPx =
        filled && execSell > 0 && execBuy > 0 ? (isBuy ? execSell / execBuy : execBuy / execSell) : px;
      rows.push({at: placedAt(o), node: (
        <OrderRow
          key={o.uid}
          /* The side, and the type where the list holds more than one kind. Open and
             Cancelled are limit orders unless they say TWAP, so naming the type there
             spends a word on what the list already is. FINISHED is the exception:
             completed market swaps sit in it too, and against a row reading "Market Buy"
             a bare "Buy" looked like a different, nameless thing rather than the limit
             order it is. */
          badge={words(t(isTwap ? 'vault.twap' : 'vault.limit'), sideWord(isBuy))}
          leg={{amount: fmtShort(isBuy ? buyNum : sellNum), symbol: isBuy ? buySym : sellSym}}
          price={fmtPrice(avgPx)}
          /* Only a sell can come out of a position, and only the leg on screen can say
             so — on a buy the paying leg is not shown at all. */
          note={!isBuy && fromPosition ? `(${t('vault.yielding')})` : undefined}
          /* Every order says what became of it, at the foot — the one place a row with
             no parts has room to. An order still working says what it is waiting for
             instead of a verdict: "Expires · 2d 5h". See {OrderRow}'s `outcome`. */
          outcome={
            sp.key === 'vault.open'
              ? when
                ? {label: t(when[0])}
                : undefined
              : {label: t(sp.key), tone: sp.tone}
          }
          outcomeAt={when ? whenText(when, t, language) : undefined}
          /**
           * Cancel sits at the foot, on the left — where the TWAP rows have always put it,
           * and where every list in this app puts a destructive control.
           *
           * It was in the head's right-hand corner, which is the column the amount reads
           * in on every other row: a tappable word there made the one figure the row is
           * about share its place with a control. At the foot it has the corner to itself
           * and the deadline keeps the opposite end.
           */
          cancel={
            canCancel ? (
              <Pressable
                onPress={(ev) => {
                  ev.stopPropagation();
                  ask({
                    title: t('mobile.actions.cancel_intent'),
                    message: describeOrder(o, network),
                    gas: relayGasFor({}),
                    run: () => onCancel(o),
                  });
                }}
                disabled={cancelling === o.uid}
                hitSlop={8}>
                <Text style={styles.cancelInline}>{cancelling === o.uid ? t('mobile.trade.cancelling') : t('common.cancel')}</Text>
              </Pressable>
            ) : null
          }
          /**
           * The OTHER leg, and a time.
           *
           * The head already states the one the order is for — what a buy buys, what a
           * sell sells — so printing both here made the first line of the panel a copy of
           * the line above it. A trade has two ends and the row shows one, so the panel
           * shows the one the row does not.
           *
           * The date that goes with it is at the foot, beside the word it belongs to —
           * see {orderTimeLine} for which one is still a fact.
           */
          lines={[
            isBuy
              ? [t('vault.pay'), {amount: fmtShort(sellNum), symbol: sellSym}]
              : [t('vault.receive'), {amount: fmtShort(buyNum), symbol: buySym}],

          ]}
          expanded={isExp}
          onPress={() => openOrderRow(o.uid, o.sellToken, o.buyToken, isExp)}
        />
      )});
    }
    if (which === 'recent')
      for (const m of marketFinished.slice(0, 30)) {
      const soldIsStable = stables.some((s) => s.address.toLowerCase() === m.sold.address.toLowerCase());
      const isBuy = soldIsStable; // spent a stablecoin to acquire the crypto leg
      const px = soldIsStable ? m.sold.amount / m.bought.amount : m.bought.amount / m.sold.amount;
      const isExp = expanded.has(m.txHash);
      rows.push({at: tradeAt(m), node: (
        <OrderRow
          key={m.txHash}
          badge={words(t('vault.market'), sideWord(isBuy))}
          leg={{
            amount: fmtShort(isBuy ? m.bought.amount : m.sold.amount),
            symbol: isBuy ? m.bought.symbol : m.sold.symbol,
          }}
          price={fmtPrice(px)}
          /* The corner is free on a market row — nothing is cancellable about a swap
             that has already happened — so the amount reads there, in the column the
             rest of the screen puts numbers in. */
          right={null}
          /* The OTHER leg, only: the head states the one the swap was for. */
          lines={[
            isBuy
              ? [t('mobile.trade.paid'), {amount: fmtShort(m.sold.amount), symbol: m.sold.symbol}]
              : [t('vault.received'), {amount: fmtShort(m.bought.amount), symbol: m.bought.symbol}],
          ]}
          /* A swap has one ending and it already happened. */
          outcome={{label: t('vault.fulfilled'), tone: 'green'}}
          outcomeAt={m.ts ? fmtExpiry(m.ts, language) : undefined}
          expanded={isExp}
          onPress={() => openOrderRow(m.txHash, m.sold.address, m.bought.address, isExp)}
        />
      )});
      }
    for (const x of failedSwaps.filter(({a}) =>
      // Open: the in-flight ones. Recently: only those that have come to rest (reverted/refused),
      // never a swap still submitting — an in-flight swap is an open order, not history.
      which === 'open' ? a.status === 'submitted' : a.status !== 'submitted',
    )) {
      const {a, trade: tr} = x;
      const leg = tr!.buy ? tr!.bought : tr!.sold;
      const key = `relay-${a.id}`;
      rows.push({at: a.at, node: (
        <OrderRow
          key={key}
          badge={words(t('vault.market'), sideWord(tr!.buy))}
          leg={{amount: fmtShort(leg.amount), symbol: leg.symbol}}
          /* The price it was ASKED at — it never got one of its own. */
          price={
            tr!.sold.amount > 0 && tr!.bought.amount > 0
              ? fmtPrice(tr!.buy ? tr!.sold.amount / tr!.bought.amount : tr!.bought.amount / tr!.sold.amount)
              : undefined
          }
          right={null}
          /** Pay / Receive, and why it did not happen. */
          lines={[
            tr!.buy
              ? [t('vault.pay'), {amount: fmtShort(tr!.sold.amount), symbol: tr!.sold.symbol}]
              : [t('vault.receive'), {amount: fmtShort(tr!.bought.amount), symbol: tr!.bought.symbol}],
            /* Why, where the relayer said why — the only account of a refusal, since
               nothing was sent and there is no receipt to read. */
            ...(a.reason ? [[t('vault.status'), a.reason] as [string, string]] : []),
          ]}
          /* In flight has no verdict to report. Past that: refused by the chain, or
             never included at all — the owner's next move is not the same, so the two
             do not share a word. */
          outcome={
            a.status === 'submitted'
              ? {label: t('mobile.app.submitting'), tone: 'sky'}
              : {
                  label: t(a.status === 'refused' ? 'vault.tx_not_included' : 'vault.failed'),
                  tone: 'rose',
                }
          }
          outcomeAt={fmtExpiry(a.at, language)}
          /**
           * Shut until asked, and a tap opens it — as every other row on this panel is.
           *
           * {OrderRow} defaults `expanded` to TRUE, because the order history opens
           * everything and never folds. Passing neither this nor `onPress` therefore left
           * the one row on this panel that was always open and could not be closed.
           *
           * No pair switch on the way in, unlike a completed swap: a failed attempt is
           * already on the pair it was for, and with the legs decoded from a batch there
           * is no address to point the chart at.
           */
          expanded={expanded.has(key)}
          onPress={() => toggleExpanded(key)}
        />
      )});
    }
    // The window, on Recently only — the same predicate the tab's count uses, so the two
    // cannot disagree. See {inRecentWindow}.
    if (which === 'recent')
      for (let i = rows.length - 1; i >= 0; i--)
        if (!inRecentWindow(rows[i].at)) rows.splice(i, 1);
    rows.sort((a, b) => b.at - a.at);
    if (rows.length === 0)
      return <Text style={styles.empty}>{t(`mobile.trade.no_${which}_orders`)}</Text>;
    // The card's own padding frames the list: the last row adds no bottom padding.
    return rows.map((r, i) => React.cloneElement(r.node, {last: i === rows.length - 1}));
  };

  return (
    <>
      <ScrollView showsVerticalScrollIndicator={false}
        ref={pageRef}
        alwaysBounceVertical
        // The bar floats, so its height is reserved HERE or the last row sits under it for good on
        // a page short enough that the bar never hides. See {styles.bar}.
        contentContainerStyle={[
          styles.body,
          // Reserve against where the bar ACTUALLY sits (barBottom), not the tab-bar height — on the
          // pushed pair screen there is no tab bar (tabBarHeight 0) but the bar still floats above the
          // home indicator, so keying the padding to tabBarHeight left the last rows under the bar and
          // the scroll-hide misjudging the content height.
          {paddingTop: 8, paddingBottom: barBottom + 16 + (isPair ? BAR_HEIGHT : 0)},
        ]}
        contentInset={{top: headerHeight}}
        contentOffset={{x: 0, y: -headerHeight}}
        scrollIndicatorInsets={{top: headerHeight}}
        automaticallyAdjustContentInsets={false}
        refreshControl={<RefreshControl refreshing={pulled} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={onPageScroll}
        // 16ms would fire the handler on every frame for a comparison that only matters when it
        // crosses a threshold; 64 is four times a second, which is well inside what the eye reads
        // as immediate.
        scrollEventThrottle={64}>
        <View style={styles.headerRow}>
          {isPair ? (
            <>
              <View style={styles.pair}>
                <Pressable style={styles.pairPart} onPress={pickBase}>
                  <TokenIcon symbol={baseSym} size={22} />
                  <Text style={styles.pairText}>{displaySymbol(baseSym)}</Text>
                </Pressable>
                <Text style={styles.pairSlash}>/</Text>
                <Pressable style={styles.pairPart} onPress={pickQuote}>
                  <TokenIcon symbol={quoteSym} size={22} />
                  <Text style={styles.pairText}>{displaySymbol(quoteSym)}</Text>
                </Pressable>
              </View>
              {/* A tap opens the full position — amount, cost, today's P&L, every figure — as a
                  sheet. A pie mark, not the day's number: a figure in dollars up here read as the
                  asset's price, which is the one thing it is not. Always present on a pair, even
                  before there is a position: the sheet then simply reads zeros. */}
              <Pressable
                style={styles.positionBtn}
                onPress={() => setShowPosition(true)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.trade.position')}>
                <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
                  <Ellipse cx={12} cy={6} rx={6.5} ry={2.6} stroke={c.subtext} strokeWidth={2} />
                  <Path d="M5.5 6v4c0 1.44 2.91 2.6 6.5 2.6s6.5-1.16 6.5-2.6V6" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  <Path d="M5.5 10v4c0 1.44 2.91 2.6 6.5 2.6s6.5-1.16 6.5-2.6v-4" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                </Svg>
              </Pressable>
            </>
          ) : null}
        </View>

        {/* The market directory: categories switch the list.
            A whole row opens that asset's own trade page, so there is nothing to expand here —
            what the vault holds in a position is the Overview's question, not this one. */}
        {!isPair ? (
          <>
            <View style={styles.catWrap}>
                  <View style={styles.catLine}>
                    {searching ? (
                      <TextInput
                        style={styles.searchInput}
                        autoFocus
                        placeholder={t('mobile.trade.search_assets')}
                        placeholderTextColor={c.subtext}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        value={query}
                        onChangeText={setQuery}
                      />
                    ) : (
                      // Shown even when the network has only one category. A lone "Crypto" still
                      // says what the list below it is, and hiding it made Base open on an
                      // unlabelled card. An empty `tabs` renders nothing and just holds the space.
                      <View style={styles.catFlex}>
                        <CategoryTabs
                          tabs={pages.map((k) => ({
                            key: k,
                            label:
                              k === 'selected'
                                ? t('vault.selected')
                                : k === 'crypto_native'
                                  ? t('mobile.home.category_crypto')
                                  : t(`vault.category_${k}`),
                          }))}
                          value={category}
                          onChange={pickCategory}
                        />
                      </View>
                    )}
                    <Pressable
                      style={styles.searchBtn}
                      hitSlop={8}
                      onPress={() => {
                        setSearching((v) => !v);
                        setQuery('');
                      }}>
                      <SearchIcon open={searching} color={c.subtext} />
                    </Pressable>
                  </View>
                </View>

                {query.trim() ? (
                  <View style={styles.listCard}>
                    {results.length > 0 ? (
                      results.map(assetRow)
                    ) : (
                      <Text style={styles.emptySearch}>{t('vault.no_assets')}</Text>
                    )}
                  </View>
                ) : (
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
                              // The layout event is recycled before a state updater runs.
                              const h = e.nativeEvent.layout.height;
                              setPageH((prev) => (prev[k] === h ? prev : {...prev, [k]: h}));
                            }}>
                            <View style={styles.listCard}>{inCategory(k).map(assetRow)}</View>
                          </View>
                        </View>
                      ))}
                    </Animated.ScrollView>
                  ) : null}
                </View>
                )}
          </>
        ) : null}

        {isPair ? <PriceChart symbol={baseSym} reload={refreshNonce} /> : null}

        {/* Orders — the pair screen's own history, not the directory's. */}
        {isPair ? (
        <View style={styles.card}>
          <View style={styles.orderTabs}>
            <View style={styles.orderTabsLeft}>
              {TABS.map((x) => (
                /**
                 * Tap to select the tab; tap the SELECTED one again to set how far back it reaches.
                 *
                 * The window was two taps away in the ⋯ sheet, for a list in plain view — which is
                 * where a setting goes to be never found. On the tab it governs, the gesture is the
                 * one the thing itself invites. Nothing is written on the tab to advertise it: the
                 * span and a caret beside the count made a tab that is read at a glance into a
                 * line of three things, and the sheet itself shows which span is set.
                 *
                 * Only Finished has one. Open is what is still out there and cannot be older than
                 * the orders in it.
                 */
                <Pressable
                  key={x.key}
                  onPress={() => pickTab(x.key)}
                  hitSlop={6}>
                  <Text style={[styles.orderTabText, tab === x.key && styles.orderTabOn]}>
                    {x.label}
                    {counts[x.key] > 0 ? ` (${counts[x.key]})` : ''}

                  </Text>
                </Pressable>
              ))}
              {/* The record, beside the two tabs that are the live list — and ALWAYS, including
                  when both tabs are empty. An empty card is exactly when someone wants to know
                  whether anything ever happened on this pair, so hiding the way to the history
                  until there is something here would withhold it at the one moment it is asked
                  for. It is also the only route to the cancelled orders and to every other pair.
                  
                  A mark rather than a label: beside two words that ARE the list, a third word
                  that is a destination read as a tab, and the clock says "the record" in a tenth
                  of the room. The same clock the Overview's History action wears, in the tab
                  row's own muted grey rather than accent. The name goes to the screen reader,
                  which sees no clock. The ⋯ menu carries it too, for the pages that have no
                  orders card at all. */}
              <Pressable
                // Opens pre-filtered to the asset in front of the user — the record of THIS pair is
                // what they are most likely after from here. It is a filter and not a lock: the
                // page's own asset chip reaches the whole record (other pairs, cancelled orders).
                onPress={() => nav.navigate('OrderHistory', {symbol: baseSym})}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.trade.order_history')}>
                <Svg width={17} height={17} viewBox="0 0 24 24">
                  <Circle cx={12} cy={12} r={9} stroke={c.subtext} strokeWidth={2.2} fill="none" />
                  <Path d="M12 7.5V12l3 2" stroke={c.subtext} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </Svg>
              </Pressable>
            </View>
            <Pressable style={styles.othersToggle} onPress={toggleOthers} hitSlop={6}>
              <View style={[styles.checkbox, showOthers && styles.checkboxOn]}>{showOthers ? <Text style={styles.checkboxTick}>✓</Text> : null}</View>
              <Text style={styles.othersText}>{t('mobile.trade.others')}</Text>
            </Pressable>
          </View>

          {tab === 'open' && openUids.length > 1 ? (
            <Pressable
              style={styles.cancelAllRow}
              onPress={() =>
                ask({
                  title: t('mobile.actions.cancel_intents', {count: openUids.length}),
                  // One transaction invalidates every uid, so the fee does not scale with the count.
                  gas: relayGasFor({}),
                  run: () => onCancelAll(openUids),
                })
              }
              disabled={cancellingAll}
              hitSlop={6}>
              <Text style={styles.cancelAllText}>{cancellingAll ? t('mobile.trade.cancelling_all') : `${t('vault.cancel_all')} (${openUids.length})`}</Text>
            </Pressable>
          ) : null}

          {/**
            * Every row this panel shows, in ONE list, newest first.
            *
            * It used to render four lists in sequence — schedules, then orders, then completed
            * swaps, then failed attempts — each ordered within itself. So the newest thing on the
            * page could be anywhere in it: a swap from an hour ago sat under an order that expires
            * next month, and a failure from last week sat below both. A list of what happened is
            * read from the top, and the top has to be the most recent.
            *
            * Ordered by when each was PLACED — see {placedAt}. It was an order's `validTo`, which
            * is a deadline and not an event, so a limit order good for a month sat above a swap
            * that filled minutes ago. A market swap's placement and execution are one moment, so
            * its block stands in for both.
            *
            * `last` is applied after the sort rather than inside each block, since which row is
            * last is no longer something a block can know about itself.
            */}
          {/**
            * The two tabs are PAGES: the list under them swipes between them.
            *
            * The tab row stayed a pair of buttons for a while, which is the wrong gesture for a
            * pair of lists sitting side by side — every other row of tabs in this app (the asset
            * categories, the allow list) is swiped, and reaching for the label to change a list
            * that is already under your thumb reads as a form control rather than as two views of
            * the same thing.
            *
            * The pager escapes the card's padding and each page puts it back, so a row can still
            * bleed its divider to the card's edges without bleeding into the page beside it.
            *
            * Its height follows the page in view — the two lists are rarely the same length — by
            * standing at the taller and giving the difference back as negative bottom margin, the
            * same way the asset directory's pager does.
            */}
          <View style={styles.tabPager} onLayout={(e) => setTabPageW(e.nativeEvent.layout.width)}>
            {tabPageW > 0 ? (
              <Animated.ScrollView
                ref={tabPagerRef}
                horizontal
                pagingEnabled
                bounces={false}
                showsHorizontalScrollIndicator={false}
                nestedScrollEnabled
                style={tabPagerStyle}
                contentContainerStyle={styles.pagerContent}
                onScroll={Animated.event([{nativeEvent: {contentOffset: {x: tabX}}}], {useNativeDriver: false})}
                scrollEventThrottle={16}
                onMomentumScrollEnd={(e) => onTabSettle(e.nativeEvent.contentOffset.x)}>
                {TABS.map((x) => (
                  <View key={x.key} style={[styles.tabPage, {width: tabPageW}]}>
                    <View
                      onLayout={(e) => {
                        // The layout event is recycled before a state updater runs.
                        const h = e.nativeEvent.layout.height;
                        setTabPageH((prev) => (prev[x.key] === h ? prev : {...prev, [x.key]: h}));
                      }}>
                      {orderList(x.key)}
                    </View>
                  </View>
                ))}
              </Animated.ScrollView>
            ) : null}
          </View>
        </View>
        ) : null}
      </ScrollView>

      {/* How far back Finished reaches. A PickerSheet, so it closes on the answer — one question
          with one answer, unlike the filter sheet on the order history page. */}
      <PickerSheet
        visible={windowOpen}
        title={t('mobile.trade.finished_window')}
        items={FINISHED_WINDOWS.map((w) => ({key: w, label: t(`mobile.trade.window_${w}`)}))}
        selected={finishedWindow}
        onSelect={(k) => setFinishedWindow(k as FinishedWindow)}
        onClose={() => setWindowOpen(false)}
      />

      {confirmSheet}

      {/* Fixed Buy / Sell bar — the pair screen only; the directory has nothing to buy.
          In the tab it rests on the tab bar, which is translucent and absolutely positioned, so it
          carries that height as its own margin. PUSHED there is no tab bar, and the margin fell to
          zero, leaving the buttons against the bottom of the screen and under the home indicator —
          hence the safe-area inset as the floor. */}
      {isPair ? (
      <Animated.View
        // Anchored to the screen edge with the floor as bottom PADDING (not as a `bottom` offset),
        // so the bar's background fills the home-indicator / tab-bar strip instead of leaving it
        // transparent. The buttons still sit `barBottom + 18` up, so nothing moves visually, and
        // BAR_HEIGHT / BAR_SLIDE / the content padding stay consistent (the bar grows down by
        // exactly the gap it used to float above). When hidden it slides its full height clear.
        style={[styles.bar, {bottom: 0, paddingBottom: 18 + barBottom, transform: [{translateY: barY}]}]}>
        <Pressable style={[styles.barBtn, {backgroundColor: c.buy}, untradable && styles.dim]} onPress={() => (untradable ? explainUntradable() : openSheet('buy'))}>
          <Text style={styles.barText}>{t('vault.buy')}</Text>
        </Pressable>
        <Pressable style={[styles.barBtn, {backgroundColor: c.sell}, untradable && styles.dim]} onPress={() => (untradable ? explainUntradable() : openSheet('sell'))}>
          <Text style={styles.barText}>{t('vault.sell')}</Text>
        </Pressable>
      </Animated.View>
      ) : null}

      {/* Order form bottom sheet. The card, the backdrop, the inset, the ✕ and the drag are
          {FormSheet}'s — the same ones the Earn form stands in. `busy` withholds every way out at
          once while an order is going out. */}
      <FormSheet
        visible={sheetSide != null}
        onClose={() => setSheetSide(null)}
        closable={!busy}
        overlay={orderOverlay}>
        <View style={styles.sheetBody}>

            {/* Order type as plain labels from the left, like the Overview's asset categories, rather
                than a segmented control stretched across the sheet. */}
            <View style={styles.segTrack}>
              {MODES.map((m) => (
                <Pressable
                  key={m.key}
                  style={[styles.segBtn, m.key === 'Market' && marketOff && styles.dim]}
                  onPress={() => pickMode(m.key)}>
                  <Text style={[styles.segText, mode === m.key && styles.segTextOn]}>{m.label}</Text>
                </Pressable>
              ))}
              {/* Pushed to the right edge of the same line, exactly as the Earn card's header
                  carries its protocol: the mark alone, tapped to name itself. */}
              {venues.length > 0 ? (
                <View style={styles.segVenues}>
                  {venues.map((v) => (
                    <ProtocolChip key={v.name} name={v.name} uri={v.uri} size={16} />
                  ))}
                </View>
              ) : null}
            </View>
            {mode === 'Market' && marketOff ? (
              <Pressable onPress={explainMarketOff} hitSlop={6}>
                <Text style={styles.marketOff}>{t('mobile.trade.market_off_line')}</Text>
              </Pressable>
            ) : null}

            {/* Limit and TWAP lead with the price, as on the web. A market order has no user
                price — it fills at the live quote — so the field is simply absent. */}
            {mode !== 'Market' ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>{t('vault.price')}</Text>
                <View style={styles.fieldRight}>
                  {/* No token on this row. Price is a RATIO — quote per base — so one symbol
                      beside it names half of it and reads as the price being denominated in
                      something other than the pair already states. The web shows none either. */}
                  {/* The live pool price as the placeholder, not "0".
                  
                      An empty limit price is not a zero price, it is "the market" — and the
                      number someone is about to adjust up or down is the one they need in front
                      of them to do it. "0" said nothing and read as a price of nothing. Formatted
                      with the same precision rule the fields use, so typing over it does not
                      change how many digits are shown. */}
                  <TextInput style={styles.fieldInput} keyboardType="decimal-pad" placeholder={livePoolPrice && livePoolPrice > 0 ? toField(livePoolPrice) : '0'} placeholderTextColor={c.subtext} value={price} onChangeText={(v) => { setPrice(v); setPriceEdited(true); }} {...priceCaret} onFocus={(e) => { priceCaret.onFocus?.(e); setPriceEdited(true); }} />
                </View>
              </View>
            ) : null}

            {baseField}



            {mode === 'TWAP' ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>{t('vault.parts')}</Text>
                <View style={styles.fieldRight}>
                  <TextInput style={styles.fieldInput} keyboardType="number-pad" value={parts} onChangeText={setParts} {...partsCaret} />
                </View>
              </View>
            ) : null}

            {/* The % slider sits between the two amount lines, so it is in the same place on a
                buy and on a sell — and the Total it drives is the field directly under it. */}
            <PercentSlider value={payPct} onChange={setPayPct} disabled={!balKnown || Number(spendBal) <= 0} />

            {totalField}

            {/**
              * What a market order can cost you beyond the quote.
              *
              * A market swap is the one mode with no price in it: the sheet shows "≈" against a
              * figure the pool decides at settlement, and the only hard number in the trade is
              * the floor the router is told to refuse below. That floor was in the code and
              * nowhere on screen, so the estimate read as a promise.
              *
              * Both lines, because one without the other says half of it: the tolerance is the
              * rule and the minimum is what the rule means for THIS amount. Shown only once
              * there is an amount to apply it to — a floor of zero is not information.
              */}
            {mode === 'Market' ? (
              /* One line: the Max-slippage control on the left (tap to change it), the resulting
                 Min received on the right — net of BOTH the slippage tolerance and the 0.2% Bitty
                 fee, so it agrees with the fee line below. */
              <View style={[styles.quoteBox, styles.quoteLine]}>
                <Pressable onPress={() => setPicker('slippage')} hitSlop={6}>
                  <Text style={styles.quoteLabel}>
                    {t('mobile.trade.max_slippage')}{' '}
                    <Text style={[styles.quoteValue, styles.quoteLink]}>{slippage / 100}%</Text>
                  </Text>
                </Pressable>
                {mktQuote ? (
                  <Text style={styles.quoteLabel}>
                    {t('mobile.trade.min_received')}{' '}
                    <Text style={styles.quoteValue}>
                      {/* The real floor from the Universal route quote — net of price impact, pool
                          fees and slippage — not price × amount, which ignored depth. */}
                      {fmtQuote(Number(mktQuote.guard))} {displaySymbol(recvSym)}
                    </Text>
                  </Text>
                ) : null}
              </View>
            ) : null}

            {/* Validity: the usual answers as chips, and a field for anything else. A preset is one
                tap where it fits, and 45 days was previously unreachable without picking 30. */}
            {mode !== 'Market' ? (
              <View style={styles.validRow}>
                <Text style={styles.fieldLabel}>{mode === 'TWAP' ? t('mobile.trade.over') : t('vault.valid_for')}</Text>
                <View style={styles.validChips}>
                  {VALID_PRESETS.map((v) => (
                    <Pressable
                      key={v.s}
                      style={[styles.vchip, validDays === '' && validSec === v.s && styles.vchipOn]}
                      onPress={() => {
                        lastPreset.current = v.s;
                        setValidSec(v.s);
                        setValidDays('');
                      }}>
                      <Text style={[styles.vchipText, validDays === '' && validSec === v.s && styles.vchipTextOn]}>
                        {`${v.n}${t(v.unit)}`}
                      </Text>
                    </Pressable>
                  ))}
                  <View style={[styles.vdays, validDays !== '' && styles.vdaysOn]}>
                    <TextInput
                      style={styles.vdaysInput}
                      keyboardType="number-pad"
                      placeholder="0"
                      placeholderTextColor={c.subtext}
                      value={validDays}
                      onChangeText={onValidDays}
                      onBlur={onValidDaysBlur}
                      maxLength={3}
                    />
                    <Text style={[styles.vchipText, validDays !== '' && styles.vchipTextOn]}>{t(DAY)}</Text>
                  </View>
                </View>
              </View>
            ) : null}

            {status === 'error' && err ? <Text style={styles.err} selectable>{err}</Text> : null}

            {/* Bitty's trading fee, right above the action so it is the last thing read before
                confirming. The rate sits with the label on the left ("Bitty fee 0.2%", as the
                slippage line reads); the right-hand column carries only the amount + token it works
                out to in the quote coin — blank until there is an amount to apply it to. */}
            {(() => {
              const quoteNotional =
                (shownSide === 'buy' ? Number(amount) : Number(receiveInput)) || 0;
              const fee = quoteNotional * PARTNER_FEE;
              return (
                <View style={[styles.quoteLine, styles.feeLine]}>
                  <Text style={styles.quoteLabel}>
                    {t('mobile.trade.bitty_fee')}{' '}
                    <Text style={styles.quoteValue}>{(PARTNER_FEE * 100).toFixed(1)}%</Text>
                  </Text>
                  {fee > 0 ? (
                    <Text style={styles.quoteValue}>
                      {fmtFee(fee)} {displaySymbol(quoteSym)}
                    </Text>
                  ) : null}
                </View>
              );
            })()}

            <ConfirmButton
              onPress={onSubmit}
              disabled={!canConfirm}
              color={shownSide === 'buy' ? c.buy : c.sell}
              style={styles.submit}
              gas={feeGas}
              fee={feeApplies}
              free={feeFree}
            />
        </View>
      </FormSheet>
      {/* The full position, opened from the Today P&L on the header line — amount, cost basis,
          average price, realized/unrealized, all of it, which the header could only summarise. */}
      <Sheet
        visible={showPosition}
        title={t('mobile.trade.position')}
        onClose={() => setShowPosition(false)}
        height={Math.round(screenHeight * 0.618)}>
        {/* Space below the title/close row so the figures do not sit tight under it. A pair with no
            position yet still opens — the panel reads zeros rather than vanishing. While the fetch
            is still out it reads dashes instead: zeros that flip to numbers look like a change. */}
        <View style={{marginTop: 16}}>
          <PositionPanel
            loading={position === undefined}
            position={
              position ?? {
                symbol: baseSym,
                amount: 0,
                price: 0,
                marketValue: 0,
                avgPrice: 0,
                costBasis: 0,
                unrealizedPnl: 0,
                realizedPnl: 0,
                pnlPct: 0,
                todayPnl: 0,
                change24h: 0,
              }
            }
            portfolioValue={portfolioValue}
            bare
          />
        </View>
      </Sheet>
      {/* A TWAP's terms: what it was placed on, as against the parts panel's what has happened.
          Read once and then rarely, which is why they are a tap away rather than six lines above
          the only part of the order that is still moving. */}
      <Sheet
        visible={!!infoGroup && !!infoFacts}
        title={t('mobile.trade.details')}
        onClose={() => setTwapInfo(null)}
        height={420}>
        {infoGroup && infoFacts ? (
          <OrderDetailLines
            lines={[
              [t('vault.pay'), {amount: fmtShort(infoFacts.partSell * infoGroup.total), symbol: infoFacts.sellM.symbol}],
              [t('vault.receive'), {amount: fmtShort(infoFacts.partBuy * infoGroup.total), symbol: infoFacts.buyM.symbol}],
              // What one slot buys, so the fraction on the row has a size attached to it.
              [t('mobile.trade.per_part'), {amount: fmtShort(infoFacts.partSell), symbol: infoFacts.sellM.symbol}],
              [
                t('mobile.trade.parts_history'),
                t('mobile.trade.parts_posted', {posted: infoGroup.parts.length, total: infoGroup.total}),
              ],
              ...(infoWhen
                ? ([[t(infoWhen[0]), whenText(infoWhen, t, language)]] as [string, OrderValue][])
                : []),
            ]}
          />
        ) : null}
      </Sheet>

    </>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  // paddingBottom is set inline from the tab bar's height; see the ScrollView.
  body: {flexGrow: 1, padding: 16, gap: 14},
  /**
   * Inset to the cards' own content, not to the page.
   *
   * The pair and the ⓘ sat at 16 — hard against the page edge, further out than the chart and the
   * orders card they sit above, so the row looked like it belonged to the screen rather than to
   * them. 20 on top of the body's 16 puts both ends at 36, which is where the Overview's "Watch
   * list" and "hide 0" sit; the two screens now have the same margin for the same kind of row.
   */
  // The nav bar's own title metrics, so the field reads as a title and not as a form control.
  navTitle: {color: c.text, fontSize: 17, fontWeight: '700'},
  navTitleInput: {color: c.text, fontSize: 17, fontWeight: '700', minWidth: 170, padding: 0},
  headerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 20},
  /**
   * One step down from where it started: 28pt coins and 20pt tickers next to each other made the
   * pair the loudest thing on a page whose point is the chart and the orders under it. The price in
   * the chart's own header is 22pt, and the pair was competing with it rather than labelling it.
   */
  pair: {flexDirection: 'row', alignItems: 'center', flexShrink: 1},
  pairPart: {flexDirection: 'row', alignItems: 'center', gap: 5},
  pairText: {color: c.text, fontSize: 17, fontWeight: '700'},
  // The position icon on the header line, right-aligned, tappable — opens the full position sheet.
  positionBtn: {flexShrink: 0, paddingLeft: 12},
  pairSlash: {color: c.subtext, fontSize: 17, fontWeight: '600', marginHorizontal: 6},
  card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 0},
  catWrap: {marginTop: -4, marginBottom: -4},
  // Categories and search share one line: the tabs take what is left, the button is fixed.
  catLine: {flexDirection: 'row', alignItems: 'center'},
  catFlex: {flex: 1},
  searchBtn: {paddingHorizontal: 6, paddingVertical: 6},
  searchInput: {flex: 1, color: c.text, fontSize: 15, fontWeight: '600', paddingVertical: 6, paddingHorizontal: 4},
  pagerContent: {alignItems: 'flex-start'},
  // Side padding only: the rows bring their own vertical, so the first is not double-padded.
  // A statement about the list rather than a row of it, so it sits outside the card that holds
  // the assets — same left edge, no divider, nothing to tap but itself.
  // Sized and aligned as a tab, because it sits in the row of them: the same vertical padding,
  // and a box small enough that the line's height is still set by the words beside it.
  // The tab strip's own type, so the control reads as the last thing in the row rather than as
  // something borrowed from another part of the screen.
  listCard: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6},
  resultDivided: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  resultRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, minHeight: 56},
  // Stacked, not side by side: the ticker leads and the company sits under it, which gives the
  // row the height of the Overview's asset rows instead of one cramped line.
  resultName: {flex: 1},
  resultText: {color: c.text, fontSize: 15, fontWeight: '600'},
  // Bold, beside the ticker: the two together are what the row is. Tabular figures so the digits
  // do not shuffle as prices tick.
  resultPrice: {color: c.subtext, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums']},
  resultCompany: {color: c.subtext, fontSize: 13, marginTop: 1},
  orderTabs: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12},
  orderTabsLeft: {flexDirection: 'row', gap: 16, alignItems: 'center'},
  orderTabText: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  orderTabOn: {color: c.text},
  othersToggle: {flexDirection: 'row', alignItems: 'center', gap: 6},
  checkbox: {width: 15, height: 15, borderRadius: 4, borderWidth: 1, borderColor: c.subtext, alignItems: 'center', justifyContent: 'center'},
  checkboxOn: {backgroundColor: c.buttonSecondary, borderColor: c.buttonSecondary},
  checkboxTick: {color: c.text, fontSize: 10, fontWeight: '700'},
  othersText: {color: c.subtext, fontSize: 12},
  cancelAllRow: {alignItems: 'flex-end', paddingVertical: 6},
  cancelAllText: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  empty: {color: c.subtext, fontSize: 13, textAlign: 'center', paddingTop: 10},
  // The orders pager steps OUT of the card's 16 and each page puts it back, so a row's divider can
  // reach the card's edges without reaching into the page beside it. See the pager's own note.
  tabPager: {marginHorizontal: -16},
  tabPage: {paddingHorizontal: 16},
  // Its own style, not the orders list's: that one hangs under a header row and is padded at
  // the top only, which left this sitting against the card's top edge instead of in it.
  emptySearch: {color: c.subtext, fontSize: 13, textAlign: 'center', paddingVertical: 36},
  cancelInline: {color: c.danger, fontSize: 15, fontWeight: '600'},
  /**
   * Over the page, not a band of it.
   *
   * It used to be a flex sibling of the list, so it occupied {BAR_HEIGHT} of the screen for good.
   * Sliding it away then moved the buttons and left the strip behind — the same opaque background,
   * covering the same content, with nothing on it. Floating it means the list is full height and
   * what the buttons were hiding is simply there once they go.
   *
   * It keeps its background while it is up: the buttons sit over the list now, and without one the
   * rows would run under the letters.
   */
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 18,
    backgroundColor: c.bg,
  },
  barBtn: {flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center'},
  barText: {color: c.onAccent, fontSize: 17, fontWeight: '700'},
  dim: {opacity: 0.5},
  // The card itself is {FormSheet}'s; this is only the rhythm of the form inside it.
  sheetBody: {flex: 1, gap: 10},
  sheetTitle: {color: c.text, fontSize: 18, fontWeight: '700'},
  sheetQuote: {color: c.subtext, fontWeight: '600'},
  sheetPrice: {color: c.subtext, fontSize: 12, marginTop: 3, fontVariant: ['tabular-nums']},
  segTrack: {flexDirection: 'row', alignItems: 'center', gap: 20},
  // Pushed to the right edge by its own auto margin rather than a spacer, so the marks keep an
  // 8pt gap of their own instead of the 20pt that separates the order types — a pair reads as one
  // group, not as two more tabs.
  segVenues: {flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto'},
  segBtn: {paddingVertical: 6},
  segText: {color: c.subtext, fontSize: 15, fontWeight: '600'},
  segTextOn: {color: c.text, fontWeight: '700'},
  marketOff: {color: c.warning, fontSize: 13, lineHeight: 19},
  // web-style inline field: left label + right value + token adornment
  field: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.input, borderRadius: 12, paddingHorizontal: 14, height: 52},
  fieldLabel: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  fieldRight: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end', marginLeft: 12},
  fieldInput: {flex: 1, textAlign: 'right', color: c.text, fontSize: 17, fontVariant: ['tabular-nums'], padding: 0},
  fieldValue: {flex: 1, textAlign: 'right', color: c.text, fontSize: 17, fontVariant: ['tabular-nums']},
  fieldSym: {color: c.text, fontSize: 14, fontWeight: '700'},
  maxPill: {backgroundColor: c.accentSoft, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3},
  sourcePill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 16, paddingVertical: 5, paddingHorizontal: 8},
  sourceTag: {color: c.subtext, fontSize: 11, fontWeight: '600'},
  maxText: {color: c.accent, fontSize: 11, fontWeight: '700'},
  overText: {color: c.danger, fontSize: 12},
  fieldInputOver: {color: c.danger},
  // Quieter than a field: it is read, not filled in, so it has no border and sits flush with the
  // rows above rather than looking like another control.
  quoteBox: {gap: 6, paddingHorizontal: 4},
  quoteLine: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  // The Bitty-fee line sits just above the confirm button; a little breathing room on each side.
  feeLine: {paddingHorizontal: 4, marginTop: 2, marginBottom: 2},
  // A line whose value sits with its label rather than in the right-hand column.
  quoteLineTight: {justifyContent: 'flex-start'},
  quoteLabel: {color: c.subtext, fontSize: 13},
  quoteValue: {color: c.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
  // The accent is what marks it as the one figure on this panel that can be changed.
  quoteLink: {color: c.accent},
  validRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.input, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingLeft: 14, paddingRight: 6, height: 52},
  validChips: {flexDirection: 'row', alignItems: 'center', gap: 4},
  vdays: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8},
  vdaysOn: {backgroundColor: c.accentSoft},
  vdaysInput: {minWidth: 26, textAlign: 'right', color: c.text, fontSize: 13, fontWeight: '600', padding: 0},
  vchip: {paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8},
  vchipOn: {backgroundColor: c.buttonSecondary},
  vchipText: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  vchipTextOn: {color: c.text},
  err: {color: c.danger, fontSize: 13},
  submit: {marginTop: 6},
});

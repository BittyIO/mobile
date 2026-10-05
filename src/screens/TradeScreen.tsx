import {useHeaderHeight} from '@react-navigation/elements';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList, TradeParams} from '@/App';
import {BottomTabBarHeightContext} from '@react-navigation/bottom-tabs';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type StyleProp, type TextStyle} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
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
import {useSheetAnim} from '@/components/useSheetAnim';
import {FundRow} from '@/components/FundRow';
import {useEndCaret} from '@/components/useEndCaret';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {showTx, showToast, ToastHost} from '@/components/Toast';
import {PickerSheet} from '@/components/AssetPicker';
import {PriceChart} from '@/components/PriceChart';
import {CategoryTabs, Pill} from '@/components/ui';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {positionToken} from '@/vault/position-token';
import {susdsRate} from '@/vault/yielding';
import {buildLimitAppData} from '@/core/cow';
import {usePrices} from '@/vault/usePrices';
import {getFlag, setFlag, getPref, setPref, SHOW_OTHER_ORDERS, LAST_PAIR} from '@/core/prefs';
import {usdValue, fmtUsd} from '@/core/prices';
import {ownerVaultAddress, balanceOfSymbol} from '@/vault/read';
import {FEE_RESERVE} from '@/vault/gasless';
import {relayGasFor} from '@/vault/fee-quote';
import {intentPrepCalls, needsRelayerApproval} from '@/vault/limit';
import {Sheet} from '@/components/Sheet';
import {describeOrder} from '@/vault/tx-actions';
import {useConfirmAction} from '@/components/ConfirmAction';
import {fetchProtocolApy, EMPTY_APY, type ProtocolApy} from '@/vault/apy';
import {marketSell, buildMarketSell, poolSpotPrice} from '@/vault/trade';
import {placeLimitOrder, prepareIntent, cancelLimitOrders, fetchRecentOrders, type CowOrder} from '@/vault/limit';
import {placeTwap, fetchTwapSchedules, cancelTwap, type TwapSchedule} from '@/vault/twap';
import {
  effectiveStatus,
  fmtExpiry,
  orderBucket,
  splitTwapGroups,
  statusPill,
  type OrderBucket,
  type TwapGroup,
} from '@/vault/order-view';
import {relayVaultMulticall, type VaultCall} from '@/vault/relay';
import {VAULT_DEFI_ABI} from '@/core/abi';
import {fetchMarketTrades, type MarketTrade} from '@/vault/market-trades';
import {adapterByName} from '@/core/protocols';
import {ASSET_CATEGORIES, ASSETS, assetCategory, assetMeta, isAmmLiquid, isKnownAsset, underlyingOf, type AssetCategory} from '@/core/assets';
import {fmtNum, fmtShort, displaySymbol} from '@/core/format';
import {formatUnits, parseUnits, type Address} from 'viem';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

const SLIPPAGE_BPS = 100; // 1%
type Mode = 'Market' | 'Limit' | 'TWAP';

/** The three places a market order can draw on, ticked one by one in the source sheet. */
type FundKey = 'vault' | 'sky' | 'aave';
const FUND_KEYS: FundKey[] = ['vault', 'sky', 'aave'];
type Side = 'buy' | 'sell';
/**
 * The two tabs this screen shows. Cancelled orders are not among them — an order that never
 * happened is a thing you look up, not something that belongs beside the orders you are managing,
 * so the whole of it lives on the pushed Order History instead.
 */
type Tab = 'open' | 'finished';
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
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const fmtAmt = (raw: string, decimals: number): string => fmtShort(Number(formatUnits(BigInt(raw), decimals)));

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
  const assets = ASSETS[network];
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
  // A network switch keeps the pair only where both sides exist there. Robinhood has no USDC or USDT,
  // so a USDC quote becomes USDG on arrival, and USDG becomes USDC again on the way back; a base the
  // new network lacks falls back to its first non-stable asset.
  useEffect(() => {
    if (!assets.some((a) => a.symbol === baseSym)) setBaseSym(assets.find((a) => a.kind !== 'stable')?.symbol ?? assets[0]?.symbol ?? 'WETH');
    // Provisional: the new network's balances are not in yet, so `preferredQuote` cannot run here.
    // Clearing the flag is what lets it correct this once they are.
    if (!stables.some((s) => s.symbol === quoteSym)) {
      quoteChosen.current = false;
      setQuoteSym(stables[0]?.symbol ?? 'USDC');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);
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
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      headerRight: () => (
        <WatchlistMenu
          label={listName}
          symbols={listSymbols}
          canDelete={canDelete}
          onDelete={() => setConfirmDelete(true)}
          onImport={importSymbols}
          importOnly={drafting}
        />
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWatchlist, canDelete, drafting, listName, listSymbols.join(',')]);

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
    if (wantBase && assets.some((a) => a.symbol === wantBase)) setBaseSym(wantBase);
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

  // Order form (in the bottom sheet)
  const [sheetSide, setSheetSide] = useState<Side | null>(null);
  const [mode, setMode] = useState<Mode>('Market');
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

  const balances = useVaultBalances(network);
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
  const intent = adapterByName(network, 'CoW Swap');

  const usdcAsset = useMemo(() => stables.find((s) => s.symbol === 'USDC') ?? stables[0], [stables]);
  const quoteAsset = assets.find((a) => a.symbol === quoteSym);

  // Order-form denomination: you always enter the PAY leg. A sell pays the base (e.g. ETH); a buy pays
  // the quote (e.g. USDC). So the Amount field + Max button sit on a DIFFERENT asset per side.
  const paysBase = sheetSide !== 'buy';
  // The asset the pay leg spends. onSubmit re-derives it locally; this is the same thing, needed
  // at render time for the funding rows' APY.
  const spendAsset = paysBase ? base : quoteAsset;
  const spendSym = paysBase ? baseSym : quoteSym;
  const recvSym = paysBase ? quoteSym : baseSym;
  const freeSpend = balanceOfSymbol(balances.balances, spendSym);

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

  const sourceAmount = spendSource === 'yield' ? instant.sky?.amount ?? 0 : spendSource === 'lend' ? instant.aave?.amount ?? 0 : 0;

  /**
   * How much of the spend asset this order must leave in the vault for the relayer's fee.
   *
   * The fee is billed from a vault stablecoin AFTER the call runs, and the coin is picked from what
   * the vault HOLDS — so when the asset being spent is the only funded stablecoin, the fee comes
   * out of the very balance the swap is emptying. Spending all of it made the relay revert at the
   * charge and report `fee-leg-failed`, with nothing wrong with the trade itself.
   *
   * Only market orders need it. A limit or TWAP order's transaction is setup and approval; the
   * balance does not move until CoW settles it later, long after the fee is paid.
   */
  const feeComesFromSpend =
    mode === 'Market' &&
    stables.some((a) => a.symbol === spendSym) &&
    !stables.some((a) => a.symbol !== spendSym && Number(balanceOfSymbol(balances.balances, a.symbol)) > 0);
  const feeReserve = feeComesFromSpend ? FEE_RESERVE[network] : 0;

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
    vault: Math.max(0, fundFloor(Number(freeSpend) - feeReserve)),
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
        : Number(freeSpend);
  // Spending from a named position leaves the free balance alone, so only the shortfall against the
  // reserve has to be held back. Spending from the free balance, the whole reserve comes out of the
  // same pot. Outside a market order the reserve is zero and this is the plain reachable figure.
  const keepBack =
    mode === 'Market' ? 0 : spendSource !== 'free' ? Math.max(0, feeReserve - Number(freeSpend)) : feeReserve;
  const spendBal = String(Math.max(0, reachable - keepBack));


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
    const vault = ownerVaultAddress(owner, network);
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

  // For a liquid pair the pool is authoritative — it is where a market order executes — with the
  // oracle standing in until the quote lands. For an illiquid one the pool is not a price at all, so
  // the market rate is the only honest seed for a limit order.
  const pairPrice = pairAmmLiquid ? poolPrice ?? oraclePrice : oraclePrice;

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
  // A TWAP part carries a salted appData; a limit order carries the fixed one.
  const limitAppData = useMemo(() => buildLimitAppData().hash.toLowerCase(), []);

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
    const vault = ownerVaultAddress(owner, network);
    fetchRecentOrders(vault, network).then(setOrders).catch(() => setOrders([]));
    // Completed market swaps leave no order record — they're recovered from the vault's transfer feed.
    fetchMarketTrades(vault, network).then(setMarketTrades).catch(() => setMarketTrades([]));
    fetchTwapSchedules(vault, network)
      .then((rows) => setTwaps(new Map(rows.map((r) => [r.appData.toLowerCase(), r]))))
      .catch(() => setTwaps(new Map()));
  };
  // Orders cancelled in this session, applied over the orderbook until it catches up.
  const [cancelledUids, setCancelledUids] = useState<Set<string>>(() => new Set());
  const markCancelled = (uids: string[]) => {
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
  const [category, setCategory] = useState<AssetCategory>('crypto_native');
  const categories = useMemo(
    () => ASSET_CATEGORIES.filter((k) => assets.some((a) => assetCategory(a.category) === k)),
    [assets],
  );
  useEffect(() => {
    if (categories.length && !categories.includes(category)) setCategory(categories[0]);
  }, [categories, category]);


  /** One directory row: icon, name, localised company, and what one of it costs. */
  const assetRow = (a: (typeof assets)[number], i: number) => (
    <Pressable
      key={a.symbol}
      style={[styles.resultRow, i > 0 && styles.resultDivided]}
      onPress={() => (isWatchlist ? star(a.symbol) : openPair(a.symbol))}>
      <TokenIcon symbol={a.symbol} size={30} />
      <View style={styles.resultName}>
        <Highlight text={displaySymbol(a.symbol)} q={query.trim()} style={styles.resultText} />
        {company(a.symbol, a.company) ? (
          <Highlight text={company(a.symbol, a.company) as string} q={query.trim()} style={styles.resultCompany} numberOfLines={1} />
        ) : null}
      </View>
      {/* Editing the watch list, a check takes the price's place — the same blue tick every picker
          sheet in the app uses for "this one is chosen". A star said the same thing in a second
          vocabulary, and only the chosen rows need a mark: an unchosen row is blank, so the list
          reads as what is on it rather than as a field of empty outlines. The whole row toggles. */}
      {isWatchlist ? (
        onList.has(a.symbol) ? (
          <Svg width={20} height={20} viewBox="0 0 24 24">
            <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
        ) : null
      ) : (
        // At the right edge, so the prices line up down the list and can be read as a column.
        <Text style={styles.resultPrice}>{fmtUsd(usdValue(1, a.symbol, prices))}</Text>
      )}
    </Pressable>
  );

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
  const pages = categories.length > 0 ? categories : (['crypto_native'] as AssetCategory[]);
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
  const pickCategory = (k: AssetCategory) => {
    setCategory(k);
    const i = pages.indexOf(k);
    if (i >= 0 && pageW > 0) pagerRef.current?.scrollTo({x: i * pageW, animated: true});
    if (k !== category) toTop();
  };
  const onPagerSettle = (x: number) => {
    if (pageW <= 0) return;
    const k = pages[Math.max(0, Math.min(pages.length - 1, Math.round(x / pageW)))];
    if (k && k !== category) {
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
    const nameOf = (a: (typeof assets)[number]) => company(a.symbol, a.company) ?? '';

    const bySymbol = assets.filter((a) => symbolOf(a).toLowerCase().includes(q)).sort(byPosition(symbolOf));
    const hit = new Set(bySymbol.map((a) => a.address));
    const byName = assets.filter((a) => !hit.has(a.address) && nameOf(a).toLowerCase().includes(q)).sort(byPosition(nameOf));
    return [...bySymbol, ...byName];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, assets, company]);

  const inCategory = (k: AssetCategory) =>
    assets
      .filter((a) => assetCategory(a.category) === k)
      .sort((x, y) => Number(y.kind === 'stable') - Number(x.kind === 'stable'));

  /** The pair to open for a directory row, quoted in a stable coin the vault actually holds. */
  const openPair = (symbol: string) => {
    const quote = preferredQuote(symbol);
    if (!quote) return;
    nav.navigate('TradePair', {base: symbol, quote});
  };


  // Asset pickers: a sheet with icons, for the base and the quote side of the pair.
  const [picker, setPicker] = useState<'base' | 'quote' | 'source' | null>(null);
  const pickBase = () => setPicker('base');
  const pickQuote = () => setPicker('quote');
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
  /** Funded rows first, each group keeping its catalog order (`sort` is stable). */
  const fundedFirst = <T extends {total: number}>(rows: T[]): T[] =>
    [...rows].sort((x, y) => Number(y.total > 0) - Number(x.total > 0));

  const pickerItems =
    picker === 'source'
      ? (
          [
            // A market order already reaches the positions on its own (it withdraws and swaps in one
            // transaction), so naming one there would be a choice without a difference. The rows are
            // for limit and TWAP, where the source decides what the order can actually spend.
            {key: 'free', label: displaySymbol(spendSym), sub: `${t('vault.balance')} · ${fmtNum(Number(freeSpend))}`},
            // A position's row carries its rate, as the Earn rows do: leaving an order funded from
            // one open costs nothing, and what it keeps paying while it waits is the reason why.
            ...(mode !== 'Market' && instant.sky
              ? [{key: 'yield', label: `${displaySymbol(spendSym)} ${t('vault.yielding')}`, sub: `${fmtNum(instant.sky.amount)} ${displaySymbol(spendSym)}${skyApy != null ? ` · ${t('mobile.earn.apy_rate', {rate: skyApy.toFixed(2)})}` : ''}`}]
              : []),
            ...(mode !== 'Market' && instant.aave
              ? [{key: 'lend', label: `${displaySymbol(spendSym)} ${t('vault.lending')}`, sub: `${fmtNum(instant.aave.amount)} ${displaySymbol(spendSym)}${aaveApy != null ? ` · ${t('mobile.earn.apy_rate', {rate: aaveApy.toFixed(2)})}` : ''}`}]
              : []),
          ] as {key: string; label: string; sub: string}[]
        ).map((o) => ({...o, icon: <TokenIcon symbol={spendSym} size={30} />}))
      : picker === 'quote'
      ? fundedFirst(
          stables
            .filter((s) => s.symbol !== baseSym)
            .map((s) => ({
              key: `${s.symbol}:free`,
              label: displaySymbol(s.symbol),
              icon: <TokenIcon symbol={s.symbol} size={30} />,
              total: totalOf(s.symbol),
            })),
        ).map(({total, ...row}) => ({...row, value: total > 0 ? fmtShort(total) : undefined}))
      : fundedFirst(
          assets
            .filter((a) => a.symbol !== quoteSym)
            .map((a) => ({
              key: `${a.symbol}:free`,
              label: displaySymbol(a.symbol),
              sub: company(a.symbol, a.company),
              icon: <TokenIcon symbol={a.symbol} size={30} />,
              total: totalOf(a.symbol),
            })),
          // Nothing printed against a zero: an empty right-hand end reads as "none" without
          // putting a column of noughts beside every asset the vault has never held.
        ).map(({total, ...row}) => ({...row, value: total > 0 ? fmtShort(total) : undefined}));

  // Plain (no thousands separators, so Number() round-trips) price string for the input default.
  const priceToInput = (p: number) => (p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toPrecision(4));

  const openSheet = (side: Side) => {
    setSheetSide(side);
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
  const effPrice = mode === 'Market' ? poolPrice ?? 0 : Number(price) || 0;

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

  // The gasless relay fee is paid from a vault stablecoin. Prefer a HELD stablecoin that isn't the coin
  // being spent as the pay leg — so maxing USDC still leaves USDT to cover gas. Falls back to any held
  // stablecoin, then the quote.
  const pickFeeCoin = (excludeAddr?: string): Address => {
    const held = stables.filter((s) => Number(balanceOfSymbol(balances.balances, s.symbol)) > 0);
    const ex = excludeAddr?.toLowerCase();
    const preferred = ex ? held.find((s) => s.address.toLowerCase() !== ex) : held[0];
    return ((preferred ?? held[0] ?? quoteAsset)?.address ?? quoteSym) as Address;
  };

  // The same checks onSubmit makes, so the button is disabled rather than erroring on tap.
  const canConfirm =
    !!sheetSide && unlocked && !!owner && !!base && !!quoteAsset &&
    Number(amount) > 0 &&
    (mode === 'Market' || Number(price) > 0) &&
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
    const payLeg = `${amt} ${displaySymbol(spendSym)}`;
    const recvLeg = `${fmtShort(toastRecv)} ${displaySymbol(recvSym)}`;
    const tx = showTx(
      toastRecv > 0
        ? t(side === 'buy' ? 'mobile.trade.pay_to_buy' : 'mobile.trade.pay_to_sell', {pay: payLeg, receive: recvLeg})
        : `${t('vault.pay')} ${payLeg}`,
      network,
    );
    // Closed straight away: a limit order first mines its setup transaction, and with no spinner on
    // the button an open sheet looked like a tap that did nothing. The badge and the orders list
    // carry it from here, and a failure raises a toast.
    setSheetSide(null);
    try {
      const acct = await getSigner();
      const vault = ownerVaultAddress(owner, network);
      // You always sell the PAY leg for the RECEIVE leg: sell base→quote, buy quote→base. Exact-in.
      const recvAsset = (paysBase ? quoteAsset : base);
      if (!spendAsset || !recvAsset) return;
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
          const {setup, swap} = await buildMarketSell({network, vault, sellToken, buyToken, sellAmount: amount, slippageBps: SLIPPAGE_BPS});
          const {hash} = await relayVaultMulticall({account: acct, vault, network, calls: [...withdrawCalls, ...setup, swap], stableCoin: feeCoin});
          tx.success(hash);
        } else {
          // marketSell bundles any required allowlist setup ahead of the swap; exact-in, works both sides.
          const {hash} = await marketSell({account: acct, vault, network, sellToken, buyToken, sellAmount: amount, slippageBps: SLIPPAGE_BPS, stableCoin: feeCoin});
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
          setErr(t('mobile.trade.enter_receive'));
          setStatus('error');
          return;
        }
        const minRecv = recvNum.toFixed(Math.min(recvAsset.decimals, 8));
        if (mode === 'Limit') {
          await placeLimitOrder({account: acct, vault, network, sellToken: payToken, buyToken, sellAmount: payAmount, buyAmount: minRecv, kind: 'sell', validSeconds: validSec});
        } else {
          const n = Math.max(1, parseInt(parts || '1', 10));
          await placeTwap({account: acct, vault, network, sellToken: payToken, buyToken, totalSell: payAmount, totalMinBuy: minRecv, parts: n, partDuration: Math.max(60, Math.floor(validSec / n))});
        }
      }
      setStatus('done');
      refreshOrders();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      tx.error(msg);
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
      tx.success(await cancelLimitOrders({account: acct, vault: ownerVaultAddress(owner, network), network, intentProtocol: intent, uids: [o.uid as `0x${string}`], stableCoin: pickFeeCoin()}));
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
      tx.success(await cancelLimitOrders({account: acct, vault: ownerVaultAddress(owner, network), network, intentProtocol: intent, uids: uids as `0x${string}`[], stableCoin: pickFeeCoin()}));
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
  const inPair = (o: CowOrder): boolean => pairSet.has(o.sellToken.toLowerCase()) && pairSet.has(o.buyToken.toLowerCase());
  const marketInPair = (m: MarketTrade): boolean => pairSet.has(m.sold.address.toLowerCase()) && pairSet.has(m.bought.address.toLowerCase());

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
        vault: ownerVaultAddress(owner, network),
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
  const shownTwaps = visibleTwaps.filter((g) => g.bucket === tab);
  // Market swaps are always complete → they belong under Finished.
  const marketFinished = showOthers ? marketTrades : pairSettled ? marketTrades.filter(marketInPair) : [];

  const counts = useMemo(() => {
    const c: Record<OrderBucket, number> = {open: 0, finished: 0, cancelled: 0};
    visibleOrders.forEach((o) => (c[orderBucket(effectiveStatus(o, cancelledUids))] += 1));
    // One per SCHEDULE. Counting parts made a ten-part TWAP look like ten open orders.
    visibleTwaps.forEach((g) => (c[g.bucket] += 1));
    c.finished += marketFinished.length;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleOrders, visibleTwaps, marketFinished]);
  const shownOrders = visibleOrders.filter((o) => orderBucket(effectiveStatus(o, cancelledUids)) === tab);
  const openUids = visibleOrders.filter((o) => effectiveStatus(o, cancelledUids) === 'open').map((o) => o.uid);
  const TABS: {key: Tab; label: string}[] = [
    {key: 'open', label: t('vault.orders_open_short')},
    {key: 'finished', label: t('vault.orders_finished_short')},
  ];
  // Market needs a pool on BOTH legs: the tokenized stocks are registered without the AMM-liquid bit
  // (no Uniswap market prices them) and the savings share has no pool either, so those pairs offer
  // the intent modes only.
  const marketable = pairAmmLiquid;
  useEffect(() => {
    if (!marketable && mode === 'Market') setMode('Limit');
  }, [marketable, mode]);
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

  const MODES: {key: Mode; label: string}[] = [
    ...(marketable ? [{key: 'Market' as Mode, label: t('vault.market')}] : []),
    {key: 'Limit', label: t('vault.limit')},
    {key: 'TWAP', label: t('vault.twap')},
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
  const orderSheet = useSheetAnim(sheetSide != null, () => setSheetSide(null));
  /**
   * The side the sheet is SHOWING, which outlives `sheetSide`.
   *
   * Closing clears `sheetSide` while the card is still sliding out, and everything the form keyed
   * on it changed halfway through the animation — the confirm button went from Buy's green to
   * Sell's red on its way off screen, which reads as the trade having failed. This keeps the sheet
   * looking like the sheet that was just confirmed until it is actually gone.
   */
  const lastSide = useRef<Side>('buy');
  if (sheetSide) lastSide.current = sheetSide;
  const shownSide = sheetSide ?? lastSide.current;
  // Tapping a prefilled field puts the caret after the number, not before it.
  const amountCaret = useEndCaret(amount);
  const priceCaret = useEndCaret(price);
  const partsCaret = useEndCaret(parts);
  const receiveCaret = useEndCaret(receiveInput);

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
  const payPct = Number(spendBal) > 0 ? (Number(amount) / Number(spendBal)) * 100 : 0;
  const setPayPct = (p: number) => applyPay(p >= 100 ? spendBal : toField((Number(spendBal) * p) / 100));

  return (
    <>
      <ScrollView showsVerticalScrollIndicator={false}
        ref={pageRef}
        alwaysBounceVertical
        contentContainerStyle={[styles.body, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
        contentInset={{top: headerHeight}}
        contentOffset={{x: 0, y: -headerHeight}}
        scrollIndicatorInsets={{top: headerHeight}}
        automaticallyAdjustContentInsets={false}
        refreshControl={<RefreshControl refreshing={pulled} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled">
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
                          tabs={categories.map((k) => ({
                            key: k,
                            label: k === 'crypto_native' ? t('mobile.home.category_crypto') : t(`vault.category_${k}`),
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
                              // Read the height now: the event is recycled before a state updater runs.
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

        {isPair ? <PriceChart key={`${baseSym}-${refreshNonce}`} symbol={baseSym} /> : null}

        {/* Orders — the pair screen's own history, not the directory's. */}
        {isPair ? (
        <View style={styles.card}>
          <View style={styles.orderTabs}>
            <View style={styles.orderTabsLeft}>
              {TABS.map((t) => (
                <Pressable key={t.key} onPress={() => setTab(t.key)} hitSlop={6}>
                  <Text style={[styles.orderTabText, tab === t.key && styles.orderTabOn]}>
                    {t.label}
                    {counts[t.key] > 0 ? ` (${counts[t.key]})` : ''}
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
                onPress={() => nav.navigate('OrderHistory')}
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

          {/* One row per TWAP schedule, above the plain orders: it is the oldest thing in the list,
              and its parts would otherwise be scattered through it by expiry. */}
          {shownTwaps.map((g, gi) => {
            const o = g.rep;
            const sellM = assetMeta(network, o.sellToken as Address);
            const buyM = assetMeta(network, o.buyToken as Address);
            const isBuy = stables.some((st) => st.address.toLowerCase() === o.sellToken.toLowerCase());
            const key = `twap-${g.appData}`;
            const isExp = expanded.has(key);
            const isLast =
              gi === shownTwaps.length - 1 && shownOrders.length === 0 && !(tab === 'finished' && marketFinished.length > 0);
            // The SCHEDULE's size, not the part's: one part is a tenth of what the user asked for,
            // and a row claiming to be the order has to state the order's own amounts.
            const partSell = Number(formatUnits(BigInt(o.sellAmount), sellM.decimals));
            const partBuy = Number(formatUnits(BigInt(o.buyAmount), buyM.decimals));
            /**
             * The limit price the schedule was placed at.
             *
             * A TWAP has one, same as a limit order — every part carries it — and the detail
             * listed everything about the order except the number that decides whether it fills.
             * Read off a PART: the ratio is the same at any size, and the parts are what exist.
             *
             * Quoted in the stable leg where there is one, as everywhere else in this list, and
             * the partner fee backed out so it matches what was typed into the form.
             */
            const sellStable = stables.some((st) => st.address.toLowerCase() === o.sellToken.toLowerCase());
            const buyStable = stables.some((st) => st.address.toLowerCase() === o.buyToken.toLowerCase());
            const pxBase = sellStable || buyStable
              ? (sellStable ? partSell : partBuy) / (sellStable ? partBuy : partSell)
              : partBuy / partSell;
            const twapPx = pxBase / (o.kind === 'buy' ? 1 + PARTNER_FEE : 1 - PARTNER_FEE);
            const twapPxSym = displaySymbol(
              sellStable || buyStable ? (sellStable ? sellM.symbol : buyM.symbol) : buyM.symbol,
            );
            const canCancel = g.bucket === 'open' && !!intent;
            return (
              <View key={key} style={[styles.orderCard, isLast && styles.lastOrder]}>
                <Pressable style={styles.orderHead} onPress={() => toggleExpanded(key)}>
                  <View style={styles.orderHeadLeft}>
                    <View style={[styles.kindBadge, {backgroundColor: isBuy ? c.successSoft : c.dangerSoft}]}>
                      <Text style={[styles.kindText, {color: isBuy ? c.success : c.danger}]}>
                        {words(t('vault.twap'), sideWord(isBuy))}
                      </Text>
                    </View>
                    {/* One leg, not both. See {orderSummary}. */}
                    <View style={styles.summaryWrap}>
                      <TokenIcon symbol={isBuy ? buyM.symbol : sellM.symbol} size={18} />
                      <Text style={styles.orderSummary} numberOfLines={1}>
                        <Amount v={fmtShort(isBuy ? partBuy * g.total : partSell * g.total)} size={15} />{' '}
                        {displaySymbol(isBuy ? buyM.symbol : sellM.symbol)}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.filledPill}>
                    {g.filled}/{g.total} {t('mobile.trade.filled_parts')}
                  </Text>
                </Pressable>
                {/* The open detail closes it again. The head is a 56pt strip and the panel under it is
                    the bigger target by far; having to go back up to the row to put it away read as the
                    panel being a separate thing rather than the row's own second half. The TWAP cancel
                    inside is a nested pressable and still wins the tap. */}
                {isExp ? (
                  <Pressable style={styles.orderDetail} onPress={() => toggleExpanded(key)}>
                    <View style={styles.orderLine}>
                      <Text style={styles.orderLabel}>{t('vault.pay')}</Text>
                      <View style={styles.orderAmt}>
                        <Text style={styles.orderAmtVal}><Amount v={fmtShort(partSell * g.total)} size={15} /></Text>
                        <TokenIcon symbol={sellM.symbol} size={16} />
                        <Text style={styles.orderAmtSym}>{displaySymbol(sellM.symbol)}</Text>
                      </View>
                    </View>
                    <View style={styles.orderLine}>
                      <Text style={styles.orderLabel}>{t('vault.receive')}</Text>
                      <View style={styles.orderAmt}>
                        <Text style={styles.orderAmtVal}><Amount v={fmtShort(partBuy * g.total)} size={15} /></Text>
                        <TokenIcon symbol={buyM.symbol} size={16} />
                        <Text style={styles.orderAmtSym}>{displaySymbol(buyM.symbol)}</Text>
                      </View>
                    </View>
                    <View style={styles.orderLine}>
                      <Text style={styles.orderLabel}>{t('vault.price')}</Text>
                      <Text style={styles.orderVal}>
                        {Number.isFinite(twapPx) ? twapPx.toLocaleString('en-US', {maximumSignificantDigits: 6}) : '—'} {twapPxSym}
                      </Text>
                    </View>
                    {/* What one slot buys, so the fraction above has a size attached to it. */}
                    <View style={styles.orderLine}>
                      <Text style={styles.orderLabel}>{t('mobile.trade.per_part')}</Text>
                      <View style={styles.orderAmt}>
                        <Text style={styles.orderAmtVal}><Amount v={fmtShort(partSell)} size={15} /></Text>
                        <Text style={styles.orderAmtSym}>{displaySymbol(sellM.symbol)}</Text>
                      </View>
                    </View>
                    <View style={styles.orderLine}>
                      <Text style={styles.orderLabel}>{t('vault.expires')}</Text>
                      <Text style={styles.orderVal}>{fmtExpiry(g.schedule.windowEnd, language)}</Text>
                    </View>

                    {/**
                      * The parts themselves.
                      *
                      * Only the ones POSTED can be listed: a TWAP's slots are placed one at a time
                      * as the schedule comes round, so a ten-part order an hour old has one or two
                      * orders in existence and eight still to come. Nine missing lines looked like
                      * lost data, so the count says plainly how many have gone out, and each line
                      * below it is a part that has — with what it actually filled for, where it
                      * filled.
                      */}
                    <View style={styles.orderLine}>
                      <Text style={styles.orderLabel}>{t('mobile.trade.parts_history')}</Text>
                      <Text style={styles.orderVal}>
                        {t('mobile.trade.parts_posted', {posted: g.parts.length, total: g.total})}
                      </Text>
                    </View>
                    {g.parts.map((pt) => {
                      const ps = effectiveStatus(pt, cancelledUids);
                      const done = ps.toLowerCase().includes('fulfil');
                      const sold = Number(formatUnits(BigInt(pt.executedSellAmount ?? '0'), sellM.decimals));
                      const recv = Number(formatUnits(BigInt(pt.executedBuyAmount ?? '0'), buyM.decimals));
                      return (
                        <View key={pt.uid} style={styles.partRow}>
                          <Text style={styles.partText} numberOfLines={1}>
                            {done
                              ? `${fmtShort(sold)} ${displaySymbol(sellM.symbol)} → ${fmtShort(recv)} ${displaySymbol(buyM.symbol)}`
                              : `${fmtShort(Number(formatUnits(BigInt(pt.sellAmount), sellM.decimals)))} ${displaySymbol(sellM.symbol)}`}
                          </Text>
                          <Text style={styles.partStatus}>{t(statusPill(ps).key)}</Text>
                        </View>
                      );
                    })}

                    {canCancel ? (
                      <Pressable
                        style={styles.cancelRight}
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
                    ) : null}
                  </Pressable>
                ) : null}
              </View>
            );
          })}

          {shownOrders.length === 0 && shownTwaps.length === 0 && !(tab === 'finished' && marketFinished.length > 0) ? (
            <Text style={styles.empty}>{t(`mobile.trade.no_${tab}_orders`)}</Text>
          ) : (
            shownOrders.slice(0, 30).map((o, i, arr) => {
              // The card's own padding frames the list: the last row adds no bottom padding.
              const isLast = i === arr.length - 1 && !(tab === 'finished' && marketFinished.length > 0);
              const es = effectiveStatus(o, cancelledUids);
              const sp = statusPill(es);
              const sellM = assetMeta(network, o.sellToken as Address);
              const buyM = assetMeta(network, o.buyToken as Address);
              // A leg held as a receipt token reads, and prices, as its underlying: what the user
              // typed and what the order is worth. sUSDS converts at the savings rate; an aToken is
              // one-for-one.
              const legRate = (addr: string) => (assetMeta(network, addr).symbol === 'sUSDS' ? shareRate : 1);
              const legSym = (addr: string, fallback: string) => underlyingOf(network, addr) ?? fallback;
              const sellNum = Number(formatUnits(BigInt(o.sellAmount), sellM.decimals)) * legRate(o.sellToken);
              const buyNum = Number(formatUnits(BigInt(o.buyAmount), buyM.decimals)) * legRate(o.buyToken);
              const sellSym = legSym(o.sellToken, sellM.symbol);
              const buySym = legSym(o.buyToken, buyM.symbol);
              const fromPosition = !!underlyingOf(network, o.sellToken);
              const isTwap = !!o.appData && o.appData.toLowerCase() !== limitAppData;
              // Price quoted in the stable leg when there is one, else base-per-quote by side.
              // A savings share or an aToken counts as its underlying here: an order selling sUSDS
              // for CRCL is a USDC-priced buy, and pricing it per share would be meaningless.
              const stableLike = (addr: string) => {
                const under = underlyingOf(network, addr);
                return stables.some((s) => (under ? s.symbol === under : s.address.toLowerCase() === addr.toLowerCase()));
              };
              const sellIsStable = stableLike(o.sellToken);
              const buyIsStable = stableLike(o.buyToken);
              let px: number;
              let pxSym: string;
              if (sellIsStable || buyIsStable) {
                px = (sellIsStable ? sellNum : buyNum) / (sellIsStable ? buyNum : sellNum);
                pxSym = sellIsStable ? sellSym : buySym;
              } else {
                px = o.kind === 'buy' ? sellNum / buyNum : buyNum / sellNum;
                pxSym = o.kind === 'buy' ? sellSym : buySym;
              }
              px = px / (o.kind === 'buy' ? 1 + PARTNER_FEE : 1 - PARTNER_FEE);
              // Buy or sell the ASSET: paying a stablecoin to receive something else is a buy,
              // whichever way round CoW encodes it (every order is posted as a sell of the pay leg,
              // so o.kind would call a CRCL purchase a sell of USDC).
              const isBuy = sellIsStable && !buyIsStable;
              // All rows collapse by default; tap to expand (open rows reveal their Cancel button).
              const isExp = expanded.has(o.uid);
              const canCancel = es === 'open' && !!intent;
              return (
                <View key={o.uid} style={[styles.orderCard, isLast && styles.lastOrder]}>
                  <Pressable
                    style={styles.orderHead}
                    onPress={() => toggleExpanded(o.uid)}>
                    <View style={styles.orderHeadLeft}>
                      {/* The side, and the type where the list holds more than one kind.
                          Open and Cancelled are limit orders unless they say TWAP, so naming the
                          type there spends a word on what the list already is. FINISHED is the
                          exception: completed market swaps sit in it too, and against a row
                          reading "Market Buy" a bare "Buy" looked like a different, nameless
                          thing rather than the limit order it is. */}
                      <View style={[styles.kindBadge, {backgroundColor: isBuy ? c.successSoft : c.dangerSoft}]}>
                        <Text style={[styles.kindText, {color: isBuy ? c.success : c.danger}]}>
                          {isTwap
                            ? words(t('vault.twap'), sideWord(isBuy))
                            : words(t('vault.limit'), sideWord(isBuy))}
                        </Text>
                      </View>
                      <View style={styles.summaryWrap}>
                        <TokenIcon symbol={isBuy ? buySym : sellSym} size={18} />
                        <Text style={styles.orderSummary} numberOfLines={1}>
                          <Amount v={fmtShort(isBuy ? buyNum : sellNum)} size={15} /> {displaySymbol(isBuy ? buySym : sellSym)}
                          {/* Only a sell can come out of a position, and only the leg on screen can
                              say so — on a buy the paying leg is not shown at all. */}
                          {!isBuy && fromPosition ? ` (${t('vault.yielding')})` : ''}
                        </Text>
                      </View>
                    </View>
                    {/* Open and Filled are what the tab already says, so an open order shows its Cancel
                        here instead; Expired stays as a pill (the Cancelled tab holds both cancelled and
                        expired orders). */}
                    {canCancel ? (
                      <Pressable
                        style={styles.orderHeadRight}
                        onPress={(e) => {
                          e.stopPropagation();
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
                    ) : sp.tone === 'amber' ? (
                      <View style={styles.orderHeadRight}>
                        <Pill label={t(sp.key)} tone={sp.tone} />
                      </View>
                    ) : null}
                  </Pressable>
                  {/* The open detail closes it again. The head is a 56pt strip and the panel under it is
                      the bigger target by far; having to go back up to the row to put it away read as the
                      panel being a separate thing rather than the row's own second half. The TWAP cancel
                      inside is a nested pressable and still wins the tap. */}
                  {isExp ? (
                    <Pressable style={styles.orderDetail} onPress={() => toggleExpanded(o.uid)}>
                      <View style={styles.orderLine}>
                        <Text style={styles.orderLabel}>{t('vault.pay')}</Text>
                        <View style={styles.orderAmt}>
                          <Text style={styles.orderAmtVal}><Amount v={fmtAmt(o.sellAmount, sellM.decimals)} size={15} /></Text>
                          <TokenIcon symbol={sellM.symbol} size={16} />
                          <Text style={styles.orderAmtSym}>{displaySymbol(sellM.symbol)}</Text>
                        </View>
                      </View>
                      <View style={styles.orderLine}>
                        <Text style={styles.orderLabel}>{t('vault.receive')}</Text>
                        <View style={styles.orderAmt}>
                          <Text style={styles.orderAmtVal}><Amount v={fmtAmt(o.buyAmount, buyM.decimals)} size={15} /></Text>
                          <TokenIcon symbol={buyM.symbol} size={16} />
                          <Text style={styles.orderAmtSym}>{displaySymbol(buyM.symbol)}</Text>
                        </View>
                      </View>
                      <View style={styles.orderLine}>
                        <Text style={styles.orderLabel}>{t('vault.price')}</Text>
                        <Text style={styles.orderVal}>{px.toLocaleString('en-US', {maximumSignificantDigits: 6})} {pxSym}</Text>
                      </View>
                      <View style={styles.orderLine}>
                        <Text style={styles.orderLabel}>{t('vault.expires')}</Text>
                        <Text style={styles.orderVal}>{fmtExpiry(o.validTo, language)}</Text>
                      </View>
                    </Pressable>
                  ) : null}
                </View>
              );
            })
          )}

          {/* Completed market swaps (Finished only) — recovered from the transfer feed, no order record. */}
          {tab === 'finished'
            ? marketFinished.slice(0, 30).map((m, i, arr) => {
                const isLast = i === arr.length - 1;
                const soldIsStable = stables.some((s) => s.address.toLowerCase() === m.sold.address.toLowerCase());
                const isBuy = soldIsStable; // spent a stablecoin to acquire the crypto leg
                const px = soldIsStable ? m.sold.amount / m.bought.amount : m.bought.amount / m.sold.amount;
                const pxSym = soldIsStable ? m.sold.symbol : m.bought.symbol;
                const isExp = expanded.has(m.txHash);
                return (
                  <View key={m.txHash} style={[styles.orderCard, isLast && styles.lastOrder]}>
                    <Pressable style={styles.orderHead} onPress={() => toggleExpanded(m.txHash)}>
                      <View style={styles.orderHeadLeft}>
                        <View style={[styles.kindBadge, {backgroundColor: isBuy ? c.successSoft : c.dangerSoft}]}>
                          <Text style={[styles.kindText, {color: isBuy ? c.success : c.danger}]}>
                            {words(t('vault.market'), sideWord(isBuy))}
                          </Text>
                        </View>
                        <View style={styles.summaryWrap}>
                          <TokenIcon symbol={isBuy ? m.bought.symbol : m.sold.symbol} size={18} />
                          <Text style={styles.orderSummary} numberOfLines={1}>
                            <Amount v={fmtShort(isBuy ? m.bought.amount : m.sold.amount)} />{' '}
                            {displaySymbol(isBuy ? m.bought.symbol : m.sold.symbol)}
                          </Text>
                        </View>
                      </View>
                    </Pressable>
                    {/* The open detail closes it again. The head is a 56pt strip and the panel under it is
                        the bigger target by far; having to go back up to the row to put it away read as the
                        panel being a separate thing rather than the row's own second half. The TWAP cancel
                        inside is a nested pressable and still wins the tap. */}
                    {isExp ? (
                      <Pressable style={styles.orderDetail} onPress={() => toggleExpanded(m.txHash)}>
                        <View style={styles.orderLine}>
                          <Text style={styles.orderLabel}>{t('mobile.trade.paid')}</Text>
                          <View style={styles.orderAmt}>
                            <Text style={styles.orderAmtVal}><Amount v={fmtShort(m.sold.amount)} size={15} /></Text>
                            <TokenIcon symbol={m.sold.symbol} size={16} />
                            <Text style={styles.orderAmtSym}>{displaySymbol(m.sold.symbol)}</Text>
                          </View>
                        </View>
                        <View style={styles.orderLine}>
                          <Text style={styles.orderLabel}>{t('vault.received')}</Text>
                          <View style={styles.orderAmt}>
                            <Text style={styles.orderAmtVal}><Amount v={fmtShort(m.bought.amount)} size={15} /></Text>
                            <TokenIcon symbol={m.bought.symbol} size={16} />
                            <Text style={styles.orderAmtSym}>{displaySymbol(m.bought.symbol)}</Text>
                          </View>
                        </View>
                        <View style={styles.orderLine}>
                          <Text style={styles.orderLabel}>{t('vault.price')}</Text>
                          <Text style={styles.orderVal}>{px.toLocaleString('en-US', {maximumSignificantDigits: 6})} {pxSym}</Text>
                        </View>
                        {m.ts ? (
                          <View style={styles.orderLine}>
                            <Text style={styles.orderLabel}>{t('vault.fulfilled')}</Text>
                            <Text style={styles.orderVal}>{fmtExpiry(m.ts, language)}</Text>
                          </View>
                        ) : null}
                      </Pressable>
                    ) : null}
                  </View>
                );
              })
            : null}
        </View>
        ) : null}
      </ScrollView>

      {confirmSheet}

      {/* Fixed Buy / Sell bar — the pair screen only; the directory has nothing to buy.
          In the tab it rests on the tab bar, which is translucent and absolutely positioned, so it
          carries that height as its own margin. PUSHED there is no tab bar, and the margin fell to
          zero, leaving the buttons against the bottom of the screen and under the home indicator —
          hence the safe-area inset as the floor. */}
      {isPair ? (
      <View style={[styles.bar, {marginBottom: Math.max(tabBarHeight, insets.bottom)}]}>
        <Pressable style={[styles.barBtn, {backgroundColor: c.buy}]} onPress={() => openSheet('buy')}>
          <Text style={styles.barText}>{t('vault.buy')}</Text>
        </Pressable>
        <Pressable style={[styles.barBtn, {backgroundColor: c.sell}]} onPress={() => openSheet('sell')}>
          <Text style={styles.barText}>{t('vault.sell')}</Text>
        </Pressable>
      </View>
      ) : null}

      {/* Order form bottom sheet */}
      <Modal transparent visible={orderSheet.mounted} animationType="none" onRequestClose={orderSheet.requestClose}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.shade, orderSheet.backdropStyle]} />
        <Pressable style={styles.sheetBackdrop} onPress={() => !busy && orderSheet.requestClose()}>
          <KeyboardAvoidingView behavior={undefined} style={styles.sheetWrap}>
            <Animated.View
              style={[styles.sheetWrap, orderSheet.sheetStyle, {marginTop: insets.top + 8}]}
              {...orderSheet.panHandlers}>
            <Pressable style={styles.sheet} onPress={() => Keyboard.dismiss()}>
            {/* The sheet's side is already the button the user pressed, and the submit button repeats it, so
                the head carries only the close control. */}
            <View style={styles.sheetHead}>
              <Pressable onPress={() => !busy && orderSheet.requestClose()} hitSlop={10}>
                <Text style={styles.sheetClose}>✕</Text>
              </Pressable>
            </View>

            {/* Order type as plain labels from the left, like the Overview's asset categories, rather
                than a segmented control stretched across the sheet. */}
            <View style={styles.segTrack}>
              {MODES.map((m) => (
                <Pressable key={m.key} style={styles.segBtn} onPress={() => pickMode(m.key)}>
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
                  <TextInput style={styles.fieldInput} keyboardType="decimal-pad" placeholder={poolPrice && poolPrice > 0 ? toField(poolPrice) : '0'} placeholderTextColor={c.subtext} value={price} onChangeText={(v) => { setPrice(v); setPriceEdited(true); }} {...priceCaret} onFocus={(e) => { priceCaret.onFocus?.(e); setPriceEdited(true); }} />
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

            <ConfirmButton
              onPress={onSubmit}
              disabled={!canConfirm}
              color={shownSide === 'buy' ? c.buy : c.sell}
              style={styles.submit}
              gas={feeGas}
              fee={feeApplies}
              free={feeFree}
            />
            </Pressable>
            </Animated.View>
          </KeyboardAvoidingView>
          {/* Funding, for a market order. One tickable row per source: the vault's own balance,
              and each position that pays out instantly. Ticking a row puts all of it into the
              order and opens the quick percentages and a field to take less. A market swap
              withdraws and trades in one transaction, so a position is a source like any other —
              its only cost is the yield it stops earning, which is why the rate is on the row.
              Limit and TWAP orders keep the plain source list: they settle later and can only be
              pointed at ONE place. */}
          {mode === 'Market' ? (
            <Sheet
              visible={picker === 'source'}
              title={t('vault.asset')}
              onClose={() => setPicker(null)}
              // Taller than a plain picker: three rows, each with a keypad target and a row of
              // fractions, and the keyboard has to leave something to read.
              height={Math.round(screenHeight * 0.8)}>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
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
              </ScrollView>
            </Sheet>
          ) : (
            <PickerSheet
              visible={picker === 'source'}
              title={t('vault.asset')}
              items={pickerItems}
              selected={spendSource}
              onSelect={(key) => setSpendSource(key as 'free' | 'yield' | 'lend')}
              onClose={() => setPicker(null)}
            />
          )}
          <ToastHost />
        </Pressable>

      </Modal>
      {/* Deleting a list is local and instant — no chain, no fee, no signature — so it gets its own
          sheet rather than the Face ID one every on-chain action shares. What it still needs is a
          moment to think: the bin sits in the bar, a thumb's width from the back button. */}
      <Sheet
        visible={confirmDelete}
        title={t('mobile.home.delete_list')}
        onClose={() => setConfirmDelete(false)}
        height={300}>
        <Text style={styles.deleteMsg}>{t('mobile.home.delete_list_msg', {name: listName})}</Text>
        <Pressable
          style={styles.deleteBtn}
          onPress={() => {
            setConfirmDelete(false);
            if (watch.active) watch.remove(network, watch.active.id);
            nav.goBack();
          }}>
          <Text style={styles.deleteBtnText}>{t('mobile.home.delete_list')}</Text>
        </Pressable>
      </Sheet>

      <PickerSheet
        visible={picker === 'base' || picker === 'quote'}
        title={picker === 'source' ? t('vault.asset') : picker === 'quote' ? t('mobile.trade.select_stablecoin') : t('vault.select_asset')}
        items={pickerItems}
        selected={picker === 'source' ? spendSource : picker === 'quote' ? `${quoteSym}:free` : `${baseSym}:free`}
        onSelect={(key) => {
          if (picker === 'source') {
            setSpendSource(key as 'free' | 'yield' | 'lend');
            return;
          }
          const [sym] = key.split(':');
          if (picker === 'quote') {
            quoteChosen.current = true;
            setQuoteSym(sym);
            pickedPairLeg();
          }
          else selectAsset(sym);
        }}
        onClose={() => setPicker(null)}
      />
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
  deleteMsg: {color: c.subtext, fontSize: 15, lineHeight: 21},
  deleteBtn: {backgroundColor: c.danger, borderRadius: 26, height: 52, alignItems: 'center', justifyContent: 'center', marginTop: 16},
  deleteBtnText: {color: '#FFFFFF', fontSize: 16, fontWeight: '600'},
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
  cancelAllText: {color: c.subtext, fontSize: 12, fontWeight: '600', textDecorationLine: 'underline'},
  empty: {color: c.subtext, fontSize: 13, textAlign: 'center', paddingTop: 10},
  // Its own style, not the orders list's: that one hangs under a header row and is padded at
  // the top only, which left this sitting against the card's top edge instead of in it.
  emptySearch: {color: c.subtext, fontSize: 13, textAlign: 'center', paddingVertical: 36},
  orderCard: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  // An order row reads at the same weight as an asset row elsewhere: 15pt for the line itself, a
  // 44pt-tall tap target, and the labels one step down rather than two.
  orderHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, gap: 10, minHeight: 52},
  orderHeadLeft: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1},
  orderHeadRight: {flexDirection: 'row', alignItems: 'center', gap: 10},
  /**
   * One leg of the trade, not both.
   *
   * It used to read "100 USDC → 0.0312 ETH", which is the whole trade and does not fit: beside a
   * kind badge and a Cancel it ran out of row and ellipsed, usually through the half anyone cared
   * about. The badge already says which direction this is, so the line says what the order is FOR
   * — what a buy buys, what a sell sells — and the other side is a tap away in the detail, where
   * Pay and Receive still spell out both.
   */
  // The icon travels with the leg, so the row says WHICH asset before it says how much of it.
  summaryWrap: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0},
  orderSummary: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
  orderDetail: {paddingBottom: 14, gap: 10},
  // The fraction sits where a status pill does on a plain order, and says the same kind of thing:
  // where this order has got to. Tabular so 3/10 and 10/10 are the same width.
  filledPill: {color: c.subtext, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
  // A part is a smaller thing than an order line, so it reads one step down from the rows above it.
  partRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  partText: {color: c.text, fontSize: 13, fontVariant: ['tabular-nums'], flexShrink: 1},
  partStatus: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  /**
   * The last row gives its trailing space back, so the card's own padding frames the list.
   *
   * This used to be done by dropping `paddingBottom` INSIDE the row — off the head while collapsed,
   * off the detail once open. Which padding was suppressed therefore changed on every tap, and
   * since the head also carries `minHeight`, losing 14 of bottom padding re-centred its contents:
   * the badge and the summary slid several points up as the row opened and back down as it closed.
   * Pulled up from the wrapper instead, the padding inside a row never changes, so nothing moves
   * but the detail appearing — and the gap under the list is the same open or shut.
   */
  lastOrder: {marginBottom: -14},
  kindBadge: {borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4},
  kindText: {fontSize: 12, fontWeight: '700'},
  orderLine: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  orderLabel: {color: c.subtext, fontSize: 14},
  orderAmt: {flexDirection: 'row', alignItems: 'center', gap: 6},
  orderAmtVal: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums']},
  orderAmtSym: {color: c.subtext, fontSize: 14, fontWeight: '600'},
  orderVal: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums']},
  cancelInline: {color: c.danger, fontSize: 15, fontWeight: '600'},
  // The detail rows put every value on the right; the control that acts on them belongs there too.
  cancelRight: {alignSelf: 'flex-end'},
  bar: {flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 18, backgroundColor: c.bg},
  barBtn: {flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center'},
  barText: {color: c.onAccent, fontSize: 17, fontWeight: '700'},
  dim: {opacity: 0.5},
  // sheet
  shade: {backgroundColor: c.overlay},
  sheetBackdrop: {flex: 1, justifyContent: 'flex-end'},
  // Fills the screen below the top strip: full width, square at the bottom, rounded at the top.
  sheetWrap: {flex: 1},
  sheet: {flex: 1, backgroundColor: c.elevated, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 10},
  sheetHead: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 4},
  sheetTitle: {color: c.text, fontSize: 18, fontWeight: '700'},
  sheetQuote: {color: c.subtext, fontWeight: '600'},
  sheetPrice: {color: c.subtext, fontSize: 12, marginTop: 3, fontVariant: ['tabular-nums']},
  sheetClose: {color: c.subtext, fontSize: 18},
  segTrack: {flexDirection: 'row', alignItems: 'center', gap: 20, marginBottom: 4},
  // Pushed to the right edge by its own auto margin rather than a spacer, so the marks keep an
  // 8pt gap of their own instead of the 20pt that separates the order types — a pair reads as one
  // group, not as two more tabs.
  segVenues: {flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto'},
  segBtn: {paddingVertical: 6},
  segText: {color: c.subtext, fontSize: 15, fontWeight: '600'},
  segTextOn: {color: c.text, fontWeight: '700'},
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

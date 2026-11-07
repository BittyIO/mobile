import React, {useEffect} from 'react';
import {ActivityIndicator, Platform, StatusBar, StyleSheet, View} from 'react-native';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';
import {NavigationContainer, DarkTheme, DefaultTheme} from '@react-navigation/native';
import {navigationRef} from '@/core/open-link';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {useWallet} from '@/wallet/store';
import {TabIcon, type TabName} from '@/components/TabIcon';
import {NetworkSwitcher} from '@/components/NetworkSwitcher';
import {TronWalletLabel, VaultSwitcher} from '@/components/VaultSwitcher';
import {useLaunchUpdateCheck} from '@/core/app-update';
import {useGuardProtocols} from '@/core/guard-catalog';
import {useAutoUpgradePlan} from '@/vault/auto-upgrade';
import {useNetwork} from '@/core/network-store';
import {RISK_TITLE} from '@/components/riskFormat';
import {ToastHost} from '@/components/Toast';
import {resumePending} from '@/vault/pending';
import {OnboardingScreen} from '@/screens/OnboardingScreen';
import {LockScreen} from '@/screens/LockScreen';
import {VaultHomeScreen} from '@/screens/VaultHomeScreen';
import {useColors, useIsDark, useStyles, useSyncInterfaceStyle, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * iOS: the header is translucent and content scrolls under it; each page's ScrollView sets
 * contentInsetAdjustmentBehavior="automatic" so it starts below the header. That prop is iOS-only —
 * on Android a transparent header lets the page draw beneath it — so Android gets an opaque header
 * that takes its own space.
 */
const HEADER_TRANSPARENT = Platform.OS === 'ios';

/**
 * iOS: the tabs' bar is the stack's NATIVE bar, not a JS header inside the tab navigator.
 *
 * With the bar hidden on Main, every push from a tab went from "no bar" to "a bar", so UIKit
 * slid the whole navigation bar in and out with the page — swiping back dragged the back button
 * across the screen with it, where a native app keeps the bar still and fades the chevron. With
 * a bar on both sides of the push, only its contents cross-fade.
 *
 * The items are custom views with the shared iOS 26 glass hidden, so the vault's name and the
 * chain's icon read as they did on the JS header. Android keeps the tab header: its stack header
 * is opaque and does not have this transition.
 */
const MAIN_NATIVE_BAR = Platform.OS === 'ios';
function mainBarOptions(tron: unknown) {
  return {
    headerShown: true,
    title: '',
    unstable_headerLeftItems: () => [
      {type: 'custom' as const, hidesSharedBackground: true, element: tron ? <TronWalletLabel stack /> : <VaultSwitcher stack />},
    ],
    unstable_headerRightItems: () => [{type: 'custom' as const, hidesSharedBackground: true, element: <NetworkSwitcher stack />}],
  };
}

/** A pair to open Trade on. Undefined leaves whatever the screen was last showing. */
export type TradeParams = {base?: string; quote?: string} | undefined;

export type TabParamList = {
  Overview: undefined;
  Earn: undefined;
  /** The market directory. The pushed TradePair screen is where a pair is actually traded. */
  Market: TradeParams;
  Settings: undefined;
};

export type RootStackParamList = {
  Main: undefined;
  /** Pay out of the Tron wallet; `symbol` opens on that asset (a tapped balance row). */
  TronSend: {symbol?: string} | undefined;
  /** Every transfer in and out of the Tron wallet. */
  TronHistory: undefined;
  Payments: undefined;
  SelectRecipient: undefined;
  NewRecipient: undefined;
  /** Security › Whitelisted addresses: the address book, to add to and remove from. */
  VaultWhitelist: undefined;
  VaultWhitelistAdd: undefined;
  /** The asset directory as a watch list editor: no prices, a star on every row. */
  Watchlist: undefined;
  /** One Earn position in full: its rate over time, what Auto-Yield does, and both actions. */
  EarnDetail: {
    protocol: string;
    asset: string;
    symbol: string;
    /** The protocol's display name, shown only when DeFi details are on. */
    name: string;
    /** Lending route rather than a staking one — picks the wording throughout. */
    lend: boolean;
  };
  /** One Earn position's earnings per UTC day, as a calendar or a list. */
  DailyEarnings: {
    protocol: string;
    asset: string;
    /** Display symbol, for the amounts. */
    symbol: string;
    decimals?: number;
  };
  EarnAction: {
    mode: 'deposit' | 'withdraw';
    protocol?: string;
    asset?: string;
    symbol?: string;
    decimals?: number;
    max?: string;
    /** A withdraw from a position whose asset Auto-Yield / Auto-Supply routes back into it. */
    autoOn?: boolean;
    lend?: boolean;
  };
  /**
   * The Trade screen again, PUSHED rather than switched to.
   *
   * Tapping an asset on the Overview is a detour into one pair, not a move to another tab: it
   * arrives with a back button and leaves the tab where the user left it. Same component, so
   * there is one trade screen to maintain and not two.
   *
   * NOT called "Trade". `navigate` resolves a name against the nearest navigator that has it, and
   * the Overview sits inside the tabs, which own a route by that name — so a shared name switched
   * tabs and never reached the stack at all.
   */
  TradePair: TradeParams;
  Transactions: {tab?: 'confirming'} | undefined;
  /**
   * Every order the vault has placed — the Cancelled bucket included.
   *
   * `symbol` is the pair the user came from, which the page opens filtered to: arriving from a
   * CRCL chart into a list led by last week's ETH orders is a page about somebody else's day.
   * Omitted (opened from anywhere with no pair in mind) it starts on everything.
   */
  OrderHistory: {symbol?: string} | undefined;
  /** One asset in full: what it is, what the vault holds of it, and how it can be traded. */
  AssetDetail: {symbol: string};
  /** The Overview's holdings, as it had them when the pie was tapped. See {DistributionScreen}. */
  Distribution: {vault: string | null; held: {symbol: string; icon?: string; usd: number}[]; total: number};
  /** Distribution › Positions: the same holdings, a position card each. See {PositionsScreen}. */
  Positions: RootStackParamList['Distribution'];
  /**
   * A web page, inside the app. Reached only through {openLink}, never navigated to directly.
   *
   * `title` is what the caller knows the page to be ("Etherscan"); the document's own title
   * replaces it once it loads, and the host stands in until then.
   */
  Browser: {url: string; title?: string};
  /** What relay fees are billed in, and the float the app will not spend below. */
  NetworkFee: undefined;
  /** Network fee › Pay from vault / Pay from owner wallet: each way's own settings. */
  NetworkFeeVault: undefined;
  NetworkFeeOwner: undefined;
  /** Network fee › Pay from vault › Advanced settings: the relayer's per-operation and 24-hour caps. */
  NetworkFeeLimits: undefined;
  /** Settings › RPC: the owner's own node for on-chain reads. */
  AutoYield: undefined;
  /**
   * The allow list. Without a section it is the two summary rows; with one it is that list.
   *
   * The same screen either way, because the lists and the summary read the same vault state — the
   * allowlist mode, what is registered, which write is in flight — and a second screen would have
   * to fetch and track all of it again to show a subset of it.
   */
  VaultAssets: {section?: 'assets' | 'services'} | undefined;
  /**
   * Which asset to trade. A page rather than a sheet — see {SelectAssetScreen}.
   *
   * `slot` says which leg asked, `selected` marks the current one, and `exclude` keeps the other
   * leg off the list so a pair cannot be set to the same asset on both sides.
   */
  SelectAsset: {slot: 'base' | 'quote'; selected?: string; exclude?: string};
  VaultSecurity: undefined;
  VaultUpgrade: undefined;
  /** Security › Risk settings, Vault lock, Legacy ETH — each a row on the Security page. */
  VaultRiskSettings: undefined;
  /** Pick one risk number: presets, or a custom value. */
  VaultRiskValue: {field: 'timelock' | 'sendDailyAllowance' | 'marketTradeDailyLossAllowance'};
  VaultLock: undefined;
  /** Settings › Vaults: every vault on this phone, and the ones its keys own that are not yet. */
  VaultList: undefined;
  AddSafeVault: undefined;
  VaultLockAction: {action: 'emergency' | 'unlock' | 'forever'};
  /** Overview › Pending: changes the vault has queued and not applied yet. */
  PendingChanges: undefined;
  /** Security › Ownership: who owns the vault, and transferring it (in a sheet). */
  VaultOwnership: undefined;
  /** Security › Quantum-safe keys: a fresh key after every operation (see wallet/rotation). */
  QuantumSafe: undefined;
  /** For a vault owned by a Safe: what is waiting for the Safe's owners to sign. */
  SafeApprovals: undefined;
  VaultRecoveryPhrase: undefined;
  VaultAssetManager: undefined;
  VaultSetAssetManager: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

// React Navigation's own surfaces (header, tab bar, transitions) follow the active palette.
function navThemeFor(c: Colors, dark: boolean) {
  const base = dark ? DarkTheme : DefaultTheme;
  return {...base, colors: {...base.colors, background: c.bg, card: c.bg, text: c.text, border: c.border, primary: c.accent}};
}

/**
 * The four primary tabs. Detail screens are pushed over these from the root stack.
 *
 * Every screen except the first one is loaded with `getComponent`, so its module is required the
 * first time it is navigated to rather than when the app boots. Importing all fourteen at the top
 * meant the whole app — Trade's order book, the CoW and Uniswap helpers, the payments and
 * scheduling code — was parsed and evaluated before the first frame could be drawn, to render one
 * list of balances.
 */
/**
 * The bar's own height, above the home indicator.
 *
 * React Navigation's default leaves the icons pressed against the top edge, with the label almost
 * touching them. This gives the row somewhere to sit: the extra goes on as top padding rather than
 * being shared out, so the icons move DOWN rather than the bar simply growing around them.
 */
const TAB_BAR_HEIGHT = 62;
const TAB_BAR_PADDING_TOP = 12;

/**
 * The tabs with Tron picked are the same tabs: the bar keeps its shape whatever the chain. The
 * Overview becomes the phrase's Tron wallet, and Earn and Trade — which only a vault can do — say
 * so instead of drawing a vault that does not exist on Tron. Settings drops its vault section.
 */
function OverviewTab() {
  const tron = useNetwork((s) => s.tron);
  if (tron) {
    const {TronWalletScreen} = require('@/screens/TronWalletScreen');
    return <TronWalletScreen />;
  }
  return <VaultHomeScreen />;
}

function EarnTab() {
  const tron = useNetwork((s) => s.tron);
  if (tron) {
    const {TronUnavailableScreen} = require('@/screens/TronUnavailableScreen');
    return <TronUnavailableScreen feature="earn" />;
  }
  const {EarnScreen} = require('@/screens/EarnScreen');
  return <EarnScreen />;
}

function TradeTab() {
  const tron = useNetwork((s) => s.tron);
  if (tron) {
    const {TronUnavailableScreen} = require('@/screens/TronUnavailableScreen');
    return <TronUnavailableScreen feature="trade" />;
  }
  const {TradeScreen} = require('@/screens/TradeScreen');
  return <TradeScreen />;
}

function MainTabs() {
  const tron = useNetwork((s) => s.tron);
  const {t} = useT();
  // Once a session reaches the vault: is a newer build out? See {useLaunchUpdateCheck}.
  useLaunchUpdateCheck(t);
  const colors = useColors();
  // Setting an explicit height opts out of the navigator's own safe-area handling, so the home
  // indicator's space has to be added back by hand or the bar sits under it.
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={({route}) => ({
        /**
         * OFF for the tabs, deliberately.
         *
         * It was on to stop a blurred tab re-measuring: a tab mounts on its first visit and is
         * never torn down, so every layout pass walked all four trees. That is a real cost, and it
         * is not worth what it was doing to the two data-heavy tabs.
         *
         * A frozen subtree keeps its last paint on screen and DEFERS rendering, state updates
         * included. On a first visit to Earn or Market the screen mounted, painted once — empty,
         * chart spinning — and was frozen before the focus transition settled. Every read then
         * landed in state unseen: orders, prices, positions, the chart, all of it. Leaving the tab
         * and coming back unfroze it and the whole screen filled in at once, which is what made
         * this look like a loading bug and sent me hunting through the fetch layer twice.
         *
         * The pushed screens in the stack below keep it: they are covered by something, not merely
         * unfocused, so nothing is waiting to be painted behind them.
         */
        freezeOnBlur: false,
        sceneStyle: {backgroundColor: colors.bg},
        // iOS-style translucent header: the list scrolls under it. The tab header is a JS header
        // (no system blur), so a nearly opaque ground stands in for the material; each tab pads its
        // content by the header height (useHeaderHeight).
        headerTransparent: HEADER_TRANSPARENT,
        headerBackground: () => <View style={[StyleSheet.absoluteFill, {backgroundColor: colors.bg, opacity: HEADER_TRANSPARENT ? 0.92 : 1}]} />,
        headerTintColor: colors.text,
        headerShadowVisible: false,
        /**
         * No title: the bar is the vault on the left and the chain on the right, the two things
         * every tab is showing. The tab's name is already on the bar at the bottom, selected, so
         * the header repeating it said nothing the screen did not. `title` still labels that entry.
         */
        headerTitle: () => null,
        /**
         * The chain in the right-hand corner, where it started.
         *
         * It was tried beside the title, as one tappable phrase, on the grounds that a mark with
         * nothing next to it does not say what it is for. In use the trade was the wrong way round:
         * the title is the one thing on a bar that should not move, and hanging a control off it
         * made the page's name shift with the chain's name. The corner is also where a thumb
         * already goes for it.
         */
        headerRight: () => <NetworkSwitcher />,
        // The vault, opposite the chain, on every tab.
        headerLeft: () => (tron ? <TronWalletLabel /> : <VaultSwitcher />),
        // iOS: the bar is the stack's native one, on the Main screen below — see {MAIN_NATIVE_BAR}.
        headerShown: !MAIN_NATIVE_BAR,
        /**
         * The same surface as the header, at the other end of the screen.
         *
         * The header is a near-opaque ground in the PAGE colour that content scrolls under, with no
         * system blur available. The bar used the card colour instead, so the top and bottom of
         * every screen solved the same problem two different ways. It now mirrors the header, and
         * the hairline is what stops the last row of a list dissolving into it — the separator iOS
         * draws on its own tab bar, and the only thing doing that work in light, where white on
         * #F2F2F7 is a four percent step.
         */
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: 'transparent',
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingTop: TAB_BAR_PADDING_TOP,
          paddingBottom: insets.bottom,
          elevation: 0,
        },
        tabBarBackground: () => (
          <View style={[StyleSheet.absoluteFill, {backgroundColor: colors.bg, opacity: 0.92}]} />
        ),
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.subtext,
        tabBarIcon: ({color, size, focused}) => <TabIcon name={route.name as TabName} color={color} size={size} focused={focused} />,
      })}>
      <Tab.Screen name="Overview" options={{title: t('mobile.app.overview')}} component={OverviewTab} />
      <Tab.Screen name="Earn" options={{title: t('mobile.app.earn')}} component={EarnTab} />
      {/* Labelled Trade; the ROUTE keeps the name Market. `navigate` resolves a name against the
            nearest navigator that has it, and a tab called Trade once swallowed every push to the
            pair screen. The title is what the user reads; the name is what routing matches. */}
        <Tab.Screen name="Market" options={{title: t('mobile.app.trade')}} component={TradeTab} />
      {/* Settings, label and route the same — which is also what `navigate` and the tab icon key
          off. It was labelled "Me" for a while, on the grounds that the tab holds the vault, the
          key on this device and the app's own preferences, and "Settings" named only the last of
          those. Back to Settings: it is the word every other app puts on this tab, and a label
          nobody has to learn beats one that is a shade more accurate. */}
      <Tab.Screen name="Settings" options={{title: t('vault.settings')}} getComponent={() => require('@/screens/SettingsScreen').SettingsScreen} />
    </Tab.Navigator>
  );
}

export default function App() {
  const colors = useColors();
  const dark = useIsDark();
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
      <Root />
      {/* Above every screen: action confirmations land here, never in a dialog. */}
      <ToastHost />
    </SafeAreaProvider>
  );
}

/** Session gate: splash while resolving → Onboarding (no wallet) → Lock → the vault tabs. */
function Root() {
  useSyncInterfaceStyle();
  const {t} = useT();
  const colors = useColors();
  const dark = useIsDark();
  const styles = useStyles(makeStyles);
  const navTheme = React.useMemo(() => navThemeFor(colors, dark), [colors, dark]);
  const status = useWallet((s) => s.status);
  const init = useWallet((s) => s.init);
  const network = useNetwork((s) => s.network);
  const tron = useNetwork((s) => s.tron);
  /**
   * The guard's protocol catalog, read before anything needs it.
   *
   * Every relayed write resolves its adapter through a plain function, which cannot wait on a
   * hook — so the read has to be in flight by the time the first trade or deposit is signed.
   * Here, and on every network change, which is the only other moment the answer changes.
   */
  useGuardProtocols(network);
  // The vault's due upgrades, read at opening so no write has to ask for them. See vault/auto-upgrade.
  useAutoUpgradePlan(network);

  useEffect(() => {
    init();
    // Pick up anything still in flight from a previous run: a relayed transaction outlives the app.
    resumePending();
  }, [init]);

  if (status === 'unknown') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (status === 'no-wallet') return <OnboardingScreen />;
  if (status === 'locked') return <LockScreen />;

  return (
    <NavigationContainer theme={navTheme} ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{
          // Translucent header with the same tinted ground as the tab header, so a pushed page and a
          // tab look alike; the content scrolls under it. Pages set
          // contentInsetAdjustmentBehavior="automatic" so their content starts below the header.
          headerTransparent: HEADER_TRANSPARENT,
          // native-stack treats ANY headerBackground as translucent (content draws under it), so
          // Android gets a plain solid header colour instead.
          ...(HEADER_TRANSPARENT
            ? {headerBackground: () => <View style={[StyleSheet.absoluteFill, {backgroundColor: colors.bg, opacity: 0.92}]} />}
            : {headerStyle: {backgroundColor: colors.bg}}),
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: {backgroundColor: colors.bg},
          headerBackButtonDisplayMode: 'minimal',
          headerBackTitle: '',
          // As above: a pushed screen covers the tabs, and the tabs keep measuring underneath it.
          freezeOnBlur: true,
        }}>
        <Stack.Screen name="Main" component={MainTabs} options={MAIN_NATIVE_BAR ? mainBarOptions(tron) : {headerShown: false}} />
        <Stack.Screen name="TronSend" getComponent={() => require('@/screens/TronSendScreen').TronSendScreen} options={{title: t('mobile.tron.send_title')}} />
        <Stack.Screen name="TronHistory" getComponent={() => require('@/screens/TronHistoryScreen').TronHistoryScreen} options={{title: t('mobile.app.history')}} />
        <Stack.Screen name="Payments" getComponent={() => require('@/screens/PaymentsScreen').PaymentsScreen} options={{title: t('vault.send')}} />
        <Stack.Screen
          name="SelectRecipient"
          getComponent={() => require('@/screens/SelectRecipientScreen').SelectRecipientScreen}
          options={{title: t('mobile.payments.select_recipient')}}
        />
        <Stack.Screen
          name="NewRecipient"
          getComponent={() => require('@/screens/NewRecipientScreen').NewRecipientScreen}
          options={{title: t('mobile.payments.new_recipient')}}
        />
        <Stack.Screen
          name="VaultWhitelist"
          getComponent={() => require('@/screens/SelectRecipientScreen').WhitelistScreen}
          options={{title: t('mobile.settings.whitelisted_addresses')}}
        />
        <Stack.Screen
          name="VaultWhitelistAdd"
          getComponent={() => require('@/screens/NewRecipientScreen').AddWhitelistedScreen}
          options={{title: t('mobile.settings.add_whitelisted')}}
        />
        <Stack.Screen
          name="Watchlist"
          getComponent={() => require('@/screens/TradeScreen').TradeScreen}
          options={{title: t('mobile.home.watch_list'), fullScreenGestureEnabled: true}}
        />
        {/* Titled by WHICH KIND of Earn it is, from the route's own `lend` flag — the two sections
            on the tab are Flexible Yield and Flexible Lend, and a page pushed from either said
            only "Earn", so the back stack read as three identical titles and the page itself never
            said which of the two markets it was for. */}
        <Stack.Screen
          name="EarnDetail"
          getComponent={() => require('@/screens/EarnDetailScreen').EarnDetailScreen}
          options={({route}) => ({
            title: t((route.params as {lend?: boolean} | undefined)?.lend ? 'vault.flexible_lend' : 'vault.flexible_yield'),
            fullScreenGestureEnabled: true,
          })}
        />
        <Stack.Screen
          name="DailyEarnings"
          getComponent={() => require('@/screens/DailyEarningsScreen').DailyEarningsScreen}
          options={{title: t('mobile.earn.daily_title'), fullScreenGestureEnabled: true}}
        />
        {/* Presented like the order sheet on the pair screen: a page sheet that comes up to just
            under the status bar. A short detent squeezed the amount form against its own confirm
            button; this is one number and a button, but it is still a form. */}
        {/**
          * The order sheet's own shape, not a native `formSheet`.
          *
          * A form sheet looked right and behaved wrong: it brings a navigation bar this form has no
          * use for, it centres short content instead of starting it at the top, and a TextInput
          * inside one would not raise the keyboard at all. The trade order sheet has none of those
          * problems because it is a transparent modal that draws its own card — so this is that,
          * and the screen itself draws the card. See {EarnActionScreen}.
          *
          * `animation: 'none'`, deliberately: the CARD animates, not the screen. The screen is a
          * transparent layer with a backdrop on it, and sliding that produces a second motion over
          * the sheet's own — and a backdrop that slides in from below instead of fading. The sheet
          * rises, follows a drag and slides out under {useSheetAnim}, as the order sheet's does.
          */}
        <Stack.Screen
          name="EarnAction"
          getComponent={() => require('@/screens/EarnActionScreen').EarnActionScreen}
          options={{
            headerShown: false,
            presentation: 'transparentModal',
            animation: 'none',
            /**
             * Transparent means transparent, which it is not by default.
             *
             * A native-stack screen paints the theme's own background, so the route came up as an
             * opaque sheet of #000 in dark mode with the sheet's backdrop on top of it: the page
             * behind was not dimmed, it was covered. The backdrop is the only thing that should be
             * darkening anything here — see {FormSheet}.
             */
            contentStyle: {backgroundColor: 'transparent'},
          }}
        />

        {/* The tab's own screen, pushed. The pair is named at the top of the page itself, so the
            header does not repeat it. */}
        <Stack.Screen
          name="TradePair"
          getComponent={() => require('@/screens/TradeScreen').TradeScreen}
          // The star lives on the page, not in the nav bar: iOS 26 draws a glass capsule behind
          // every custom bar button item, and nothing in react-native-screens turns it off.
          //
          // Swipe back from anywhere, not just the left edge. The page is a column — chart, orders,
          // buttons — with nothing that pans sideways, so the whole width can belong to the back
          // gesture. The directory this page opens FROM keeps the edge-only default, because its
          // categories swipe horizontally and would fight it.
          options={{title: t('mobile.app.trade'), fullScreenGestureEnabled: true}}
        />
        <Stack.Screen name="Transactions" getComponent={() => require('@/screens/TransactionsScreen').TransactionsScreen} options={{title: t('mobile.app.history')}} />
        {/* No title here: the screen sets its own from the page, and a placeholder would flash
            first. See {BrowserScreen}. */}
        <Stack.Screen name="Browser" getComponent={() => require('@/screens/BrowserScreen').BrowserScreen} options={{title: ''}} />
        <Stack.Screen
          name="OrderHistory"
          getComponent={() => require('@/screens/OrderHistoryScreen').OrderHistoryScreen}
          options={{title: t('mobile.trade.order_history'), fullScreenGestureEnabled: true}}
        />
        <Stack.Screen
          name="Distribution"
          getComponent={() => require('@/screens/DistributionScreen').DistributionScreen}
          options={{title: t('mobile.trade.distribution'), fullScreenGestureEnabled: true}}
        />
        <Stack.Screen
          name="Positions"
          getComponent={() => require('@/screens/PositionsScreen').PositionsScreen}
          options={{title: t('vault.positions'), fullScreenGestureEnabled: true}}
        />
        <Stack.Screen
          name="AssetDetail"
          getComponent={() => require('@/screens/AssetDetailScreen').AssetDetailScreen}
          options={{title: t('mobile.trade.asset_details'), fullScreenGestureEnabled: true}}
        />
        <Stack.Screen
          name="NetworkFee"
          getComponent={() => require('@/screens/NetworkFeeScreen').NetworkFeeScreen}
          options={{title: t('mobile.settings.network_fee')}}
        />
        <Stack.Screen
          name="NetworkFeeVault"
          getComponent={() => require('@/screens/NetworkFeeScreen').NetworkFeeVaultScreen}
          options={{title: t('mobile.fees.payer_vault')}}
        />
        <Stack.Screen
          name="NetworkFeeOwner"
          getComponent={() => require('@/screens/NetworkFeeScreen').NetworkFeeOwnerScreen}
          options={{title: t('mobile.fees.payer_owner')}}
        />
        <Stack.Screen
          name="NetworkFeeLimits"
          getComponent={() => require('@/screens/NetworkFeeLimitsScreen').NetworkFeeLimitsScreen}
          options={{title: t('mobile.fees.advanced')}}
        />
        <Stack.Screen name="AutoYield" getComponent={() => require('@/screens/AutoYieldScreen').AutoYieldScreen} options={{title: t('mobile.app.auto_yield'), presentation: 'modal'}} />
        <Stack.Screen
          name="VaultAssets"
          getComponent={() => require('@/screens/ManageScreen').ManageScreen}
          options={({route}) => ({
            title:
              route.params?.section === 'assets'
                ? t('mobile.vault.allowlist_assets')
                : route.params?.section === 'services'
                  ? t('mobile.vault.allowlist_protocols')
                  : t('mobile.settings.allow_list'),
          })}
        />
        <Stack.Screen
          name="SelectAsset"
          getComponent={() => require('@/screens/SelectAssetScreen').SelectAssetScreen}
          options={{title: t('vault.select_asset')}}
        />
        <Stack.Screen name="VaultSecurity" getComponent={() => require('@/screens/SecurityScreen').SecurityScreen} options={{title: t('mobile.app.security')}} />
        <Stack.Screen name="VaultUpgrade" getComponent={() => require('@/screens/UpgradeScreen').UpgradeScreen} options={{title: t('mobile.settings.contract_upgrade')}} />
        <Stack.Screen name="VaultRiskSettings" getComponent={() => require('@/screens/RiskSettingsScreen').RiskSettingsScreen} options={{title: t('mobile.vault.risk_settings')}} />
        <Stack.Screen
          name="VaultRiskValue"
          getComponent={() => require('@/screens/RiskValueScreen').RiskValueScreen}
          options={({route}) => ({title: t(RISK_TITLE[route.params.field])})}
        />
        <Stack.Screen name="VaultList" getComponent={() => require('@/screens/VaultListScreen').VaultListScreen} options={{title: t('mobile.settings.choose_vault')}} />
        <Stack.Screen name="AddSafeVault" getComponent={() => require('@/screens/AddSafeVaultScreen').AddSafeVaultScreen} options={{title: t('mobile.safe.add_safe_title')}} />
        <Stack.Screen name="VaultLock" getComponent={() => require('@/screens/VaultLockScreen').VaultLockScreen} options={{title: t('mobile.vault.vault_lock')}} />
        <Stack.Screen
          name="VaultLockAction"
          getComponent={() => require('@/screens/VaultLockActionScreen').VaultLockActionScreen}
          options={({route}) => ({
            title: t(
              route.params.action === 'unlock'
                ? 'mobile.vault.unlock'
                : route.params.action === 'forever'
                  ? 'mobile.vault.forever_lock'
                  : 'mobile.vault.emergency_lock',
            ),
          })}
        />
        <Stack.Screen name="PendingChanges" getComponent={() => require('@/screens/PendingChangesScreen').PendingChangesScreen} options={{title: t('mobile.vault.timelock_page_title')}} />
        <Stack.Screen name="VaultOwnership" getComponent={() => require('@/screens/OwnershipScreen').OwnershipScreen} options={{title: t('mobile.vault.ownership')}} />
        <Stack.Screen name="QuantumSafe" getComponent={() => require('@/screens/QuantumSafeScreen').QuantumSafeScreen} options={{title: t('mobile.quantum.title')}} />
        <Stack.Screen name="SafeApprovals" getComponent={() => require('@/screens/SafeApprovalsScreen').SafeApprovalsScreen} options={{title: t('mobile.safe.approvals')}} />
        <Stack.Screen name="VaultAssetManager" getComponent={() => require('@/screens/AssetManagerScreen').AssetManagerScreen} options={{title: t('mobile.vault.delegation')}} />
        <Stack.Screen
          name="VaultSetAssetManager"
          getComponent={() => require('@/screens/SetAssetManagerScreen').SetAssetManagerScreen}
          options={{title: t('mobile.vault.set_asset_manager')}}
        />
        <Stack.Screen name="VaultRecoveryPhrase" getComponent={() => require('@/screens/RecoveryPhraseScreen').RecoveryPhraseScreen} options={{title: t('mobile.settings.recovery_phrase')}} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    splash: {flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center'},
  });

import React, {useEffect} from 'react';
import {ActivityIndicator, Pressable, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';
import {NavigationContainer, DarkTheme, DefaultTheme} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {useWallet} from '@/wallet/store';
import {TabIcon, type TabName} from '@/components/TabIcon';
import {NetworkSwitcher} from '@/components/NetworkSwitcher';
import {ToastHost} from '@/components/Toast';
import {ConfirmingBadge} from '@/components/ConfirmingBadge';
import {resumePending} from '@/vault/pending';
import {OnboardingScreen} from '@/screens/OnboardingScreen';
import {LockScreen} from '@/screens/LockScreen';
import {VaultHomeScreen} from '@/screens/VaultHomeScreen';
import {useColors, useIsDark, useStyles, useSyncInterfaceStyle, type Colors} from '@/theme';
import {useT} from '@/i18n';

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
  Payments: undefined;
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
  EarnAction: {
    mode: 'deposit' | 'withdraw';
    protocol?: string;
    asset?: string;
    symbol?: string;
    decimals?: number;
    max?: string;
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
  /** Every order the vault has placed, on every pair — the Cancelled bucket included. */
  OrderHistory: undefined;
  /** One asset in full: what it is, what the vault holds of it, and how it can be traded. */
  AssetDetail: {symbol: string};
  AddLiquidity: undefined;
  AutoYield: undefined;
  Delegation: undefined;
  VaultAssets: undefined;
  VaultSecurity: undefined;
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

function MainTabs() {
  const {t} = useT();
  const colors = useColors();
  const dark = useIsDark();
  const styles = useStyles(makeStyles);
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
        headerTransparent: true,
        headerBackground: () => <View style={[StyleSheet.absoluteFill, {backgroundColor: colors.bg, opacity: 0.92}]} />,
        headerTintColor: colors.text,
        headerShadowVisible: false,
        /**
         * The tab's own name, centred, with the confirming badge on the left.
         *
         * `children` is whatever the screen set as its `title`, so each tab labels its header and
         * its bar entry from one string — the Overview is the exception and names the app instead
         * (see its screen below), because the first tab is the one that carries it.
         *
         * The badge sits in the left corner rather than beside the title: it is about the vault,
         * not about the tab, and a count that shifts a centred title sideways as it appears is a
         * title that moves for reasons the user cannot see. It renders nothing at zero, so that
         * corner is usually empty.
         */
        headerTitleAlign: 'center',
        headerTitle: ({children}) => <Text style={styles.headerTitle}>{children}</Text>,
        headerLeft: () => (
          <View style={styles.headerBadge}>
            <ConfirmingBadge />
          </View>
        ),
        headerRight: () => <NetworkSwitcher />,
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
      {/* The home tab carries the app's name, not its own. "Overview" still labels the bar entry
          below — `title` does that — so only the header differs. */}
      <Tab.Screen
        name="Overview"
        options={{title: t('mobile.app.overview'), headerTitle: () => <Text style={styles.headerTitle}>Bitty</Text>}}
        component={VaultHomeScreen}
      />
      <Tab.Screen name="Earn" options={{title: t('mobile.app.earn')}} getComponent={() => require('@/screens/EarnScreen').EarnScreen} />
      {/* Labelled Trade; the ROUTE keeps the name Market. `navigate` resolves a name against the
            nearest navigator that has it, and a tab called Trade once swallowed every push to the
            pair screen. The title is what the user reads; the name is what routing matches. */}
        <Tab.Screen name="Market" options={{title: t('mobile.app.trade')}} getComponent={() => require('@/screens/TradeScreen').TradeScreen} />
      {/* Labelled "Me"; the ROUTE keeps the name Settings, as `navigate` and the tab icon key off
          it. The tab holds the vault, the key on this device and the app's own preferences — "Me"
          is what all three have in common, where "Settings" named only the last of them. */}
      <Tab.Screen name="Settings" options={{title: t('mobile.app.me')}} getComponent={() => require('@/screens/SettingsScreen').SettingsScreen} />
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
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          // Translucent header with the same tinted ground as the tab header, so a pushed page and a
          // tab look alike; the content scrolls under it. Pages set
          // contentInsetAdjustmentBehavior="automatic" so their content starts below the header.
          headerTransparent: true,
          headerBackground: () => <View style={[StyleSheet.absoluteFill, {backgroundColor: colors.bg, opacity: 0.92}]} />,
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: {backgroundColor: colors.bg},
          headerBackButtonDisplayMode: 'minimal',
          headerBackTitle: '',
          // As above: a pushed screen covers the tabs, and the tabs keep measuring underneath it.
          freezeOnBlur: true,
        }}>
        <Stack.Screen name="Main" component={MainTabs} options={{headerShown: false}} />
        <Stack.Screen name="Payments" getComponent={() => require('@/screens/PaymentsScreen').PaymentsScreen} options={{title: t('vault.send')}} />
        <Stack.Screen
          name="Watchlist"
          getComponent={() => require('@/screens/TradeScreen').TradeScreen}
          options={{title: t('mobile.home.watch_list'), fullScreenGestureEnabled: true}}
        />
        <Stack.Screen
          name="EarnDetail"
          getComponent={() => require('@/screens/EarnDetailScreen').EarnDetailScreen}
          options={{title: t('mobile.app.earn'), fullScreenGestureEnabled: true}}
        />
        {/* Presented like the order sheet on the pair screen: a page sheet that comes up to just
            under the status bar. A short detent squeezed the amount form against its own confirm
            button; this is one number and a button, but it is still a form. */}
        <Stack.Screen
          name="EarnAction"
          getComponent={() => require('@/screens/EarnActionScreen').EarnActionScreen}
          options={{title: t('mobile.app.earn'), presentation: 'modal'}}
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
        <Stack.Screen
          name="OrderHistory"
          getComponent={() => require('@/screens/OrderHistoryScreen').OrderHistoryScreen}
          options={{title: t('mobile.trade.order_history'), fullScreenGestureEnabled: true}}
        />
        <Stack.Screen
          name="AssetDetail"
          getComponent={() => require('@/screens/AssetDetailScreen').AssetDetailScreen}
          options={{title: t('mobile.trade.asset_details'), fullScreenGestureEnabled: true}}
        />
        <Stack.Screen name="AddLiquidity" getComponent={() => require('@/screens/AddLiquidityScreen').AddLiquidityScreen} options={{title: t('mobile.app.add_liquidity'), presentation: 'modal'}} />
        <Stack.Screen name="AutoYield" getComponent={() => require('@/screens/AutoYieldScreen').AutoYieldScreen} options={{title: t('mobile.app.auto_yield'), presentation: 'modal'}} />
        <Stack.Screen name="Delegation" getComponent={() => require('@/screens/DelegationScreen').DelegationScreen} options={{title: t('vault.payout_operators')}} />
        <Stack.Screen name="VaultAssets" getComponent={() => require('@/screens/ManageScreen').ManageScreen} options={{title: t('mobile.settings.allow_list')}} />
        <Stack.Screen name="VaultSecurity" getComponent={() => require('@/screens/SecurityScreen').SecurityScreen} options={{title: t('mobile.app.security')}} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    splash: {flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center'},
    // The header's left container has no inset of its own (only the back button it usually holds
    // brings one), so this supplies the 16 that matches the switcher's margin on the right.
    headerBadge: {marginLeft: 16},
    headerTitle: {color: colors.text, fontSize: 17, fontWeight: '700'},
  });

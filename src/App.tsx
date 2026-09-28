import React, {useEffect} from 'react';
import {ActivityIndicator, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {NavigationContainer, DarkTheme, DefaultTheme} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {useWallet} from '@/wallet/store';
import {TabIcon, type TabName} from '@/components/TabIcon';
import {NetworkSwitcher} from '@/components/NetworkSwitcher';
import {ToastHost} from '@/components/Toast';
import {OnboardingScreen} from '@/screens/OnboardingScreen';
import {LockScreen} from '@/screens/LockScreen';
import {VaultHomeScreen} from '@/screens/VaultHomeScreen';
import {PaymentsScreen} from '@/screens/PaymentsScreen';
import {EarnScreen} from '@/screens/EarnScreen';
import {TradeScreen} from '@/screens/TradeScreen';
import {SettingsScreen} from '@/screens/SettingsScreen';
import {ManageScreen} from '@/screens/ManageScreen';
import {SecurityScreen} from '@/screens/SecurityScreen';
import {EarnActionScreen} from '@/screens/EarnActionScreen';
import {TransactionsScreen} from '@/screens/TransactionsScreen';
import {AddLiquidityScreen} from '@/screens/AddLiquidityScreen';
import {AutoYieldScreen} from '@/screens/AutoYieldScreen';
import {DelegationScreen} from '@/screens/DelegationScreen';
import {GaslessScreen} from '@/screens/GaslessScreen';
import {useColors, useIsDark, useStyles, useSyncInterfaceStyle, type Colors} from '@/theme';
import {useT} from '@/i18n';

export type TabParamList = {
  Overview: undefined;
  Earn: undefined;
  Trade: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Main: undefined;
  Payments: undefined;
  EarnAction: {
    mode: 'deposit' | 'withdraw';
    protocol?: string;
    asset?: string;
    symbol?: string;
    decimals?: number;
    max?: string;
  };
  Transactions: undefined;
  AddLiquidity: undefined;
  AutoYield: undefined;
  Delegation: undefined;
  Gasless: undefined;
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

/** The five primary tabs. Detail screens are pushed over these from the root stack. */
function MainTabs() {
  const {t} = useT();
  const colors = useColors();
  const dark = useIsDark();
  const styles = useStyles(makeStyles);
  return (
    <Tab.Navigator
      screenOptions={({route}) => ({
        sceneStyle: {backgroundColor: colors.bg},
        // iOS-style translucent header: the list scrolls under it. The tab header is a JS header
        // (no system blur), so a nearly opaque ground stands in for the material; each tab pads its
        // content by the header height (useHeaderHeight).
        headerTransparent: true,
        headerBackground: () => <View style={[StyleSheet.absoluteFill, {backgroundColor: colors.bg, opacity: 0.92}]} />,
        headerTintColor: colors.text,
        headerShadowVisible: false,
        headerTitle: () => null,
        // Placeholder for a future multi-vault switcher — one vault per owner for now.
        headerLeft: () => <Text style={styles.headerVault}>{t('mobile.app.vault_n', {n: 1})}</Text>,
        headerRight: () => <NetworkSwitcher />,
        // A soft upward shadow instead of a hairline, so the bar floats over the content it covers.
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopWidth: 0,
          shadowColor: '#000',
          shadowOffset: {width: 0, height: -3},
          shadowOpacity: dark ? 0.35 : 0.08,
          shadowRadius: 10,
          elevation: 12,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.subtext,
        tabBarIcon: ({color, size}) => <TabIcon name={route.name as TabName} color={color} size={size} />,
      })}>
      <Tab.Screen name="Overview" options={{title: t('mobile.app.overview')}} component={VaultHomeScreen} />
      <Tab.Screen name="Earn" options={{title: t('mobile.app.earn')}} component={EarnScreen} />
      <Tab.Screen name="Trade" options={{title: t('mobile.app.trade')}} component={TradeScreen} />
      <Tab.Screen name="Settings" options={{title: t('mobile.app.settings')}} component={SettingsScreen} />
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
        }}>
        <Stack.Screen name="Main" component={MainTabs} options={{headerShown: false}} />
        <Stack.Screen name="Payments" component={PaymentsScreen} options={{title: t('mobile.app.payments')}} />
        <Stack.Screen name="EarnAction" component={EarnActionScreen} options={{title: t('mobile.app.earn'), presentation: 'modal'}} />
        <Stack.Screen name="Transactions" component={TransactionsScreen} options={{title: t('mobile.app.history')}} />
        <Stack.Screen name="AddLiquidity" component={AddLiquidityScreen} options={{title: t('mobile.app.add_liquidity'), presentation: 'modal'}} />
        <Stack.Screen name="AutoYield" component={AutoYieldScreen} options={{title: t('mobile.app.auto_yield'), presentation: 'modal'}} />
        <Stack.Screen name="Delegation" component={DelegationScreen} options={{title: t('vault.payout_operators')}} />
        <Stack.Screen name="Gasless" component={GaslessScreen} options={{title: t('mobile.settings.gas_token')}} />
        <Stack.Screen name="VaultAssets" component={ManageScreen} options={{title: t('mobile.settings.allow_list')}} />
        <Stack.Screen name="VaultSecurity" component={SecurityScreen} options={{title: t('mobile.app.security')}} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    splash: {flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center'},
    headerVault: {color: colors.text, fontSize: 17, fontWeight: '700', marginLeft: 16},
  });

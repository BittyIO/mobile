import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import {useTransparentHeaderInset} from '@/components/header-inset';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Svg, {Circle, Path} from 'react-native-svg';
import {formatUnits} from 'viem';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {useNetwork} from '@/core/network-store';
import {fmtValue} from '@/core/prices';
import {Button} from '@/components/Button';
import {ReceiveDialog} from '@/components/ReceiveDialog';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {HoldingRow} from '@/components/HoldingRow';
import {EyeIcon} from '@/screens/VaultHomeScreen';
import {useMarketStats} from '@/vault/useMarketStats';
import {getFlag, setFlag, HIDE_BALANCES} from '@/core/prefs';
import {unlockRoot} from '@/wallet/keyring';
import {rememberTronAddress, useTronWallet} from '@/tron/store';
import {balances, trxUsd, type TronBalance} from '@/tron/client';
import {TRON_LABEL, type TronNet} from '@/tron/config';

const amountOf = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals));
const TRON_SYMBOLS = ['TRX', 'USDT'];

/**
 * The Tron wallet: what the phrase's Tron address holds, with Send / Receive / History.
 *
 * A wallet and nothing more — there is no vault on Tron, so none of the vault's protections (the
 * timelock, the send allowance, the address book) stand between this page and the chain.
 */
export function TronWalletScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const net = useNetwork((s) => s.tron) ?? 'tron';
  const address = useTronWallet((s) => s.address);
  // The Overview tab's own header and bar: translucent, so the page insets itself by both.
  const headerHeight = useTransparentHeaderInset();
  const tabBarHeight = useBottomTabBarHeight();
  const insets = {
    contentInset: {top: headerHeight},
    contentOffset: {x: 0, y: -headerHeight},
    scrollIndicatorInsets: {top: headerHeight},
    automaticallyAdjustContentInsets: false,
  } as const;

  const [held, setHeld] = useState<TronBalance[] | null | undefined>(undefined);
  const [price, setPrice] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The Overview's eye, and the same preference: hiding balances on one chain hides them on all.
  const [hidden, setHidden] = useState(() => getFlag(HIDE_BALANCES));
  const toggleHidden = () => {
    setFlag(HIDE_BALANCES, !hidden);
    setHidden(!hidden);
  };
  // The day's move beside each price. Asked as mainnet's: the server prices TRX (and USDT) by
  // their CoinGecko ids, which are the same coin whichever Tron network holds it.
  const [statsNonce, setStatsNonce] = useState(0);
  const stats = useMarketStats('mainnet', TRON_SYMBOLS, statsNonce);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  // A load for an address or chain the user has already left must not land on the one in front.
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!address) return;
    const n = ++seq.current;
    await Promise.all([
      balances(net, address).then(
        (b) => n === seq.current && setHeld(b),
        () => n === seq.current && setHeld((h) => h ?? null),
      ),
      // Priced as the Overview prices a testnet: at the real coin's price, as EVM's Sepolia is.
      trxUsd().then((p) => n === seq.current && p != null && setPrice(p)),
    ]);
  }, [address, net]);

  // A different chain is a different wallet's figures: clear them rather than show the last one's.
  useEffect(() => {
    setHeld(undefined);
  }, [net, address]);

  // Every time the page comes back into view — after a send, most of all.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    setStatsNonce((x) => x + 1);
    await load();
    setRefreshing(false);
  };

  const workOutAddress = async () => {
    setUnlocking(true);
    try {
      const root = await unlockRoot();
      if (root) rememberTronAddress(root);
    } finally {
      setUnlocking(false);
    }
  };

  if (!address) {
    return (
      <ScrollView style={styles.container} {...insets} contentContainerStyle={[styles.content, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}>
        <View style={styles.heroCard}>
          <View style={styles.setupIcon}>
            <NetworkIcon network={net} size={56} />
          </View>
          <Text style={styles.setupTitle}>{t('mobile.tron.setup_title')}</Text>
          <Text style={styles.setupBody}>{t('mobile.tron.setup_body')}</Text>
          <Button title={t('mobile.tron.setup_button')} faceId loading={unlocking} onPress={() => void workOutAddress()} style={styles.setupBtn} />
        </View>
      </ScrollView>
    );
  }

  const usdOf = (b: TronBalance) => (b.asset.symbol === 'USDT' ? 1 : price);
  // The dollar total, or none at all while anything held has no price: a total missing one of its
  // parts would understate the wallet. An empty balance needs no price.
  const total =
    held && held.every((b) => b.raw === 0n || usdOf(b) != null)
      ? held.reduce((sum, b) => sum + (b.raw === 0n ? 0 : amountOf(b.raw, b.asset.decimals) * (usdOf(b) ?? 0)), 0)
      : null;

  return (
    <>
      <ScrollView
        style={styles.container}
        {...insets}
        contentContainerStyle={[styles.content, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
        alwaysBounceVertical
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={c.text} colors={[c.accent]} />}>
        <View style={styles.heroCard}>
          <View style={styles.totalHeader}>
            <View style={styles.totalLabelRow}>
              <Text style={styles.totalLabel}>{t('vault.total_value_label')}</Text>
            </View>
            <Pressable onPress={toggleHidden} hitSlop={10}>
              <EyeIcon off={hidden} color={c.subtext} />
            </Pressable>
          </View>
          {hidden ? (
            <Text style={styles.totalValue}>••••••</Text>
          ) : held === undefined ? (
            <View style={styles.totalLoading}>
              <ActivityIndicator color={c.subtext} />
            </View>
          ) : (
            <Text style={styles.totalValue}>{total != null ? fmtValue(total) : '—'}</Text>
          )}
          <View style={styles.actions}>
            {(
              [
                {label: t('vault.send'), icon: 'send', onPress: () => nav.navigate('TronSend', undefined)},
                {label: t('vault.receive'), icon: 'receive', onPress: () => setReceiveOpen(true)},
                {label: t('mobile.app.history'), icon: 'history', onPress: () => nav.navigate('TronHistory')},
              ] as const
            ).map((a) => (
              <Pressable key={a.icon} style={styles.action} onPress={a.onPress} accessibilityRole="button">
                <View style={styles.actionCircle}>
                  {a.icon === 'history' ? <Clock color={c.accent} /> : <Arrow out={a.icon === 'send'} color={c.accent} />}
                </View>
                <Text style={styles.actionLabel}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <Text style={styles.groupLabel}>{t('mobile.tron.assets')}</Text>
        <View style={styles.listCard}>
          {held === null ? (
            <Text style={styles.empty}>{t('mobile.tron.balance_failed')}</Text>
          ) : held === undefined ? (
            <View style={styles.emptyRow}>
              <ActivityIndicator color={c.subtext} />
            </View>
          ) : (
            // The Overview's own holding rows: price and the day's move under the ticker, the
            // amount and its value at the right. A tap opens Send on that asset.
            held.map((b, i) => {
              const amount = amountOf(b.raw, b.asset.decimals);
              const p = usdOf(b);
              return (
                <HoldingRow
                  key={b.asset.symbol}
                  symbol={b.asset.symbol}
                  iconNode={b.asset.contract ? undefined : <NetworkIcon network={net} size={30} />}
                  price={p}
                  change24h={stats.get(b.asset.symbol)?.change24h}
                  total={amount}
                  usd={p != null ? amount * p : null}
                  hidden={hidden}
                  first={i === 0}
                  onPress={() => nav.navigate('TronSend', {symbol: b.asset.symbol})}
                />
              );
            })
          )}
        </View>
      </ScrollView>
      <ReceiveDialog
        visible={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        vault={address}
        networkLabel={TRON_LABEL[net as TronNet]}
        title={t('vault.receive')}
        sub={t('mobile.tron.receive_sub')}
      />
    </>
  );
}

/** History's clock, the Overview's mark. */
function Clock({color}: {color: string}) {
  const s = {stroke: color, strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9} {...s} />
      <Path d="M12 7.5V12l3 2" {...s} />
    </Svg>
  );
}

/** Send's arrow up and away, Receive's down and in — the Overview's marks. */
function Arrow({out, color, size = 22}: {out: boolean; color: string; size?: number}) {
  const s = {stroke: color, strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {out ? (
        <>
          <Path d="M7 17L17 7" {...s} />
          <Path d="M8 7h9v9" {...s} />
        </>
      ) : (
        <>
          <Path d="M17 7L7 17" {...s} />
          <Path d="M16 17H7V8" {...s} />
        </>
      )}
    </Svg>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    content: {padding: 16, paddingBottom: 40},
    heroCard: {backgroundColor: c.card, borderRadius: 20, padding: 20, gap: 6},
    totalHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
    totalLabel: {color: c.subtext, fontSize: 13, fontWeight: '600'},
    totalLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
    listCard: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 4},
    testnet: {color: c.warning, backgroundColor: c.warningSoft, fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, overflow: 'hidden'},
    totalValue: {color: c.text, fontSize: 34, fontWeight: '800'},
    totalLoading: {height: 41, justifyContent: 'center', alignItems: 'flex-start'},
    actions: {flexDirection: 'row', justifyContent: 'space-around', marginTop: 16, paddingTop: 18, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    action: {alignItems: 'center', gap: 8},
    actionCircle: {width: 54, height: 54, borderRadius: 27, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center'},
    actionLabel: {color: c.text, fontSize: 13, fontWeight: '600'},
    groupLabel: {color: c.subtext, fontSize: 13, fontWeight: '600', marginTop: 24, marginBottom: 8, paddingHorizontal: 16},
    empty: {color: c.subtext, fontSize: 14, padding: 16, textAlign: 'center'},
    emptyRow: {padding: 18, alignItems: 'center'},
    setupIcon: {alignItems: 'center', marginBottom: 6},
    setupTitle: {color: c.text, fontSize: 20, fontWeight: '800', textAlign: 'center'},
    setupBody: {color: c.subtext, fontSize: 14, lineHeight: 20, textAlign: 'center'},
    setupBtn: {marginTop: 12},
  });

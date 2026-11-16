import React, {useState} from 'react';
import {RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import {formatUnits} from 'viem';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {TRON_STAKE} from '@/vault/tron-stake';
import type {EarnRoute} from '@/vault/earn-routes';
import type {Position} from '@/vault/positions';
import {EarnRow, EarnTable} from '@/screens/EarnScreen';
import {useTronStake} from '@/tron/useTronStake';

const trx = (sun: bigint) => formatUnits(sun, 6);

/**
 * Earn on the Tron wallet: the vault's Earn tab as it was on Tron, drawn from the wallet's own
 * stake (see tron/stake). One row, TRX in TRON Stake, opening the same detail page the vault had.
 */
export function TronStakeScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const headerHeight = useTransparentHeaderInset();
  const tabBarHeight = useBottomTabBarHeight();
  const {state, loading, load} = useTronStake();
  const [pulled, setPulled] = useState(false);

  const now = Date.now();
  const unstaking = (state?.unstaking ?? []).filter((u) => u.unlockAt > now).reduce((n, u) => n + u.amountSun, 0n);
  // The row's shape, as the vault's Earn list builds it from a route and a position.
  const route = {protocol: TRON_STAKE, name: TRON_STAKE, asset: {symbol: 'TRX', address: TRON_STAKE, decimals: 6, kind: 'crypto'}, kind: 'staking'} as unknown as EarnRoute;
  const pos = state ? ({formatted: trx(state.stakedSun)} as unknown as Position) : null;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      style={styles.container}
      contentContainerStyle={[styles.content, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
      contentInset={{top: headerHeight}}
      contentOffset={{x: 0, y: -headerHeight}}
      scrollIndicatorInsets={{top: headerHeight}}
      automaticallyAdjustContentInsets={false}
      refreshControl={
        <RefreshControl
          refreshing={pulled && loading}
          onRefresh={() => {
            setPulled(true);
            void load().finally(() => setPulled(false));
          }}
          tintColor={c.text}
          colors={[c.accent]}
        />
      }>
      <View style={styles.section}>
        <EarnTable title={t('vault.flexible_yield')}>
          <EarnRow
            first
            last
            row={{route, pos}}
            free={state ? trx(state.balanceSun) : null}
            amountKnown={!!state}
            earned={null}
            dust={false}
            queue={state ? {unstaking: trx(unstaking), claimable: trx(state.claimableSun)} : null}
            apy={null}
            energyRate={state?.energy.perTrxPerDay ?? null}
            protocolName={TRON_STAKE}
            onOpen={() => nav.navigate('TronStakeDetail')}
          />
        </EarnTable>
      </View>

      <View style={styles.section}>
        <EarnTable title={t('vault.flexible_lend')}>
          <Text style={styles.empty}>{t('mobile.earn.no_lend_markets')}</Text>
        </EarnTable>
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    content: {flexGrow: 1, padding: 16, gap: 20},
    section: {gap: 0},
    empty: {color: c.subtext, fontSize: 13, paddingTop: 12, paddingBottom: 4},
  });

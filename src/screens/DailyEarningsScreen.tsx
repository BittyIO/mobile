import React, {useState} from 'react';
import {RefreshControl, ScrollView, StyleSheet} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import {useColors, useStyles, type Colors} from '@/theme';
import {useNetwork} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useDailyEarnings} from '@/vault/daily-earnings';
import {DailyEarningsCard} from '@/components/DailyEarnings';
import type {RootStackParamList} from '@/App';

/**
 * One Earn position's earnings day by day, pushed from the calendar button on its detail page.
 *
 * A page of its own rather than a card at the foot of the detail: a year of days, as a month grid
 * or a list, is something to browse, and at the bottom of a long page it was below everything else.
 */
export function DailyEarningsScreen() {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {params} = useRoute<RouteProp<RootStackParamList, 'DailyEarnings'>>();
  const network = useNetwork((s) => s.network);
  const vault = useVaultBalances(network).vault;
  const [nonce, setNonce] = useState(0);
  const [pulled, setPulled] = useState(false);
  const daily = useDailyEarnings(vault, network, params.protocol, params.asset, nonce);

  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={pulled && daily.loading}
          onRefresh={() => {
            setPulled(true);
            setNonce((n) => n + 1);
          }}
          tintColor={c.text}
          colors={[c.accent]}
        />
      }>
      <DailyEarningsCard data={daily.data} error={daily.error} decimals={params.decimals} symbol={params.symbol} showTitle={false} />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    content: {padding: 16, paddingBottom: 32},
  });

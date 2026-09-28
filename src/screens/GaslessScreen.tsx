import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {GaslessCoins} from '@/components/GaslessCoins';
import {useStyles, type Colors} from '@/theme';

/** Settings › Vault › Gas: the fee coins, the daily and per-transaction limits, and today's usage. */
export function GaslessScreen() {
  const styles = useStyles(makeStyles);
  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <GaslessCoins />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, paddingBottom: 20},
  });

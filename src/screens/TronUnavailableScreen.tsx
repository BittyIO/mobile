import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {useNetwork} from '@/core/network-store';

/**
 * Earn and Trade with Tron picked: both run through the vault, and there is no vault on Tron mainnet
 * — only the phrase's wallet. And on Tron Nile, which has the vault but no protocol for it to use.
 * The tabs stay where they are so the bar does not change shape with the
 * chain; the page says why there is nothing here, and where the vault's chains are.
 */
export function TronUnavailableScreen({feature}: {feature: 'earn' | 'trade'}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const headerHeight = useTransparentHeaderInset();
  const tabBarHeight = useBottomTabBarHeight();
  // The Tron wallet's chain, or a vault network with no protocol on it (Tron Nile).
  const tron = useNetwork((s) => s.tron);
  const network = useNetwork((s) => s.network);
  const net = tron ?? network;
  return (
    <View style={[styles.container, {paddingTop: headerHeight, paddingBottom: tabBarHeight}]}>
      <NetworkIcon network={net} size={56} />
      <Text style={styles.title}>{t(feature === 'earn' ? 'mobile.tron.earn_unavailable' : 'mobile.tron.trade_unavailable')}</Text>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10},
    title: {color: c.text, fontSize: 20, fontWeight: '800', textAlign: 'center', marginTop: 8},
  });

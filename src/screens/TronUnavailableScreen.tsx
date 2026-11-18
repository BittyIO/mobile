import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {networkLabel, useNetwork} from '@/core/network-store';

/**
 * Earn and Trade on a vault network with no protocol registered for the vault to use. The tabs stay
 * where they are so the bar does not change shape with the chain; the page says why there is
 * nothing here.
 */
export function TronUnavailableScreen({feature}: {feature: 'earn' | 'trade' | 'bridge'}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const headerHeight = useTransparentHeaderInset();
  const tabBarHeight = useBottomTabBarHeight();
  // A vault network with no protocol on it.
  const net = useNetwork((s) => s.network);
  return (
    <View style={[styles.container, {paddingTop: headerHeight, paddingBottom: tabBarHeight}]}>
      <NetworkIcon network={net} size={56} />
      <Text style={styles.title}>
        {feature === 'bridge'
          ? t('mobile.bridge.unavailable_network', {network: networkLabel(net, t)})
          : t(feature === 'earn' ? 'mobile.tron.earn_unavailable' : 'mobile.tron.trade_unavailable')}
      </Text>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10},
    title: {color: c.text, fontSize: 20, fontWeight: '800', textAlign: 'center', marginTop: 8},
  });

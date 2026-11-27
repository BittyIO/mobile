import {useTransparentHeaderInset} from '@/components/header-inset';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {SendScreen} from '@/screens/SendScreen';
import {AccountSendScreen} from '@/screens/AccountSendScreen';
import {useNetwork} from '@/core/network-store';
import {useActiveAccount} from '@/core/account-mode';
import {useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {useStyles, type Colors} from '@/theme';

/**
 * Payment tab — the Send composer. The address book is kept on the Select Recipient page the
 * composer opens, where it is chosen from, added to and pruned; it has no panel of its own here.
 */
export function PaymentsScreen() {
  const headerHeight = useTransparentHeaderInset();
  const styles = useStyles(makeStyles);
  const anyone = !!useRoute<RouteProp<RootStackParamList, 'Payments'>>().params?.anyone;
  // The Tron smart wallet: the same page over the account (screens/AccountSendScreen).
  const smart = useActiveAccount(useNetwork((s) => s.network)).kind === 'account';
  return (
    <View style={[styles.container, {paddingTop: headerHeight}]}>
      {smart ? <AccountSendScreen anyone={anyone} /> : <SendScreen anyone={anyone} />}
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
});

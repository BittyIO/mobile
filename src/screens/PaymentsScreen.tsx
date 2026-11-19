import {useTransparentHeaderInset} from '@/components/header-inset';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {SendScreen} from '@/screens/SendScreen';
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
  return (
    <View style={[styles.container, {paddingTop: headerHeight}]}>
      <SendScreen anyone={anyone} />
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
});

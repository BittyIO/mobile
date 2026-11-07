import {useTransparentHeaderInset} from '@/components/header-inset';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {SendScreen} from '@/screens/SendScreen';
import {useStyles, type Colors} from '@/theme';

/**
 * Payment tab — the Send composer. The address book is kept on the Select Recipient page the
 * composer opens, where it is chosen from, added to and pruned; it has no panel of its own here.
 */
export function PaymentsScreen() {
  const headerHeight = useTransparentHeaderInset();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.container, {paddingTop: headerHeight}]}>
      <SendScreen />
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
});

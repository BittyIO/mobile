import {useHeaderHeight} from '@react-navigation/elements';
import React, {useMemo, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {CategoryTabs} from '@/components/ui';
import {SendScreen} from '@/screens/SendScreen';
import {ScheduledScreen} from '@/screens/ScheduledScreen';
import {WhitelistScreen} from '@/screens/WhitelistScreen';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

type Tab = 'send' | 'scheduled' | 'addressbook';

/** Payment tab — the Market's category row over the Send / Scheduled / Address Book panels. */
export function PaymentsScreen() {
  const headerHeight = useHeaderHeight();
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const [tab, setTab] = useState<Tab>('send');
  const tabs = useMemo<{key: Tab; label: string}[]>(
    () => [
      {key: 'send', label: t('vault.send')},
      {key: 'scheduled', label: t('vault.scheduled')},
      {key: 'addressbook', label: t('vault.address_book')},
    ],
    [t],
  );
  return (
    <View style={[styles.container, {paddingTop: headerHeight}]}>
      <View style={styles.tabs}>
        <CategoryTabs tabs={tabs} value={tab} onChange={setTab} />
      </View>
      <View style={styles.panel}>
        {tab === 'send' ? <SendScreen /> : tab === 'scheduled' ? <ScheduledScreen /> : <WhitelistScreen />}
      </View>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  // 16 here plus the row's own 4 puts the labels at 20, where the Market's sit.
  tabs: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2},
  panel: {flex: 1},
});

import {useHeaderHeight} from '@react-navigation/elements';
import React, {useMemo, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {UnderlineTabs} from '@/components/ui';
import {SendScreen} from '@/screens/SendScreen';
import {ScheduledScreen} from '@/screens/ScheduledScreen';
import {WhitelistScreen} from '@/screens/WhitelistScreen';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

type Tab = 'send' | 'scheduled' | 'addressbook';

/** Payment tab — web's underline sub-nav over the Send / Scheduled / Address Book panels. */
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
      <UnderlineTabs tabs={tabs} value={tab} onChange={setTab} />
      <View style={styles.panel}>
        {tab === 'send' ? <SendScreen /> : tab === 'scheduled' ? <ScheduledScreen /> : <WhitelistScreen />}
      </View>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  panel: {flex: 1},
});

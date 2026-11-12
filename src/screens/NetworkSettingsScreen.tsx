import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {NETWORKS, networkLabel, useNetwork, useNetworks} from '@/core/network-store';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import type {Network} from '@/core/chain';

/**
 * Settings › Network: this phone's view of the chains, the same for every vault and needing no
 * signature. First which networks the picker lists — all of them by default except the testnets,
 * which stay out of the way until turned on; then the way to the RPC nodes it reads each one from.
 */
export function NetworkSettingsScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const tron = useNetwork((s) => s.tron);
  const setShown = useNetwork((s) => s.setShown);
  // What the picker lists, by the store's own rule (unset = on, except a testnet): each switch shows it.
  const listed = new Set<Network>(useNetworks());

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.body} contentInsetAdjustmentBehavior="automatic">
      <SettingsGroup label={t('mobile.settings.show_networks')}>
        {NETWORKS.map((n, i) => (
          <SettingsRow
            key={n}
            icon="network"
            leading={<NetworkIcon network={n} size={29} />}
            title={networkLabel(n, t)}
            // The network in front stays listed: turning it off would leave the picker without it.
            toggle={{value: listed.has(n), onValueChange: (v) => setShown(n, v), disabled: n === network && !tron}}
            last={i === NETWORKS.length - 1}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow icon="network" title={t('mobile.rpc.title')} onPress={() => nav.navigate('RpcNodes')} last />
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
  });

import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {useAssetManagerRow} from '@/components/useAssetManagerRow';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Who else may act for the vault: the asset manager, and the payout operators.
 *
 * Its own page rather than a group on the Settings screen. The two rows are about the same
 * question — which addresses the owner has handed some of the vault to — and a section heading
 * with two rows under it reads as a leftover next to the Vault group that now holds everything
 * else. One row in Vault opens this, the way Allow list and Security do.
 *
 * The asset manager keeps its editor in place: the row opens a sheet with the address and expiry,
 * because appointing someone is a correction-prone thing to do and a pushed page would lose what
 * was typed on a back gesture. Payout operators is a list, so it pushes.
 */
export function TeamScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const manager = useAssetManagerRow();

  return (
    <ScrollView
      style={styles.flex}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      // A PUSHED screen: the header inset is the system's to apply, so this and nothing else.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.body}>
      <SettingsGroup>
        <SettingsRow
          icon="delegation"
          title={t('vault.asset_manager')}
          value={manager.value}
          sub={manager.sub}
          onPress={manager.onPress}
        />
        <SettingsRow icon="payout" title={t('vault.payout_operators')} onPress={() => nav.navigate('Delegation')} last />
      </SettingsGroup>
      {manager.sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
  });

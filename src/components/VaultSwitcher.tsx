import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useVaults, vaultLabel} from '@/core/vault-store';
import {useT} from '@/i18n';
import {useColors} from '@/theme';

/**
 * The vault in front, in every tab's left-hand corner, opening the Vaults page.
 *
 * Opposite the chain in the right-hand corner ({NetworkSwitcher}), because the two together say
 * whose money the page is showing: which vault, on which chain.
 *
 * The bar has no title, so the name may take most of its width; it is cut at its end, short of the
 * chain.
 */
export function VaultSwitcher({stack = false}: {stack?: boolean} = {}) {
  const {t} = useT();
  const c = useColors();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const current = useVaults((s) => s.vaults.find((v) => v.index === s.activeIndex) ?? s.vaults[0]);
  if (!current) return null;
  const label = vaultLabel(current, (n) => t('mobile.app.vault_n', {n}));
  return (
    <Pressable
      onPress={() => nav.navigate('VaultList')}
      style={stack ? styles.stack : styles.pill}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={`${t('mobile.settings.choose_vault')}: ${label}`}>
      <Text style={[styles.name, {color: c.text}]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Top left with Tron picked: there is no vault to switch to, only the phrase's Tron wallet. */
export function TronWalletLabel({stack = false}: {stack?: boolean} = {}) {
  const {t} = useT();
  const c = useColors();
  return (
    <View style={stack ? styles.stack : styles.pill}>
      <Text style={[styles.name, {color: c.text}]} numberOfLines={1}>
        {t('mobile.tron.wallet_title')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // The bar's own inset, on the side the control sits — the mirror of NetworkSwitcher's.
  pill: {marginLeft: 16, maxWidth: 260},
  // In the native bar (iOS, see App.tsx): the bar keeps its own inset, so none is added here.
  stack: {maxWidth: 260},
  name: {fontSize: 17, fontWeight: '700'},
});

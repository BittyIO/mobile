import React from 'react';
import {Pressable, StyleSheet} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {SettingsIcon} from '@/components/SettingsIcon';
import {LOCK_ICON, LOCK_TITLE} from '@/core/lock-status';
import {useVaultGate} from '@/vault/gate';
import {useT} from '@/i18n';

/**
 * After the tab header's title: the vault's lock, while it has one.
 *
 * A locked vault behaves differently everywhere — settings frozen, money only to the address book —
 * so the state is shown on every tab rather than only on the Security page, in the same icon the
 * Lock status row uses (orange for the temporary lock, red ∞ for the forever one). Tapping it opens
 * Lock status. Nothing at all while the vault is unlocked.
 *
 * Read on focus, when the app comes back, and when a relayed write lands (a lock or an unlock is one).
 */
export function LockBadge() {
  const {t} = useT();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // The shared gate (vault/gate) reads on the same occasions this badge used to read for itself.
  const level = useVaultGate().lockLevel ?? 0;

  if (level === 0) return null;
  return (
    <Pressable
      onPress={() => nav.navigate('VaultLock')}
      hitSlop={12}
      style={styles.badge}
      accessibilityRole="button"
      accessibilityLabel={t(LOCK_TITLE[level])}>
      <SettingsIcon name={LOCK_ICON[level]} size={18} round />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Sits after the title in the header's title row, which sets the gap.
  badge: {},
});

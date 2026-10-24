import React, {useCallback, useEffect, useState} from 'react';
import {AppState, Pressable, StyleSheet} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {SettingsIcon} from '@/components/SettingsIcon';
import {LOCK_ICON, LOCK_TITLE} from '@/core/lock-status';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {getLockLevel, type LockLevel} from '@/vault/risk';
import {usePending} from '@/vault/pending';
import {useT} from '@/i18n';

/**
 * The tab header's left corner: the vault's lock, while it has one.
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
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const [level, setLevel] = useState<LockLevel>(0);

  const read = useCallback(() => {
    if (!vault) return setLevel(0);
    getLockLevel(vault, network).then(setLevel);
  }, [vault, network]);
  useFocusEffect(read);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && read());
    return () => sub.remove();
  }, [read]);
  const settled = usePending((s) => s.txs.filter((x) => x.status !== 'pending').length);
  useEffect(read, [settled, read]);

  if (level === 0) return null;
  return (
    <Pressable
      onPress={() => nav.navigate('VaultLock')}
      hitSlop={12}
      style={styles.badge}
      accessibilityRole="button"
      accessibilityLabel={t(LOCK_TITLE[level])}>
      <SettingsIcon name={LOCK_ICON[level]} size={24} round />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The network switcher's mirror: the same 16 from the edge, at the other end of the bar.
  badge: {marginLeft: 16},
});

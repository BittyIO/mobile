import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getLockLevel, type LockLevel} from '@/vault/risk';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import type {LockAction} from '@/screens/VaultLockActionScreen';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {LOCK_ICON, LOCK_TITLE} from '@/core/lock-status';

/**
 * Vault lock (Security › Vault lock) — the vault's lock status on top, then only the moves open from
 * it: Unlock while emergency locked, Emergency lock while unlocked, Lock forever from either. Each
 * pushes its own page ({VaultLockActionScreen}) that says what will happen and confirms it there.
 * Once locked for ever nothing is offered — no key, ever, can move it again.
 *
 * The control the risk numbers exist to serve: they buy TIME, and this is what the time is for.
 * Both locks are instant, by the contract's own design — a queued lock is one the thief cancels.
 *
 * v1.0.0 only: the Security page leaves the row out on v1.0.3, which has no locks.
 */
export function VaultLockScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  // null while the read is out: nothing is offered until the level is known, because offering
  // "Emergency lock" to a vault that is already locked is a choice that can only fail.
  const [lockLevel, setLockLevel] = useState<LockLevel | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (vault) getLockLevel(vault, network).then(setLockLevel);
    }, [vault, network]),
  );

  const status = lockLevel == null ? undefined : t(LOCK_TITLE[lockLevel]);
  const statusHint =
    lockLevel === 2 ? 'mobile.vault.lock_forever_state' : lockLevel === 1 ? 'mobile.vault.lock_emergency_state' : 'mobile.vault.vault_lock_hint';

  const actions: {action: LockAction; title: string; hint: string}[] =
    lockLevel == null
      ? []
      : [
          ...(lockLevel === 1 ? [{action: 'unlock' as const, title: 'mobile.vault.unlock', hint: 'mobile.vault.unlock_hint'}] : []),
          ...(lockLevel === 0 ? [{action: 'emergency' as const, title: 'mobile.vault.emergency_lock', hint: 'mobile.vault.emergency_lock_hint'}] : []),
          ...(lockLevel !== 2 ? [{action: 'forever' as const, title: 'mobile.vault.forever_lock', hint: 'mobile.vault.forever_lock_hint'}] : []),
        ];

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup footer={lockLevel == null ? undefined : t(statusHint)}>
        <SettingsRow icon={LOCK_ICON[lockLevel ?? 0]} title={t('vault.status')} value={status} chevron={false} last />
      </SettingsGroup>
      {actions.length > 0 ? (
        <SettingsGroup>
          {actions.map((a, i) => (
            <SettingsRow
              key={a.action}
              // Each action wears the icon of the state it leads to.
              icon={LOCK_ICON[a.action === 'unlock' ? 0 : a.action === 'emergency' ? 1 : 2]}
              title={t(a.title)}
              sub={t(a.hint)}
              onPress={() => nav.navigate('VaultLockAction', {action: a.action})}
              last={i === actions.length - 1}
            />
          ))}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
  });

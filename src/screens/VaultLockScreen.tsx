import React, {useCallback, useEffect, useState} from 'react';
import {Alert, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {getLockLevel, emergencyLock, unlockVault, foreverLock, type LockLevel} from '@/vault/risk';
import {fetchEscapeIds, fetchWhitelist, type WhitelistedRecipient} from '@/vault/payments';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {Button} from '@/components/Button';
import {PickerSheet} from '@/components/AssetPicker';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useWallet} from '@/wallet/store';
import {shortAddress} from '@/core/format';
import {useRecipientNames, recipientName} from '@/core/recipient-names';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * Vault lock (Security › Vault lock) — the vault's current lock status on top, then the three
 * moves as buttons, each with what it does under it: Unlock (only while emergency locked),
 * Emergency lock (only while unlocked), and Lock forever. Once locked for ever every button is off
 * — no key, ever, can move it again.
 *
 * The control the risk numbers exist to serve: they buy TIME, and this is what the time is for.
 * Both locks are instant, by the contract's own design — a queued lock is one the thief cancels.
 *
 * v1.0.0 only: the Security page leaves the row out on v1.0.3, which has no locks.
 */
export function VaultLockScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  // null while the read is out: nothing is checked or pickable until the level is known, because
  // offering "Emergency lock" to a vault that is already locked is a choice that can only fail.
  const [lockLevel, setLockLevel] = useState<LockLevel | null>(null);

  const {vault, network, busy, ready, run, sheet} = useVaultWrite(() => load());
  const owner = useWallet((s) => s.address);
  const names = useRecipientNames((s) => s.names);
  /**
   * The whitelisted entries the forever lock may name as its way out, once asked for — the ones the
   * vault can pay right now. Null while closed. Read on the press rather than on focus: it is one
   * simulation per entry, and only this one choice needs it.
   */
  const [escapes, setEscapes] = useState<WhitelistedRecipient[] | null>(null);
  const [checking, setChecking] = useState(false);
  /**
   * The entry picked, held until the sheet has finished closing. The sheet's Modal stays up through
   * its close animation, and an alert raised while a modal is leaving can be dropped on iOS.
   */
  const [chosen, setChosen] = useState<WhitelistedRecipient | null>(null);

  const load = useCallback(() => {
    if (vault) getLockLevel(vault, network).then(setLockLevel);
  }, [vault, network]);
  useFocusEffect(load);

  /**
   * The forever lock takes a plain-words warning of its own BEFORE the Face-ID/fee sheet: it is the
   * one choice here no key can ever undo, and the ordinary confirm reads like every other one. The
   * emergency lock does not get this — it is reversible, and in the moment it exists for (a key
   * believed stolen) an extra dialog is time handed to the thief.
   */
  const confirmForever = (escape: WhitelistedRecipient) =>
    Alert.alert(t('mobile.vault.forever_lock'), t('mobile.vault.forever_lock_confirm'), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('mobile.vault.forever_lock'),
        style: 'destructive',
        onPress: () =>
          run(
            'lock-2',
            t('mobile.vault.forever_lock'),
            (base) => foreverLock({...base, escapeRecipientId: escape.id}),
            shortAddress(escape.recipientAddress),
          ),
      },
    ]);

  /**
   * The forever lock needs a way out, and the contract refuses it without one: once engaged nothing
   * can be added, so a whitelisted entry the vault can pay right now is the only route money ever
   * leaves by again. So the press first finds those entries. None, and it says what to do instead of
   * offering a lock that would fail; otherwise the owner picks the one to name.
   */
  const startForever = async () => {
    if (!vault || !owner) return;
    setChecking(true);
    try {
      const book = await fetchWhitelist(vault, network);
      const ok = new Set(await fetchEscapeIds(vault, owner as `0x${string}`, network, book.map((b) => b.id)));
      const usable = book.filter((b) => ok.has(b.id));
      if (usable.length === 0) {
        Alert.alert(t('mobile.vault.forever_lock'), t('mobile.vault.forever_lock_no_escape'));
        return;
      }
      setEscapes(usable);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (!chosen || escapes != null) return;
    const timer = setTimeout(() => {
      setChosen(null);
      confirmForever(chosen);
    }, 320); // past the sheet's longest close
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, escapes]);

  const pick = (to: LockLevel) => {
    if (lockLevel == null || to === lockLevel) return;
    if (to === 2) return startForever();
    if (to === 1) return run('lock-1', t('mobile.vault.emergency_lock'), emergencyLock);
    return run('lock-0', t('mobile.vault.unlock'), unlockVault);
  };

  const status =
    lockLevel == null
      ? undefined
      : t(lockLevel === 2 ? 'mobile.vault.locked_forever' : lockLevel === 1 ? 'mobile.vault.locked_emergency' : 'mobile.vault.unlocked');
  const statusHint =
    lockLevel === 2 ? 'mobile.vault.lock_forever_state' : lockLevel === 1 ? 'mobile.vault.lock_emergency_state' : 'mobile.vault.vault_lock_hint';

  // Each move is only offered from the state it leaves: unlock from an emergency lock, the
  // emergency lock from unlocked, the forever lock from either. An unknown level offers nothing.
  const known = ready && lockLevel != null;
  const actions: {level: LockLevel; title: string; hint: string; variant: 'secondary' | 'primary' | 'danger'; enabled: boolean}[] = [
    {level: 0, title: t('mobile.vault.unlock'), hint: t('mobile.vault.unlock_hint'), variant: 'secondary', enabled: known && lockLevel === 1},
    {level: 1, title: t('mobile.vault.emergency_lock'), hint: t('mobile.vault.emergency_lock_hint'), variant: 'primary', enabled: known && lockLevel === 0},
    {level: 2, title: t('mobile.vault.forever_lock'), hint: t('mobile.vault.forever_lock_hint'), variant: 'danger', enabled: known && lockLevel !== 2},
  ];

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup footer={lockLevel == null ? undefined : t(statusHint)}>
        <SettingsRow icon="lock" title={t('vault.status')} value={status} chevron={false} last />
      </SettingsGroup>
      {actions.map((a) => (
        <View key={a.level} style={styles.action}>
          <Button
            title={a.title}
            variant={a.variant}
            loading={busy === `lock-${a.level}` || (a.level === 2 && checking)}
            disabled={!a.enabled}
            onPress={() => pick(a.level)}
          />
          <Text style={styles.hint}>{a.hint}</Text>
        </View>
      ))}
      {/* Which whitelisted entry the money may still leave through. Only the ones the vault can pay
          right now are listed; picking one goes on to the plain-words warning. */}
      <PickerSheet
        visible={escapes != null}
        title={t('mobile.vault.forever_lock_escape_title')}
        items={(escapes ?? []).map((b) => {
          const named = recipientName(names, network, b.recipientAddress);
          return {key: b.id, label: named ?? shortAddress(b.recipientAddress), sub: named ? shortAddress(b.recipientAddress) : undefined};
        })}
        onSelect={(id) => setChosen(escapes?.find((b) => b.id === id) ?? null)}
        onClose={() => setEscapes(null)}
      />
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    action: {gap: 8},
    hint: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
  });

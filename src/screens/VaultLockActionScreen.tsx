import React, {useCallback, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {emergencyLock, foreverLock, getPendingChanges, getRiskConfig, unlockVault, type PendingChange} from '@/vault/risk';
import {fetchEscapeIds, fetchWhitelist, type WhitelistedRecipient} from '@/vault/payments';
import {OptionRow, SettingsGroup} from '@/components/SettingsRow';
import {PendingRow} from '@/components/PendingRow';
import {Button} from '@/components/Button';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useWallet} from '@/wallet/store';
import {useRecipientNames, recipientName} from '@/core/recipient-names';
import {pendingTitle, pendingValue} from '@/screens/PendingChangesScreen';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

export type LockAction = 'emergency' | 'unlock' | 'forever';

const TITLE: Record<LockAction, string> = {
  emergency: 'mobile.vault.emergency_lock',
  unlock: 'mobile.vault.unlock',
  forever: 'mobile.vault.forever_lock',
};

/** What the move does, point by point, as the contract does it (LockLib). */
const EFFECTS: Record<LockAction, string[]> = {
  emergency: ['lock_fx_instant', 'lock_fx_voids', 'lock_fx_frozen', 'lock_fx_payout', 'lock_fx_unlockable'],
  unlock: ['unlock_fx_normal', 'unlock_fx_no_revive', 'unlock_fx_timelock'],
  forever: ['forever_fx_permanent', 'lock_fx_voids', 'forever_fx_frozen', 'forever_fx_payout', 'forever_fx_fee'],
};

/**
 * Vault lock › one move — what will happen, then the button that does it.
 *
 * Both locks cancel every change still waiting out the timelock, so those are listed here, exactly
 * the ones that will go. The forever lock also names its way out: a whitelisted entry the vault can
 * pay right now, picked on this page, without which the contract refuses the lock. Unlock lists
 * nothing to cancel — a locked vault has nothing pending — and says what does not come back.
 *
 * The confirm goes through the Face-ID and fee sheet; back to the lock page once it is sent.
 */
export function VaultLockActionScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const {action} = useRoute<RouteProp<RootStackParamList, 'VaultLockAction'>>().params;
  const owner = useWallet((s) => s.address);
  const names = useRecipientNames((s) => s.names);
  const {vault, network, busy, ready, run, sheet} = useVaultWrite(() => nav.goBack());

  const [pending, setPending] = useState<PendingChange[] | null>(null);
  const [timelock, setTimelock] = useState(0);
  const [escapes, setEscapes] = useState<WhitelistedRecipient[] | null>(null);
  const [escape, setEscape] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!vault) return;
      if (action !== 'unlock') {
        getPendingChanges(vault, network).then(setPending).catch(() => setPending([]));
        getRiskConfig(vault, network).then((r) => setTimelock(Number(r.timelock)));
      }
      if (action === 'forever' && owner) {
        (async () => {
          const book = await fetchWhitelist(vault, network);
          const ok = new Set(await fetchEscapeIds(vault, owner as `0x${string}`, network, book));
          const usable = book.filter((b) => ok.has(b.id));
          setEscapes(usable);
          setEscape((cur) => cur ?? usable[0]?.id ?? null);
        })().catch(() => setEscapes([]));
      }
    }, [vault, network, action, owner]),
  );

  const now = Math.floor(Date.now() / 1000);
  const canConfirm = ready && (action !== 'forever' || escape != null);

  const confirm = () => {
    if (!canConfirm) return;
    if (action === 'emergency') return run('go', t(TITLE[action]), emergencyLock);
    if (action === 'unlock') return run('go', t(TITLE[action]), unlockVault);
    run('go', t(TITLE[action]), (b) => foreverLock({...b, escapeRecipientId: escape!}));
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup label={t('mobile.vault.lock_what_happens')}>
        <View style={styles.effects}>
          {EFFECTS[action].map((k) => (
            <View key={k} style={styles.effect}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.effectText}>{t(`mobile.vault.${k}`)}</Text>
            </View>
          ))}
        </View>
      </SettingsGroup>

      {action === 'unlock' ? null : (
        <SettingsGroup label={t('mobile.vault.lock_will_cancel')}>
          {pending == null ? (
            <View style={styles.pad}>
              <ActivityIndicator />
            </View>
          ) : pending.length === 0 ? (
            <Text style={[styles.pad, styles.empty]}>{t('mobile.vault.pending_none')}</Text>
          ) : (
            pending.map((p, i) => (
              <PendingRow
                key={`${p.kind}:${'address' in p ? p.address : ''}:${p.at}`}
                at={Number(p.at)}
                now={now}
                timelock={timelock}
                title={pendingTitle(p, t)}
                value={pendingValue(p, t)}
                last={i === pending.length - 1}
              />
            ))
          )}
        </SettingsGroup>
      )}

      {/* The forever lock's way out: one whitelisted entry the vault can pay right now. */}
      {action === 'forever' ? (
        <SettingsGroup label={t('mobile.vault.forever_lock_escape_title')}>
          {escapes == null ? (
            <View style={styles.pad}>
              <ActivityIndicator />
            </View>
          ) : escapes.length === 0 ? (
            <Text style={[styles.pad, styles.warn]}>{t('mobile.vault.forever_lock_no_escape')}</Text>
          ) : (
            escapes.map((b, i) => (
              <OptionRow
                key={b.id}
                title={recipientName(names, network, b.recipientAddress) ?? t('mobile.payments.recipient_n', {n: b.id})}
                sub={b.recipientAddress}
                checked={escape === b.id}
                onPress={() => setEscape(b.id)}
                last={i === escapes.length - 1}
              />
            ))
          )}
        </SettingsGroup>
      ) : null}

      <Button
        title={t(TITLE[action])}
        variant={action === 'unlock' ? 'primary' : 'danger'}
        onPress={confirm}
        loading={busy === 'go'}
        disabled={!canConfirm}
      />
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    effects: {padding: 16, gap: 10},
    effect: {flexDirection: 'row', gap: 8},
    bullet: {color: c.subtext, fontSize: 15, lineHeight: 21},
    effectText: {flex: 1, color: c.text, fontSize: 15, lineHeight: 21},
    pad: {padding: 16},
    empty: {color: c.subtext, fontSize: 15},
    warn: {color: c.danger, fontSize: 13, lineHeight: 18},
  });

import React, {useCallback, useEffect, useState} from 'react';
import {Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {isAddress, type Address} from 'viem';
import {publicClientFor} from '@/core/chain';
import {VAULT_OWNERSHIP_ABI} from '@/core/abi';
import {isPayableAddress} from '@/core/asset-catalog';
import {shortAddress} from '@/core/format';
import {getLockLevel, getPendingChanges, getRiskConfig} from '@/vault/risk';
import {cancelOwnershipTransfer, transferOwnership} from '@/vault/ownership';
import {Button} from '@/components/Button';
import {PendingRow} from '@/components/PendingRow';
import {SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useWallet} from '@/wallet/store';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * Security › Transfer ownership (v1.0.0) — hand the vault to another key.
 *
 * Who owns the vault now, then either the handover waiting out the vault's risk timelock (with its
 * ring and Cancel — it is queued like every other loosening and can be called off until it has run)
 * or the address field that starts one. What the handover means is said once, in the confirm.
 */
export function TransferOwnershipScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const [addr, setAddr] = useState('');
  const [owner, setOwner] = useState<Address | null>(null);
  const [timelock, setTimelock] = useState<bigint | null>(null);
  const [pending, setPending] = useState<{address: Address; at: number} | null>(null);
  const [locked, setLocked] = useState(false);
  const me = useWallet((s) => s.address);

  const {vault, network, busy, ready, run, sheet} = useVaultWrite(() => {
    setAddr('');
    load();
  });

  const load = useCallback(() => {
    if (!vault) return;
    return Promise.all([
      publicClientFor(network)
        .readContract({address: vault, abi: VAULT_OWNERSHIP_ABI, functionName: 'owner'})
        .then(setOwner)
        .catch(() => setOwner(null)),
      getRiskConfig(vault, network).then((r) => setTimelock(r.timelock)),
      getPendingChanges(vault, network).then((ps) => {
        const p = ps.find((x) => x.kind === 'newOwner');
        setPending(p && p.kind === 'newOwner' ? {address: p.address, at: Number(p.at)} : null);
      }),
      getLockLevel(vault, network).then((l) => setLocked(l !== 0)),
    ]);
  }, [vault, network]);
  useFocusEffect(useCallback(() => void load(), [load]));

  const [refreshing, setRefreshing] = useState(false);
  const onPull = () => {
    setRefreshing(true);
    Promise.resolve(load()).finally(() => setRefreshing(false));
  };

  // A clock for the pending ring, ticking while the page is up.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // Not the key in charge now, not the vault itself, not a token: each would strand the vault.
  const lc = addr.trim().toLowerCase();
  const valid =
    isAddress(addr.trim()) && isPayableAddress(addr.trim(), network) && lc !== owner?.toLowerCase() && lc !== vault?.toLowerCase();
  const bad = addr.trim().length > 0 && !valid;
  // Once a handover has run, this key is no longer the owner and the vault would refuse it anything.
  const isOwner = !!owner && owner.toLowerCase() === me?.toLowerCase();
  const canTransfer = ready && valid && !locked && !pending && isOwner;

  const transfer = () =>
    canTransfer &&
    run(
      'transfer',
      t('mobile.vault.transfer_ownership'),
      (b) => transferOwnership({...b, newOwner: addr.trim() as Address}),
      `${shortAddress(addr.trim())}\n\n${t('mobile.vault.transfer_ownership_confirm')}`,
    );

  const cancel = () => run('cancel', t('mobile.vault.cancel_transfer'), (b) => cancelOwnershipTransfer(b), pending?.address);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}>
      <Pressable accessible={false} onPress={Keyboard.dismiss} style={styles.section}>
        <SettingsGroup>
          <SettingsRow icon="ownership" title={t('mobile.vault.current_owner')} value={owner ? shortAddress(owner) : undefined} chevron={false} last />
        </SettingsGroup>

        {pending ? (
          <SettingsGroup label={t('mobile.vault.pending_changes')}>
            <PendingRow
              at={pending.at}
              now={now}
              timelock={Number(timelock ?? 0)}
              title={t('mobile.vault.pending_new_owner')}
              value={pending.address}
              onCancel={cancel}
              cancelling={busy === 'cancel'}
              cancelDisabled={!ready}
              last
            />
          </SettingsGroup>
        ) : (
          <>
            <View style={styles.group}>
              <TextInput
                style={[styles.input, bad && styles.inputBad]}
                placeholder={t('mobile.vault.new_owner_address')}
                placeholderTextColor={c.subtext}
                autoCapitalize="none"
                autoCorrect={false}
                value={addr}
                onChangeText={setAddr}
              />
            </View>
            {bad ? <Text style={styles.err}>{t('mobile.vault.transfer_bad_address')}</Text> : null}
            {locked ? <Text style={styles.err}>{t('mobile.vault.transfer_locked')}</Text> : null}
            <Button title={t('mobile.vault.transfer_button')} onPress={transfer} loading={busy === 'transfer'} disabled={!canTransfer} style={styles.btn} />
          </>
        )}
      </Pressable>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    section: {flex: 1, gap: 16},
    group: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    input: {minHeight: 52, paddingHorizontal: 16, paddingVertical: 14, color: c.text, fontSize: 15},
    inputBad: {color: c.danger},
    err: {color: c.danger, fontSize: 12, lineHeight: 17, paddingHorizontal: 16},
    btn: {marginTop: 4},
  });

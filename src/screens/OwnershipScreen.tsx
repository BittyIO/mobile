import {displayAddress, parseAddress} from '@/core/address';
import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import Svg, {Circle, Path} from 'react-native-svg';
import {isAddress, type Address} from 'viem';
import {publicClientFor} from '@/core/chain';
import {VAULT_OWNERSHIP_ABI} from '@/core/abi';
import {isPayableAddress} from '@/core/asset-catalog';
import {shortAddress, asShown} from '@/core/format';
import {getLockLevel, getPendingChanges, getRiskConfig} from '@/vault/risk';
import {cancelOwnershipTransfer, transferOwnership} from '@/vault/ownership';
import {Button, ConfirmButton} from '@/components/Button';
import {PendingRow} from '@/components/PendingRow';
import {QuantumInfoButton, QuantumKeys} from '@/components/QuantumHandover';
import {SettingsGroup} from '@/components/SettingsRow';
import {Sheet} from '@/components/Sheet';
import {showToast} from '@/components/Toast';
import {useVaultWrite} from '@/components/useVaultWrite';
import {relayGasFor} from '@/vault/fee-quote';
import {useWallet} from '@/wallet/store';
import {isOwnKey} from '@/wallet/rotation';
import {keyPathOf} from '@/wallet/rotation-store';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors, MONO} from '@/theme';

/**
 * Security › Ownership — who controls the vault, and handing it to another key.
 *
 * The owner's full address (an address is told apart from another by its middle, so it is never
 * shortened here; a long press copies it), an ⓘ saying what being the owner means, then either the
 * handover waiting out the vault's risk timelock (with its ring and Cancel — it is queued like every
 * other loosening and can be called off until it has run) or the button that opens the sheet to
 * start one. That sheet is its own confirm: the warning, the estimated fee and the Face ID button.
 */
export function OwnershipScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  // undefined while loading, null when it could not be read.
  const [owner, setOwner] = useState<Address | null | undefined>(undefined);
  const [timelock, setTimelock] = useState<bigint | null>(null);
  const [pending, setPending] = useState<{address: Address; at: number} | null>(null);
  const [locked, setLocked] = useState(false);
  const [info, setInfo] = useState(false);
  const [form, setForm] = useState(false);
  const [addr, setAddr] = useState('');
  const me = useWallet((s) => s.address);

  const {vault, network, busy, ready, run, runConfirmed, sheet} = useVaultWrite(() => {
    setAddr('');
    load();
  });

  const load = useCallback(() => {
    if (!vault) return Promise.resolve();
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
    ]).then(() => undefined);
  }, [vault, network]);
  useFocusEffect(useCallback(() => void load(), [load]));

  const [refreshing, setRefreshing] = useState(false);
  const onPull = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };

  // A clock for the pending ring, ticking while the page is up.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const copyOwner = () => {
    if (!owner) return;
    Clipboard.setString(displayAddress(network, owner));
    showToast('success', t('common.copied'), shortAddress(owner));
  };

  // Not the key in charge now, not the vault itself, not a token: each would strand the vault.
  const parsed = parseAddress(network, addr);
  const lc = parsed?.toLowerCase() ?? '';
  const valid = !!parsed && isPayableAddress(addr.trim(), network) && lc !== owner?.toLowerCase() && lc !== vault?.toLowerCase();
  const bad = addr.trim().length > 0 && !valid;
  // Once a handover has run, this key is no longer the owner and the vault would refuse it anything.
  // On quantum-safe keys the owner is one of this phrase's one-time keys, and still this phone's.
  const isOwner = isOwnKey(owner ?? null, me);
  const canTransfer = ready && valid && !locked && !pending && isOwner;

  // The sheet IS the confirm: the warning, the estimated fee and the Face ID button are on it, so
  // pressing that button sends the handover with no second sheet in between.
  const transfer = () => {
    if (!canTransfer) return;
    const to = parseAddress(network, addr) as Address;
    setForm(false);
    runConfirmed('transfer', t('mobile.vault.transfer_ownership'), (b) => transferOwnership({...b, newOwner: to}));
  };

  const cancel = () => run('cancel', t('mobile.vault.cancel_transfer'), (b) => cancelOwnershipTransfer(b), pending?.address);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}>
      <View style={styles.card}>
        <View style={styles.labelRow}>
          <Text style={styles.label}>{t('mobile.vault.current_owner')}</Text>
          <Pressable onPress={() => setInfo(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('mobile.vault.ownership_info_title')}>
            <Svg width={17} height={17} viewBox="0 0 24 24">
              <Circle cx={12} cy={12} r={10} stroke={c.subtext} strokeWidth={2} fill="none" />
              <Path d="M12 16v-4M12 8h.01" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" />
            </Svg>
          </Pressable>
        </View>
        {owner ? (
          <Pressable onLongPress={copyOwner} accessibilityHint={t('common.copied')}>
            {({pressed}) => <Text style={[styles.address, pressed && styles.addressPressed]}>{owner}</Text>}
          </Pressable>
        ) : owner === undefined ? (
          <ActivityIndicator color={c.subtext} style={styles.loading} />
        ) : (
          <Text style={styles.missing}>—</Text>
        )}
      </View>

      {pending ? (
        <SettingsGroup label={t('mobile.vault.pending_changes')}>
          <PendingRow
            at={pending.at}
            now={now}
            timelock={Number(timelock ?? 0)}
            title={t(keyPathOf(pending.address) ? 'mobile.quantum.pending_title' : 'mobile.vault.pending_new_owner')}
            value={asShown(pending.address)}
            titleRight={keyPathOf(pending.address) ? <QuantumInfoButton /> : undefined}
            detail={keyPathOf(pending.address) ? <QuantumKeys to={pending.address} /> : undefined}
            onCancel={cancel}
            cancelling={busy === 'cancel'}
            cancelDisabled={!ready}
            onMatured={() => void load()}
            last
          />
        </SettingsGroup>
      ) : (
        <Button
          title={t('mobile.vault.transfer_ownership')}
          onPress={() => setForm(true)}
          loading={busy === 'transfer'}
          disabled={!ready || !isOwner}
          locked={locked}
        />
      )}

      <Sheet visible={info} title={t('mobile.vault.ownership_info_title')} onClose={() => setInfo(false)}>
        <View style={styles.sheetBody}>
          <Text style={styles.explainText}>{t('mobile.vault.ownership_info')}</Text>
        </View>
      </Sheet>

      <Sheet visible={form} title={t('mobile.vault.transfer_ownership')} onClose={() => setForm(false)}>
        <View style={styles.sheetBody}>
          <TextInput
            style={[styles.input, bad && styles.inputBad]}
            placeholder={t('mobile.vault.new_owner_address')}
            placeholderTextColor={c.subtext}
            autoCapitalize="none"
            autoCorrect={false}
            value={addr}
            onChangeText={setAddr}
          />
          {bad ? <Text style={styles.err}>{t('mobile.vault.transfer_bad_address')}</Text> : null}
          <Text style={styles.warn}>{t('mobile.vault.transfer_ownership_confirm')}</Text>
          <ConfirmButton onPress={transfer} gas={relayGasFor({})} disabled={!canTransfer} />
        </View>
      </Sheet>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 10},
    labelRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
    label: {color: c.subtext, fontSize: 13, fontWeight: '600'},
    address: {color: c.text, fontSize: 15, lineHeight: 22, fontFamily: MONO},
    addressPressed: {opacity: 0.5},
    loading: {alignSelf: 'flex-start', paddingVertical: 2},
    missing: {color: c.subtext, fontSize: 15},
    sheetBody: {paddingTop: 4, paddingBottom: 24, gap: 14},
    explainText: {color: c.text, fontSize: 15, lineHeight: 22},
    input: {minHeight: 52, paddingHorizontal: 16, paddingVertical: 14, color: c.text, fontSize: 15, backgroundColor: c.cardAlt, borderRadius: 14},
    inputBad: {color: c.danger},
    err: {color: c.danger, fontSize: 12, lineHeight: 17, paddingHorizontal: 4},
    warn: {color: c.subtext, fontSize: 14, lineHeight: 20, paddingHorizontal: 4},
  });

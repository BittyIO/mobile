import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Alert, Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {getAddress, isAddress, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {Button} from '@/components/Button';
import {SecretKeyInput} from '@/components/SecretKeyInput';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {showToast} from '@/components/Toast';
import {networkLabel, useNetwork} from '@/core/network-store';
import {publicClientFor} from '@/core/chain';
import {
  applyOwnerChange,
  checkOwnerChange,
  describeOwnerChange,
  executeOwnerChange,
  OwnerChangeError,
  ownersOnPhone,
  pendingOwnerChanges,
  readSafeState,
  signOwnerChange,
  type OwnerChange,
  type OwnerChangeResult,
  type SafeState,
} from '@/vault/safe-owners';
import type {SafeMessageStatus} from '@/vault/safe';
import * as keyring from '@/wallet/keyring';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors, MONO} from '@/theme';

/** An address shortened to its first and last six: 0x111111…000000. */
const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/**
 * Multisig vaults › Owners and threshold: the multisig's owners as the chain has them now, and the
 * three changes a Safe makes to itself — add an owner, remove one, change how many must sign.
 *
 * A change is signed by the owners' keys imported on this phone (Face ID for each). With `threshold`
 * of them it runs at once, sent by one of them, which pays the network fee (vault/safe-owners). With
 * fewer it is filed: every owner sees it on this same page on their own phone, under "Waiting for
 * signatures", signs it there, and the one whose signature completes it sends it.
 */
export function ManageMultisigScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {safe, payer} = useRoute<RouteProp<RootStackParamList, 'ManageMultisig'>>().params;
  const network = useNetwork((s) => s.network);

  const [state, setState] = useState<SafeState | null>(null);
  const [pending, setPending] = useState<SafeMessageStatus[]>([]);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pulled, setPulled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keys imported on this page change who can sign: bumped after each import to count them again.
  const [, setKeysSeen] = useState(0);

  const [ownerDraft, setOwnerDraft] = useState('');
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [addThreshold, setAddThreshold] = useState(1);
  const [newThreshold, setNewThreshold] = useState(1);

  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const scroll = useRef<ScrollView>(null);
  const reveal = () => setTimeout(() => scroll.current?.scrollToEnd({animated: true}), 300);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const code = await publicClientFor(network).getCode({address: safe});
      if (!code || code === '0x') {
        setMissing(true);
        setState(null);
        return;
      }
      setMissing(false);
      const [s, waiting] = await Promise.all([readSafeState(network, safe), pendingOwnerChanges(network, safe).catch(() => [])]);
      setState(s);
      setPending(waiting);
      setAddThreshold(s.threshold);
      setNewThreshold(s.threshold);
    } catch (e) {
      setLoadError(String((e as Error)?.message ?? e));
    }
  }, [network, safe]);
  useEffect(() => {
    load();
  }, [load]);

  const onPhone = state ? ownersOnPhone(state.owners) : [];
  // One owner key here starts a change; the threshold is met with the other owners' phones.
  const canSign = !!state && onPhone.length > 0;
  const alone = !!state && onPhone.length >= state.threshold;
  const net = networkLabel(network, t);

  const explain = (e: unknown): string => {
    if (e instanceof OwnerChangeError) {
      if (e.reason === 'not-enough-keys') return t('mobile.safemode.needs_keys', {need: e.need, have: e.have});
      if (e.reason === 'already-owner') return t('mobile.safe.owner_duplicate');
      if (e.reason === 'last-owner') return t('mobile.safemode.last_owner');
      return t('mobile.safemode.bad_threshold');
    }
    return String((e as Error)?.message ?? e);
  };

  /** Confirm, then sign on this phone and send. `summary` is what the change does, in a sentence. */
  const run = (change: OwnerChange, title: string, summary: string, after?: () => void) => {
    if (!state) return;
    setError(null);
    try {
      checkOwnerChange(state, change);
    } catch (e) {
      return setError(explain(e));
    }
    Keyboard.dismiss();
    const sender = payer && onPhone.some((a) => a.toLowerCase() === payer.toLowerCase()) ? payer : onPhone[0];
    const how = alone
      ? t('mobile.safemode.confirm_body', {n: state.threshold, payer: shortAddr(sender), network: net})
      : t('mobile.safemode.confirm_file', {have: onPhone.length, need: state.threshold});
    Alert.alert(title, `${summary}\n\n${how}`, [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('mobile.safemode.confirm_button'),
        onPress: async () => {
          setBusy(true);
          try {
            const result = await applyOwnerChange({network, safe, change, payer: sender});
            if (!result) return;
            report(result);
            after?.();
            await load();
          } catch (e) {
            setError(explain(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const report = (r: OwnerChangeResult) =>
    r.kind === 'done'
      ? showToast('success', t('mobile.safemode.updated'))
      : showToast('success', t('mobile.safemode.filed', {have: r.status.signers.length, need: r.status.threshold}));

  /** Sign a filed change here (and send it, if that completes it), or send one already complete. */
  const onPending = async (m: SafeMessageStatus) => {
    setError(null);
    setBusy(true);
    try {
      const r = m.ready ? await executeOwnerChange({network, status: m, payer}) : await signOwnerChange({network, status: m, payer});
      if (!r) return;
      report(r);
      await load();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  /** What a filed change does, in a line. */
  const describe = (m: SafeMessageStatus) => {
    const ch = describeOwnerChange(m);
    if (!ch || !state) return '';
    const total = ch.kind === 'add' ? state.owners.length + 1 : ch.kind === 'remove' ? state.owners.length - 1 : state.owners.length;
    if (ch.kind === 'add') return t('mobile.safemode.add_summary', {address: shortAddr(ch.owner), n: ch.threshold, total});
    if (ch.kind === 'remove') return t('mobile.safemode.remove_owner_summary', {address: shortAddr(ch.owner), n: ch.threshold, total});
    return t('mobile.safe.threshold_of', {n: ch.threshold, total});
  };

  const onAddOwner = (raw = ownerDraft) => {
    const a = raw.trim();
    if (!isAddress(a)) return setOwnerError(t('mobile.safe.owner_invalid'));
    if (!state) return;
    const owner = getAddress(a);
    if (state.owners.some((o) => o.toLowerCase() === owner.toLowerCase())) return setOwnerError(t('mobile.safe.owner_duplicate'));
    setOwnerError(null);
    run(
      {kind: 'add', owner, threshold: addThreshold},
      t('mobile.safemode.add_title'),
      t('mobile.safemode.add_summary', {address: shortAddr(owner), n: addThreshold, total: state.owners.length + 1}),
      () => setOwnerDraft(''),
    );
  };

  const onRemove = (owner: Address) => {
    if (!state) return;
    const total = state.owners.length - 1;
    const threshold = Math.max(1, Math.min(state.threshold, total));
    run(
      {kind: 'remove', owner, threshold},
      t('mobile.safemode.remove_owner_title'),
      t('mobile.safemode.remove_owner_summary', {address: shortAddr(owner), n: threshold, total}),
    );
  };

  const onThreshold = () => {
    if (!state || newThreshold === state.threshold) return;
    run(
      {kind: 'threshold', threshold: newThreshold},
      t('mobile.safemode.threshold_title'),
      t('mobile.safe.threshold_of', {n: newThreshold, total: state.owners.length}),
    );
  };

  const onImportKey = async () => {
    setKeyError(null);
    const pk = keyring.parsePrivateKey(keyDraft);
    if (!pk) return setKeyError(t('mobile.safe.invalid_key'));
    try {
      const address = await keyring.importPrivateKey(pk);
      Keyboard.dismiss();
      setKeyDraft('');
      setImporting(false);
      setKeysSeen((n) => n + 1);
      if (state && !state.owners.some((o) => o.toLowerCase() === address.toLowerCase())) setKeyError(t('mobile.safemode.key_not_owner', {address: shortAddr(address)}));
    } catch (e) {
      setKeyError(String((e as Error)?.message ?? e));
    }
  };

  /** One chip per threshold from 1 to `total`. */
  const chips = (total: number, value: number, set: (n: number) => void) => (
    <View style={styles.chips}>
      {Array.from({length: total}, (_, i) => i + 1).map((n) => {
        const on = n === value;
        return (
          <Pressable
            key={n}
            style={({pressed}) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
            onPress={() => set(n)}
            accessibilityRole="radio"
            accessibilityState={{checked: on}}>
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{`${n}/${total}`}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (missing)
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.hint}>{t('mobile.safemode.not_here', {network: net})}</Text>
      </View>
    );
  if (!state)
    return (
      <View style={[styles.container, styles.center]}>
        {loadError ? (
          <>
            <Text style={styles.err}>{loadError}</Text>
            <Pressable onPress={load} hitSlop={8}>
              <Text style={styles.link}>{t('vault.retry')}</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={c.subtext} />
        )}
      </View>
    );

  return (
    <ScrollView
      ref={scroll}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={async () => {
            setPulled(true);
            await load();
            setPulled(false);
          }}
          tintColor={c.text}
        />
      }>
      {/* The multisig and its rule, as the chain has them now. Long press to copy the address. */}
      <View style={styles.card}>
        <Pressable onLongPress={() => Clipboard.setString(safe)}>
          <Text style={styles.addr} selectable>
            {safe}
          </Text>
        </Pressable>
        <Text style={styles.big}>{t('mobile.safe.threshold_of', {n: state.threshold, total: state.owners.length})}</Text>
      </View>

      {!canSign ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{t('mobile.safemode.no_key')}</Text>
        </View>
      ) : !alone ? (
        <Text style={styles.hint}>{t('mobile.safemode.cosign_note', {have: onPhone.length, need: state.threshold})}</Text>
      ) : null}
      {error ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}

      {/* Filed changes: signed by some owners, waiting for the rest — on whichever phone they are. */}
      {pending.length > 0 ? (
        <SettingsGroup label={t('mobile.safemode.waiting')}>
          {pending.map((m, i) => {
            const signedHere = m.signers.some((a) => onPhone.some((k) => k.toLowerCase() === a.toLowerCase()));
            const canAdd = onPhone.some((k) => !m.signers.some((a) => a.toLowerCase() === k.toLowerCase()));
            return (
              <View key={m.messageHash} style={[styles.pendingRow, i < pending.length - 1 && styles.rowDivider]}>
                <Text style={styles.pendingText}>{describe(m)}</Text>
                <Text style={styles.hint}>
                  {t('mobile.safe.signed', {have: m.signers.length, need: m.threshold})}
                  {signedHere ? ` · ${t('mobile.safe.you_signed')}` : ''}
                </Text>
                {m.ready || canAdd ? (
                  <Button
                    title={m.ready ? t('mobile.safemode.execute') : t('mobile.safe.sign')}
                    onPress={() => onPending(m)}
                    loading={busy}
                    disabled={busy}
                  />
                ) : (
                  <Text style={styles.hint}>{t('mobile.safe.waiting')}</Text>
                )}
              </View>
            );
          })}
        </SettingsGroup>
      ) : null}

      <SettingsGroup label={t('mobile.safemode.owners')}>
        {state.owners.map((o, i) => {
          const here = onPhone.some((a) => a.toLowerCase() === o.toLowerCase());
          return (
            <View key={o} style={[styles.ownerRow, i < state.owners.length - 1 && styles.rowDivider]}>
              <Pressable style={styles.ownerText} onLongPress={() => Clipboard.setString(o)}>
                <Text style={styles.ownerAddr}>{shortAddr(o)}</Text>
                {here ? <Text style={styles.badge}>{t('mobile.safemode.on_phone')}</Text> : null}
              </Pressable>
              {state.owners.length > 1 ? (
                <Pressable onPress={() => onRemove(o)} disabled={busy || !canSign} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('vault.remove')}>
                  <Text style={[styles.remove, (busy || !canSign) && styles.off]}>{t('vault.remove')}</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </SettingsGroup>

      {/* Add an owner, and how many must sign once it is added. */}
      <View style={styles.card}>
        <Text style={styles.title}>{t('mobile.safemode.add_title')}</Text>
        <View style={[styles.inputWrap, !!ownerError && styles.inputError]}>
          <TextInput
            style={styles.input}
            value={ownerDraft}
            onChangeText={(v) => {
              setOwnerDraft(v);
              setOwnerError(null);
            }}
            placeholder={t('mobile.safe.other_owner')}
            placeholderTextColor={c.subtext}
            onFocus={reveal}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
          {!ownerDraft ? (
            <Pressable style={({pressed}) => [styles.pill, pressed && styles.pressed]} onPress={async () => setOwnerDraft((await Clipboard.getString()).trim())} hitSlop={6}>
              <Text style={styles.pillText}>{t('mobile.safe.paste')}</Text>
            </Pressable>
          ) : null}
        </View>
        {ownerError ? <Text style={styles.err}>{ownerError}</Text> : null}
        <Text style={styles.hint}>{t('mobile.safe.threshold')}</Text>
        {chips(state.owners.length + 1, addThreshold, setAddThreshold)}
        <Button title={t('mobile.safemode.add_button')} onPress={() => onAddOwner()} loading={busy} disabled={busy || !canSign || !ownerDraft.trim()} />
      </View>

      {/* Change how many must sign, owners unchanged. */}
      <View style={styles.card}>
        <Text style={styles.title}>{t('mobile.safemode.threshold_title')}</Text>
        {chips(state.owners.length, newThreshold, setNewThreshold)}
        <Button
          title={t('mobile.safemode.threshold_button', {n: newThreshold, total: state.owners.length})}
          onPress={onThreshold}
          loading={busy}
          disabled={busy || !canSign || newThreshold === state.threshold}
        />
      </View>

      {/* Another owner's key, to sign with it here. */}
      <View style={styles.card}>
        {importing ? (
          <>
            <SecretKeyInput
              value={keyDraft}
              onChangeText={(v) => {
                setKeyDraft(v);
                setKeyError(null);
              }}
              onFocus={reveal}
              onSubmit={onImportKey}
              error={!!keyError}
            />
            <Button title={t('mobile.safe.import')} onPress={onImportKey} disabled={!keyDraft.trim()} />
          </>
        ) : (
          <Pressable onPress={() => setImporting(true)} hitSlop={6}>
            <Text style={styles.link}>{`＋ ${t('mobile.safemode.import_owner_key')}`}</Text>
          </Pressable>
        )}
        {keyError ? <Text style={styles.err}>{keyError}</Text> : null}
        <Text style={styles.hint}>{t('mobile.safe.step_key_footer')}</Text>
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    center: {alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12},
    body: {padding: 16, gap: 20, paddingBottom: 40},
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 12},
    title: {color: c.text, fontSize: 17, fontWeight: '600'},
    big: {color: c.text, fontSize: 16, fontWeight: '600'},
    addr: {color: c.subtext, fontSize: 13, fontFamily: MONO},
    pendingRow: {paddingVertical: 12, paddingHorizontal: 16, gap: 8},
    pendingText: {color: c.text, fontSize: 14, lineHeight: 20},
    ownerRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 52},
    ownerText: {flex: 1, gap: 3},
    ownerAddr: {color: c.text, fontSize: 14, fontFamily: MONO},
    badge: {color: c.success, fontSize: 12, fontWeight: '600'},
    remove: {color: c.danger, fontSize: 14, fontWeight: '600'},
    off: {opacity: 0.4},
    inputWrap: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.input, borderRadius: 14, paddingLeft: 14, paddingRight: 6, minHeight: 52, borderWidth: 1.5, borderColor: 'transparent'},
    inputError: {borderColor: c.danger},
    input: {flex: 1, color: c.text, fontSize: 13, fontFamily: MONO, paddingVertical: 14},
    pill: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: c.accentSoft},
    pillText: {color: c.accent, fontSize: 13, fontWeight: '600'},
    chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
    chip: {minWidth: 64, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, backgroundColor: c.input, borderWidth: 1.5, borderColor: 'transparent', alignItems: 'center'},
    chipOn: {borderColor: c.accent, backgroundColor: c.accentSoft},
    chipText: {color: c.text, fontSize: 16, fontWeight: '600'},
    chipTextOn: {color: c.accent},
    hint: {color: c.subtext, fontSize: 12, lineHeight: 17},
    err: {color: c.danger, fontSize: 13, lineHeight: 18},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
    banner: {padding: 14, borderRadius: 14, backgroundColor: c.dangerSoft},
    bannerText: {color: c.danger, fontSize: 14, lineHeight: 20},
    pressed: {opacity: 0.6},
  });

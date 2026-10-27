import React, {useEffect, useState} from 'react';
import {Alert, Keyboard, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {isPayableAddress, isTokenAddress} from '@/core/asset-catalog';
import {useNetwork} from '@/core/network-store';
import {useWallet} from '@/wallet/store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {getRiskConfig, type RiskConfig} from '@/vault/risk';
import {fmtAllowance, fmtDuration} from '@/components/riskFormat';
import {useRecipientNames} from '@/core/recipient-names';
import {useRecipientPick} from '@/core/recipient-pick';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {useVaultWrite} from '@/components/useVaultWrite';
import {addWhitelisted, fetchWhitelist, type WhitelistedRecipient} from '@/vault/payments';
import {WHITELIST_STATUS} from '@/core/abi';
import {GateHint, LockIcon, useLockLevel} from '@/components/LockNotice';
import {useCapability} from '@/vault/gate';

/**
 * Select recipient › New recipient — an address to type, a name for it on this device, and whether
 * it goes into the whitelist with the payment. The most the payment can be follows that choice: a
 * whitelisted address has no cap, any other is held to the vault's daily send allowance.
 *
 * Confirming hands the address back through {useRecipientPick} and unwinds past the picker straight
 * to the Send card, which is where the choice is used.
 */
/**
 * Security › Whitelisted addresses › + — the same form, without the payment: the address always goes
 * into the book, through the Face-ID and fee confirm, and the page closes once it is submitted.
 */
export function AddWhitelistedScreen() {
  return <NewRecipientScreen manage />;
}

export function NewRecipientScreen({manage = false}: {manage?: boolean}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = useActiveVaultAddress(network);
  const setPicked = useRecipientPick((st) => st.set);
  const setName = useRecipientNames((st) => st.setName);

  const [draft, setDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  // On by default: a vault with new-payment protection refuses an address it has never seen, and
  // the usual reason to type one is to keep using it. Off is a one-off payment that leaves no entry.
  const [addToBook, setAddToBook] = useState(true);
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  useEffect(() => {
    if (vault) getRiskConfig(vault, network).then(setRisk);
  }, [vault, network]);
  // With sends to new addresses off, a typed address can be paid only if it is already in the book
  // and past its wait — so the book is read to tell.
  const sendsOff = !manage && !!risk?.read && risk.sendDailyAllowance === 0n;
  // Locked, the same holds — the vault pays only the book — and nothing can be added to it.
  const sendGate = useCapability('send');
  const addGate = useCapability('addWhitelistedRecipient');
  const lockLevel = useLockLevel();
  const lockedSends = !manage && !sendGate.allowed && sendGate.reason !== 'send_allowance_off';
  const bookOnly = sendsOff || lockedSends;
  // The lock refuses what this page does: adding to the book, or paying a new address.
  const lockedHere = lockLevel > 0 && (manage ? !addGate.allowed : lockedSends);
  const [book, setBook] = useState<WhitelistedRecipient[]>([]);
  useEffect(() => {
    if (bookOnly && vault) fetchWhitelist(vault, network).then(setBook).catch(() => setBook([]));
  }, [bookOnly, vault, network]);

  const valid = isPayableAddress(draft, network);
  const isToken = isTokenAddress(draft, network);
  const max = addToBook
    ? t('mobile.payments.max_send_none')
    : risk
      ? t('mobile.payments.max_send_daily', {value: fmtAllowance(risk.sendDailyAllowance, t)})
      : '…';

  const write = useVaultWrite(() => nav.goBack());
  const confirm = () => {
    const given = nameDraft.trim();
    if (given) setName(network, draft, given);
    if (manage) {
      write.run('add', `${t('vault.add')} · ${t('vault.address_book')}`, (base) =>
        addWhitelisted({...base, recipient: draft as Address}),
      );
      return;
    }
    const payable = book.some(
      (b) =>
        b.recipientAddress.toLowerCase() === draft.toLowerCase() &&
        (b.status === undefined || b.status === WHITELIST_STATUS.payable || b.status === WHITELIST_STATUS.removalQueued),
    );
    if (bookOnly && !payable) {
      Alert.alert(
        t('mobile.payments.cant_pay_title'),
        t(lockedSends ? 'mobile.vault.lock_send_book_only' : 'mobile.payments.cant_pay_sends_off'),
      );
      return;
    }
    setPicked({address: draft as Address, label: given || undefined, addToBook: addToBook && addGate.allowed});
    nav.pop(2);
  };
  const canConfirm = valid && (!manage || (write.ready && addGate.allowed));

  return (
    <ScrollView
      style={styles.flex}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.body}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled">
      <Pressable accessible={false} onPress={Keyboard.dismiss} style={styles.dismiss}>
        {/* Two full-width fields in one group, as Settings rows: the address, then the name. */}
        <View style={styles.fields}>
          <TextInput
            style={[styles.input, styles.divider, draft.length > 0 && !valid && styles.inputErr]}
            placeholder={t('mobile.vault.enter_address')}
            placeholderTextColor={c.subtext}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            value={draft}
            onChangeText={setDraft}
          />
          <TextInput
            style={styles.input}
            placeholder={`${t('mobile.payments.recipient_name')} · ${t('mobile.payments.name_local_only')}`}
            placeholderTextColor={c.subtext}
            autoCapitalize="words"
            value={nameDraft}
            onChangeText={setNameDraft}
          />
        </View>
        {isToken ? <Text style={styles.warn}>{t('mobile.payments.token_address_warning')}</Text> : null}

        <View style={[styles.card, styles.gap]}>
          {/* Managing the book there is no payment: no switch, and no cap to show. */}
          {manage ? null : (
            <>
              <View style={[styles.row, styles.divider]}>
                <Text style={styles.rowLabel}>{t('mobile.payments.add_to_whitelist')}</Text>
                <Switch
                  value={addToBook && addGate.allowed}
                  disabled={!addGate.allowed}
                  onValueChange={setAddToBook}
                  style={styles.switch}
                />
              </View>
              <View style={[styles.row, addToBook && styles.divider]}>
                <Text style={styles.rowLabel}>{t('mobile.payments.max_send')}</Text>
                <Text style={styles.rowValue}>{max}</Text>
              </View>
            </>
          )}
          {/* A new whitelist entry waits out the timelock before it can be paid. */}
          {addToBook ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>{t('mobile.payments.whitelist_wait')}</Text>
              <Text style={styles.rowValue}>{risk ? fmtDuration(risk.timelock, t) : '…'}</Text>
            </View>
          ) : null}
        </View>

        <Pressable
          style={({pressed}) => [styles.use, (!canConfirm || lockedHere) && styles.useOff, pressed && styles.pressed]}
          disabled={!canConfirm || lockedHere}
          onPress={confirm}>
          <View style={styles.useRow}>
            {lockedHere ? <LockIcon level={lockLevel as 1 | 2} /> : null}
            <Text style={[styles.useText, (!canConfirm || lockedHere) && styles.useTextOff]}>{t('vault.confirm')}</Text>
          </View>
        </Pressable>
        {manage && !lockedHere ? <GateHint gate={addGate} style={styles.gap} /> : null}
      </Pressable>
      {write.sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, paddingBottom: 32},
    dismiss: {flex: 1},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    gap: {marginTop: 24},
    fields: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    input: {width: '100%', minHeight: 52, color: c.text, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15},
    inputErr: {color: c.danger},
    warn: {color: c.danger, fontSize: 12, lineHeight: 17, marginTop: 6, paddingHorizontal: 16},
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52},
    divider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    rowLabel: {color: c.text, fontSize: 15, fontWeight: '600', flex: 1},
    rowValue: {color: c.subtext, fontSize: 14, fontVariant: ['tabular-nums']},
    // A switch fills its box exactly, where a chevron's glyph sits inside; this lines them up.
    switch: {marginRight: 10},
    use: {height: 52, borderRadius: 26, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginTop: 24},
    useOff: {backgroundColor: c.neutralSoft},
    useRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
    useText: {color: '#fff', fontSize: 15, fontWeight: '700'},
    useTextOff: {color: c.subtext},
    pressed: {opacity: 0.6},
  });

import React, {useEffect, useState} from 'react';
import {Keyboard, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {isPayableAddress, isTokenAddress, useAssetCatalog} from '@/core/asset-catalog';
import {useNetwork} from '@/core/network-store';
import {useWallet} from '@/wallet/store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {getRiskConfig, type RiskConfig} from '@/vault/risk';
import {fmtAllowance, fmtDuration} from '@/components/riskFormat';
import {useRecipientNames} from '@/core/recipient-names';
import {useRecipientPick} from '@/core/recipient-pick';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Select recipient › New recipient — an address to type, a name for it on this device, and whether
 * it goes into the whitelist with the payment. The most the payment can be follows that choice: a
 * whitelisted address has no cap, any other is held to the vault's daily send allowance.
 *
 * Confirming hands the address back through {useRecipientPick} and unwinds past the picker straight
 * to the Send card, which is where the choice is used.
 */
export function NewRecipientScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = useActiveVaultAddress(network);
  const symbol = useAssetCatalog(network).find((a) => a.kind === 'stable')?.symbol;
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

  const valid = isPayableAddress(draft, network);
  const isToken = isTokenAddress(draft, network);
  const max = addToBook
    ? t('mobile.payments.max_send_none')
    : risk
      ? t('mobile.payments.max_send_daily', {value: fmtAllowance(risk.sendDailyAllowance, risk, symbol, t)})
      : '…';

  const confirm = () => {
    const given = nameDraft.trim();
    if (given) setName(network, draft, given);
    setPicked({address: draft as Address, label: given || undefined, addToBook});
    nav.pop(2);
  };

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
          <View style={[styles.row, styles.divider]}>
            <Text style={styles.rowLabel}>{t('mobile.payments.add_to_whitelist')}</Text>
            <Switch value={addToBook} onValueChange={setAddToBook} style={styles.switch} />
          </View>
          <View style={[styles.row, addToBook && styles.divider]}>
            <Text style={styles.rowLabel}>{t('mobile.payments.max_send')}</Text>
            <Text style={styles.rowValue}>{max}</Text>
          </View>
          {/* A new whitelist entry waits out the timelock before it can be paid. */}
          {addToBook ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>{t('mobile.payments.whitelist_wait')}</Text>
              <Text style={styles.rowValue}>{risk ? fmtDuration(risk.timelock, t) : '…'}</Text>
            </View>
          ) : null}
        </View>

        <Pressable
          style={({pressed}) => [styles.use, !valid && styles.useOff, pressed && styles.pressed]}
          disabled={!valid}
          onPress={confirm}>
          <Text style={[styles.useText, !valid && styles.useTextOff]}>{t('vault.confirm')}</Text>
        </Pressable>
      </Pressable>
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
    use: {height: 48, borderRadius: 14, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginTop: 24},
    useOff: {backgroundColor: c.neutralSoft},
    useText: {color: '#fff', fontSize: 15, fontWeight: '700'},
    useTextOff: {color: c.subtext},
    pressed: {opacity: 0.6},
  });

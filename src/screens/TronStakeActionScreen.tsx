import React, {useState} from 'react';
import {Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import {formatUnits, parseUnits} from 'viem';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {fmtNum} from '@/core/format';
import {ConfirmButton} from '@/components/Button';
import {ClearBtn} from '@/components/ClearBtn';
import {PercentSlider} from '@/components/PercentSlider';
import {useEndCaret} from '@/components/useEndCaret';
import {TokenIcon} from '@/components/TokenIcon';
import {FormSheet, FORM_SHEET_BODY} from '@/components/FormSheet';
import {AvailableLine} from '@/components/AvailableLine';
import {useToasts} from '@/components/Toast';
import {UnlockCancelled} from '@/tron/send';
import {TRON_EXPLORER_TX} from '@/tron/config';
import {MAX_UNSTAKING, MIN_STAKE_SUN, runStakeAction} from '@/tron/stake';
import {useTronStake} from '@/tron/useTronStake';

function toSun(s: string): bigint | null {
  const v = s.trim().replace(',', '.');
  if (!v || !/^\d*\.?\d*$/.test(v) || (v.split('.')[1] ?? '').length > 6) return null;
  try {
    const n = parseUnits(v, 6);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/**
 * Deposit (stake) or Withdraw (unstake) TRX in TRON Stake from the Tron wallet: the vault's Earn
 * form (EarnActionScreen) as it was for TRON Stake — what is available, the amount with Max, the
 * slider, Confirm — signed by the wallet.
 */
export function TronStakeActionScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const {params} = useRoute<RouteProp<RootStackParamList, 'TronStakeAction'>>();
  const isDeposit = params.mode === 'deposit';
  const {net, from, state} = useTronStake();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const amountCaret = useEndCaret(amount);

  const maxSun = !state ? 0n : isDeposit ? state.balanceSun : state.stakedSun;
  const max = formatUnits(maxSun, 6);
  const hasMax = maxSun > 0n;
  const raw = toSun(amount);
  const over = raw != null && raw > (isDeposit ? state?.balanceSun ?? 0n : state?.stakedSun ?? 0n);
  const tooSmall = isDeposit && raw != null && raw < MIN_STAKE_SUN;
  const queueFull = !isDeposit && !!state && state.unstaking.length >= MAX_UNSTAKING;
  const canSubmit = !!state && raw != null && !over && !tooSmall && !queueFull && !busy;
  const trim = (n: number): string => (!isFinite(n) || n <= 0 ? '' : String(Number(n < 1 ? n.toPrecision(6) : n.toFixed(6))));
  const pct = hasMax && Number(amount) > 0 ? (Number(amount) / Number(max)) * 100 : 0;

  const onSubmit = async () => {
    if (!canSubmit || !from || raw == null) return;
    Keyboard.dismiss();
    setBusy(true);
    const toasts = useToasts.getState();
    const label = `${t(isDeposit ? 'vault.deposit' : 'vault.withdraw')} · ${fmtNum(Number(formatUnits(raw, 6)))} TRX`;
    const id = toasts.show({kind: 'pending', title: label});
    try {
      const txID = await runStakeAction(net, from, {kind: isDeposit ? 'stake' : 'unstake', amountSun: raw});
      toasts.update(id, {kind: 'success', hash: txID, explorer: {url: TRON_EXPLORER_TX[net], name: 'Tronscan'}});
      nav.goBack();
    } catch (e) {
      if (e instanceof UnlockCancelled) toasts.dismiss(id);
      else toasts.update(id, {kind: 'error', detail: (e as Error).message});
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSheet visible onClose={() => nav.goBack()} ownModal={false}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={FORM_SHEET_BODY} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <AvailableLine amount={Number(max)} symbol="TRX" onPress={() => setAmount(max)} />
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('vault.amount')}</Text>
          <View style={styles.fieldRight}>
            <TextInput
              style={[styles.fieldInput, over && styles.fieldInputOver]}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={c.subtext}
              value={amount}
              onChangeText={setAmount}
              {...amountCaret}
            />
            {Number(amount) > 0 ? (
              <ClearBtn onPress={() => setAmount('')} />
            ) : hasMax ? (
              <Pressable onPress={() => setAmount(max)} style={styles.maxPill}>
                <Text style={styles.maxText}>{t('common.max')}</Text>
              </Pressable>
            ) : null}
            <View style={styles.symPill}>
              <TokenIcon symbol="TRX" size={20} />
              <Text style={styles.fieldSym}>TRX</Text>
            </View>
          </View>
        </View>

        {over ? (
          <Text style={styles.overText}>
            {t('vault.exceeds_balance')} · {fmtNum(Number(max))} TRX
          </Text>
        ) : null}

        <PercentSlider value={pct} onChange={(v) => setAmount(v >= 100 ? max : trim((Number(max) * v) / 100))} disabled={!hasMax} />

        {tooSmall ? <Text style={styles.err}>{t('mobile.tron.min_stake')}</Text> : null}
        {queueFull ? <Text style={styles.err}>{t('mobile.tron.too_many_unstaking')}</Text> : null}

        <ConfirmButton onPress={() => void onSubmit()} disabled={!canSubmit} loading={busy} fee={false} style={styles.submit} />
      </ScrollView>
    </FormSheet>
  );
}

// EarnActionScreen's styles, for the parts this form draws.
const makeStyles = (c: Colors) =>
  StyleSheet.create({
    submit: {marginTop: 6},
    field: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.input, borderRadius: 12, paddingHorizontal: 14, height: 52},
    fieldLabel: {color: c.subtext, fontSize: 12, fontWeight: '600'},
    fieldRight: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end', marginLeft: 12},
    fieldInput: {flex: 1, textAlign: 'right', color: c.text, fontSize: 17, fontVariant: ['tabular-nums'], padding: 0},
    fieldInputOver: {color: c.danger},
    fieldSym: {color: c.text, fontSize: 14, fontWeight: '700'},
    maxPill: {backgroundColor: c.accentSoft, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3},
    maxText: {color: c.accent, fontSize: 11, fontWeight: '700'},
    symPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 16, paddingVertical: 5, paddingHorizontal: 8},
    overText: {color: c.danger, fontSize: 12},
    err: {color: c.danger, fontSize: 13},
  });

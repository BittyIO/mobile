import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {GuardParams} from '@/components/GuardLevelRows';
import {PickerSheet} from '@/components/AssetPicker';
import {Sheet} from '@/components/Sheet';
import {OptionRow, SettingsGroup} from '@/components/SettingsRow';
import {useVaultWrite} from '@/components/useVaultWrite';
import {RISK_TITLE, fmtRiskValue} from '@/components/riskFormat';
import {sameGuardValues, type GuardValues} from '@/core/new-vault-defaults';
import {valuesInForce} from '@/core/safety-levels';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useNetwork} from '@/core/network-store';
import {getRiskConfig, needsLimits, updateRiskSettings} from '@/vault/risk';
import {NO_LIMIT} from '@/vault/capabilities';
import {useAccountQuote, useAccountWrite} from '@/account/useAccountWrite';
import {ConfirmButton} from '@/components/Button';
import {formatUnits} from 'viem';
import {readGuard, type AccountGuard} from '@/account/guard';
import {accountRiskValues, guardLevelCalls, rememberGuardBatch} from '@/account/guard-evm';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {noteCustomSent} from './GuardLevelScreen';

const DAY = 86_400n;
/** The choices: the timelock (none, or 1–30 days) and the amounts a daily limit may be. */
const CHOICES: Record<keyof GuardValues, bigint[]> = {
  timelock: [0n, DAY, 3n * DAY, 5n * DAY, 7n * DAY, 14n * DAY, 30n * DAY],
  sendDailyAllowance: [0n, 100n, 500n, 1_000n, 5_000n, 10_000n, 100_000n, 1_000_000n, NO_LIMIT],
  marketTradeDailyLossAllowance: [0n, 100n, 500n, 1_000n, 5_000n, 10_000n, 100_000n, 1_000_000n, NO_LIMIT],
};

/**
 * Guard › Guard level › Custom: the timelock and both daily limits, each set on its own row,
 * starting from the values in force. Confirm writes all three in one change and goes back to the
 * level list, which shows Custom on its way until the chain has it.
 */
export function GuardCustomScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const [now, setNow] = useState<GuardValues | null>(null);
  const [values, setValues] = useState<GuardValues | null>(null);
  const [editing, setEditing] = useState<keyof GuardValues | null>(null);
  // The Tron smart wallet: the timelock and its one daily limit, set on the account and relayed.
  const acct = useAccountWrite(() => nav.goBack());
  const smart = acct.account != null;
  const [guard, setGuard] = useState<AccountGuard | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (acct.account) {
        let live = true;
        readGuard(network, acct.account).then((g) => {
          if (!live) return;
          setGuard(g);
          const inForce = accountRiskValues(g);
          setNow(inForce);
          setValues((cur) => cur ?? inForce);
        });
        return () => {
          live = false;
        };
      }
      if (!vault) return;
      let live = true;
      getRiskConfig(vault, network).then((r) => {
        if (!live || !r.read) return;
        const v = valuesInForce(r);
        const inForce = {timelock: v.timelock, sendDailyAllowance: v.sendDailyAllowance, marketTradeDailyLossAllowance: v.marketTradeDailyLossAllowance};
        setNow(inForce);
        // Keep what is being edited across a re-focus (a picker or the confirm sheet).
        setValues((cur) => cur ?? inForce);
      });
      return () => {
        live = false;
      };
    }, [vault, network, acct.account]),
  );
  const vw = useVaultWrite(() => nav.goBack());
  const busy = smart ? acct.busy : vw.busy;
  const ready = smart ? acct.ready : vw.ready;
  const changed = values != null && now != null && !sameGuardValues(values, now);
  // Above none, a timelock needs both limits to be amounts: the vault refuses the mix otherwise.
  const refused = !smart && values != null && needsLimits(values);
  // The smart wallet's batch for what is chosen, priced as it changes: the fee on Confirm itself.
  const batch = smart && changed && acct.account && guard && values ? guardLevelCalls(network, acct.account, guard, values) : null;
  const priced = useAccountQuote(batch?.calls ?? null);
  const confirm = () => {
    if (smart) {
      const a = acct.account;
      if (!a || !batch || !priced.quote || !values) return;
      const queued = batch.queued;
      return void acct.runQuoted('custom', t('mobile.vault.change_guard_config'), batch.calls, priced.quote, () => {
        if (queued) rememberGuardBatch(network, a, queued);
        else noteCustomSent(values);
      });
    }
    // The fee is on Confirm itself, so no sheet before it: Face ID, then the toast.
    return (
    values &&
    vw.runConfirmed('custom', t('mobile.vault.change_guard_config'), async (b) => {
      const hash = await updateRiskSettings({...b, changes: values});
      noteCustomSent(values);
      return hash;
    })
    );
  };

  return (
    <View style={styles.fill}>
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
        {values ? <GuardParams values={values} onEdit={busy ? undefined : setEditing} sendOnly={smart} /> : null}
        {refused ? <Text style={[styles.note, {color: c.danger}]}>{t('mobile.vault.timelock_needs_limits')}</Text> : null}
        <View style={styles.confirmArea}>
          {smart && priced.error ? <Text style={[styles.note, {color: c.danger}]}>{`${t('mobile.account.fee_failed')} (${priced.error})`}</Text> : null}
          <ConfirmButton
            onPress={confirm}
            loading={busy === 'custom'}
            disabled={!changed || refused || !ready || (smart && !priced.quote)}
            fee={changed && !refused && (!smart || !!priced.quote)}
            networkFeeUsd={smart && priced.quote ? Number(formatUnits(priced.quote.fee, 6)) : undefined}
            pricing={smart && priced.pricing}
          />
        </View>
      </ScrollView>
      <TimelockSheet
        visible={editing === 'timelock'}
        value={values?.timelock ?? 0n}
        onSelect={(v) => setValues((cur) => (cur ? {...cur, timelock: v} : cur))}
        onClose={() => setEditing(null)}
      />
      <PickerSheet
        visible={editing !== null && editing !== 'timelock'}
        title={editing ? t(RISK_TITLE[editing]) : ''}
        items={editing ? CHOICES[editing].map((v) => ({key: String(v), label: fmtRiskValue(editing, v, t)})) : []}
        selected={editing && values ? String(values[editing]) : undefined}
        // The smart wallet's one limit stands for both of the vault's: kept alike.
        onSelect={(k) =>
          editing &&
          setValues((v) =>
            v ? (smart && editing !== 'timelock' ? {...v, sendDailyAllowance: BigInt(k), marketTradeDailyLossAllowance: BigInt(k)} : {...v, [editing]: BigInt(k)}) : v,
          )
        }
        onClose={() => setEditing(null)}
      />
      {vw.sheet}
      {acct.sheet}
    </View>
  );
}

/** The longest timelock the vault takes, in days; anything from one day up to it, or none. */
const MAX_TIMELOCK_DAYS = 30;

/**
 * The timelock's choices: none, the usual day counts, and Custom, where any whole number of days
 * from 1 to {MAX_TIMELOCK_DAYS} is typed in.
 */
function TimelockSheet({visible, value, onSelect, onClose}: {visible: boolean; value: bigint; onSelect: (v: bigint) => void; onClose: () => void}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const presets = CHOICES.timelock;
  const isCustom = !presets.includes(value);
  const [typing, setTyping] = useState(false);
  const [days, setDays] = useState('');
  useEffect(() => {
    if (!visible) return;
    setTyping(false);
    setDays(isCustom ? String(Number(value / DAY)) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const n = Number(days);
  const ok = days.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_TIMELOCK_DAYS;
  const pick = (v: bigint) => {
    onSelect(v);
    onClose();
  };
  return (
    <Sheet visible={visible} title={t(RISK_TITLE.timelock)} onClose={onClose}>
      <SettingsGroup>
        {presets.map((v) => (
          <OptionRow key={String(v)} title={fmtRiskValue('timelock', v, t)} checked={!typing && value === v} onPress={() => pick(v)} />
        ))}
        <OptionRow
          title={t('common.custom')}
          sub={isCustom && !typing ? fmtRiskValue('timelock', value, t) : undefined}
          checked={typing || isCustom}
          onPress={() => setTyping(true)}
          last={!typing}
        />
        {typing ? (
          <View style={styles.customRow}>
            <TextInput
              style={styles.input}
              autoFocus
              keyboardType="number-pad"
              placeholder={`1–${MAX_TIMELOCK_DAYS}`}
              placeholderTextColor={c.subtext}
              value={days}
              onChangeText={(v) => setDays(v.replace(/[^0-9]/g, ''))}
            />
            <Text style={styles.unit}>{t('mobile.vault.unit_days')}</Text>
            <Pressable disabled={!ok} onPress={() => pick(BigInt(n) * DAY)} style={[styles.doneBtn, !ok && styles.doneOff]}>
              <Text style={[styles.doneText, !ok && styles.doneTextOff]}>{t('vault.done')}</Text>
            </Pressable>
          </View>
        ) : null}
      </SettingsGroup>
    </Sheet>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    fill: {flex: 1, backgroundColor: c.bg},
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    note: {fontSize: 13, lineHeight: 19, paddingHorizontal: 4, marginTop: -8},
    confirmArea: {gap: 10},
    customRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10},
    input: {flex: 1, minHeight: 40, borderRadius: 10, backgroundColor: c.input, color: c.text, paddingHorizontal: 12, fontSize: 17},
    unit: {color: c.subtext, fontSize: 13},
    doneBtn: {
      minHeight: 40,
      paddingHorizontal: 16,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
    },
    doneOff: {borderColor: c.border, backgroundColor: c.card},
    doneText: {color: c.accent, fontSize: 14, fontWeight: '700'},
    doneTextOff: {color: c.subtext},
  });

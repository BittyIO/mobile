import React, {useCallback, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect, useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {
  getRiskConfig,
  getLockLevel,
  setRiskTimelock,
  setSendDailyAllowance,
  setMarketTradeDailyLossAllowance,
  type RiskConfig,
  type LockLevel,
} from '@/vault/risk';
import {OptionRow, SettingsGroup} from '@/components/SettingsRow';
import {fmtRiskValue, fmtPending, RISK_TITLE} from '@/components/riskFormat';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

const HOUR = 3600n;
const DAY = 86400n;

/** The answers worth offering. Anything else is one Custom entry away. */
const PRESETS = {
  timelock: [0n, HOUR, 6n * HOUR, 24n * HOUR, 48n * HOUR, 7n * DAY],
  sendDailyAllowance: [0n, 100n, 500n, 1_000n, 5_000n, 10_000n],
  marketTradeDailyLossAllowance: [0n, 50n, 100n, 500n, 1_000n, 5_000n],
} as const;

/**
 * One risk number, picked (Security › Risk settings › Timelock / Daily send allowance / Market trade
 * daily loss allowance).
 *
 * A pick-one list of presets with the value in force checked, and Custom for any other value, typed
 * in hours (timelock) or whole USD (the allowances; the send cap in stablecoin tokens on v1.0.3). Choosing writes at
 * once — through the Face-ID and fee confirm — rather than waiting on a Save: the choice IS the
 * action. A loosening does not move the check: it waits out the timelock, and says so under the list.
 */
export function RiskValueScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const {field} = useRoute<RouteProp<RootStackParamList, 'VaultRiskValue'>>().params;
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const [lockLevel, setLockLevel] = useState<LockLevel | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');

  const {vault, network, stable, busy, ready, run, sheet} = useVaultWrite(() => load());

  const load = useCallback(() => {
    if (!vault) return;
    getRiskConfig(vault, network).then(setRisk);
    getLockLevel(vault, network).then(setLockLevel);
  }, [vault, network]);
  useFocusEffect(load);

  const isTimelock = field === 'timelock';
  const legacy = risk?.hasLocks === false;
  const current = risk ? risk[field] : null;
  const presets: readonly bigint[] = PRESETS[field];
  const isCustom = current != null && !presets.includes(current);
  // A lock freezes these too, so nothing can be picked rather than signed and refused on chain.
  const locked = lockLevel === 1 || lockLevel === 2;
  const canPick = ready && !locked && risk != null;
  const fmt = (v: bigint) => fmtRiskValue(field, v, risk, stable?.symbol, t);
  const title = t(RISK_TITLE[field]);

  const write = (key: string, value: bigint) => {
    if (value === current) return;
    const setter = {
      timelock: setRiskTimelock,
      sendDailyAllowance: setSendDailyAllowance,
      marketTradeDailyLossAllowance: setMarketTradeDailyLossAllowance,
    }[field];
    run(key, title, (b) => setter({...b, value}));
  };

  const customValue = (): bigint | null => {
    const n = Number(custom);
    if (custom.trim() === '' || !Number.isFinite(n) || n < 0) return null;
    return isTimelock ? BigInt(Math.round(n * Number(HOUR))) : BigInt(Math.floor(n));
  };
  const parsed = customValue();
  const customOff = !canPick || parsed == null || parsed === current;

  const unit = isTimelock
    ? t('vault.time_unit.hours')
    : legacy && field === 'sendDailyAllowance'
      ? stable?.symbol ?? t('mobile.vault.tokens')
      : 'USD';

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup
        footer={[
          fmtPending(field, risk, stable?.symbol, t),
          t(`${RISK_TITLE[field]}_hint`),
        ]
          .filter(Boolean)
          .join('\n\n')}>
        {presets.map((v) => (
          <OptionRow
            key={String(v)}
            title={fmt(v)}
            checked={!customOpen && current === v}
            busy={busy === `preset-${v}`}
            disabled={!canPick}
            onPress={() => {
              setCustomOpen(false);
              write(`preset-${v}`, v);
            }}
          />
        ))}
        <OptionRow
          title={t('common.custom')}
          sub={isCustom && !customOpen ? fmt(current!) : undefined}
          checked={customOpen || isCustom}
          disabled={!canPick}
          onPress={() => {
            setCustom(isCustom && current != null ? (isTimelock ? String(Number(current) / Number(HOUR)) : String(current)) : '');
            setCustomOpen(true);
          }}
          last={!customOpen}
        />
        {customOpen ? (
          <View style={styles.customRow}>
            <TextInput
              style={styles.input}
              autoFocus
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={c.subtext}
              value={custom}
              onChangeText={setCustom}
            />
            <Text style={styles.unit}>{unit}</Text>
            <Pressable
              disabled={customOff}
              onPress={() => parsed != null && write('custom', parsed)}
              style={[styles.saveBtn, customOff && styles.saveOff]}>
              <Text style={[styles.saveText, customOff && styles.saveTextOff]}>{busy === 'custom' ? '…' : t('vault.save')}</Text>
            </Pressable>
          </View>
        ) : null}
      </SettingsGroup>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    customRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10},
    input: {flex: 1, height: 40, borderRadius: 10, backgroundColor: c.input, color: c.text, paddingHorizontal: 12, fontSize: 17},
    unit: {color: c.subtext, fontSize: 13},
    saveBtn: {
      height: 40,
      paddingHorizontal: 16,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
    },
    saveOff: {borderColor: c.border, backgroundColor: c.card},
    saveText: {color: c.accent, fontSize: 14, fontWeight: '700'},
    saveTextOff: {color: c.subtext},
  });

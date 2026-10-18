import React, {useCallback, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {getRiskConfig, getLockLevel, RISK_BOUNDS, type RiskConfig, type LockLevel} from '@/vault/risk';
import {OptionRow, SettingsGroup} from '@/components/SettingsRow';
import {fmtRiskValue, fmtPending, riskHintKey} from '@/components/riskFormat';
import {useRiskDraft} from '@/core/risk-draft';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

const HOUR = 3600n;
const DAY = 86400n;

/**
 * The answers worth offering. Anything else is one Custom entry away. A v1.0.0 vault refuses 0 and
 * anything outside {RISK_BOUNDS}, so it is offered only what it accepts; v1.0.3 keeps 0 as "off".
 */
const PRESETS = {
  timelock: [DAY, 2n * DAY, 7n * DAY, 14n * DAY, 30n * DAY],
  sendDailyAllowance: [100n, 500n, 1_000n, 5_000n, 10_000n],
  marketTradeDailyLossAllowance: [50n, 100n, 500n, 1_000n, 5_000n, 10_000n],
} as const;
const LEGACY_PRESETS = {
  timelock: [0n, HOUR, 6n * HOUR, 24n * HOUR, 48n * HOUR, 7n * DAY],
  sendDailyAllowance: [0n, 100n, 500n, 1_000n, 5_000n, 10_000n],
  marketTradeDailyLossAllowance: [0n, 50n, 100n, 500n, 1_000n, 5_000n],
} as const;

/**
 * One risk number, picked (Security › Risk settings › Timelock / Daily send allowance / Market trade
 * daily loss allowance).
 *
 * A pick-one list of presets with the value in force checked, and Custom for any other value, typed
 * in hours (timelock) or whole USD (the allowances; the send cap in stablecoin tokens on v1.0.3).
 * Choosing signs nothing: it goes into the page's draft and back to Risk settings, which saves every
 * changed field in one transaction. The check shows the draft value where there is one.
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

  const nav = useNavigation();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = useAssetCatalog(network).find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const drafted = useRiskDraft((s) => s.changes[field]);
  const setDraft = useRiskDraft((s) => s.set);

  const load = useCallback(() => {
    if (!vault) return;
    getRiskConfig(vault, network).then(setRisk);
    getLockLevel(vault, network).then(setLockLevel);
  }, [vault, network]);
  useFocusEffect(load);

  const isTimelock = field === 'timelock';
  const legacy = risk?.hasLocks === false;
  const inForce = risk ? risk[field] : null;
  // What the page is set to: the unsaved pick where there is one, otherwise the value in force.
  const current = drafted ?? inForce;
  const presets: readonly bigint[] = (legacy ? LEGACY_PRESETS : PRESETS)[field];
  const bounds = legacy ? null : RISK_BOUNDS[field];
  const isCustom = current != null && !presets.includes(current);
  // A lock freezes these too, so nothing can be picked rather than signed and refused on chain.
  const locked = lockLevel === 1 || lockLevel === 2;
  const canPick = !locked && risk != null;
  const fmt = (v: bigint) => fmtRiskValue(field, v, risk, stable?.symbol, t);

  // Picking the value in force again drops the field from the draft rather than saving a no-op.
  const pick = (value: bigint) => {
    setDraft(field, value === inForce ? undefined : value);
    nav.goBack();
  };

  const customValue = (): bigint | null => {
    const n = Number(custom);
    if (custom.trim() === '' || !Number.isFinite(n) || n < 0) return null;
    const v = isTimelock ? BigInt(Math.round(n * Number(HOUR))) : BigInt(Math.floor(n));
    // Outside the bounds the vault would refuse it, so it cannot be picked.
    if (bounds && (v < bounds.min || v > bounds.max)) return null;
    return v;
  };
  const parsed = customValue();
  const customOff = !canPick || parsed == null || parsed === current;

  // The accepted range, in the unit typed: hours for the timelock, whole USD for the allowances.
  const range = bounds
    ? isTimelock
      ? `${Number(bounds.min / HOUR)}–${Number(bounds.max / HOUR)}`
      : `${Number(bounds.min).toLocaleString()}–${Number(bounds.max).toLocaleString()}`
    : '0';

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
          t(riskHintKey(field, !legacy)),
        ]
          .filter(Boolean)
          .join('\n\n')}>
        {presets.map((v) => (
          <OptionRow
            key={String(v)}
            title={fmt(v)}
            checked={!customOpen && current === v}
            disabled={!canPick}
            onPress={() => {
              setCustomOpen(false);
              pick(v);
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
              placeholder={range}
              placeholderTextColor={c.subtext}
              value={custom}
              onChangeText={setCustom}
            />
            <Text style={styles.unit}>{unit}</Text>
            <Pressable
              disabled={customOff}
              onPress={() => parsed != null && pick(parsed)}
              style={[styles.saveBtn, customOff && styles.saveOff]}>
              <Text style={[styles.saveText, customOff && styles.saveTextOff]}>{t('vault.done')}</Text>
            </Pressable>
          </View>
        ) : null}
      </SettingsGroup>
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

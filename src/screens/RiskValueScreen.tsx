import React, {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {getRiskConfig, RISK_BOUNDS, updateRiskSettings, useAllowsZeroAllowance, type RiskConfig} from '@/vault/risk';
import {useCapability} from '@/vault/gate';
import {LockNotice} from '@/components/LockNotice';
import {OptionRow, SettingsGroup} from '@/components/SettingsRow';
import {Button} from '@/components/Button';
import {Sheet} from '@/components/Sheet';
import {InfoIcon} from '@/components/TradeMenu';
import {useVaultWrite} from '@/components/useVaultWrite';
import {RISK_TITLE, fmtCountdown, fmtRiskValue, fmtPending, riskHintKey, riskZeroHintKey} from '@/components/riskFormat';
import {isLoosening, valuesInForce} from '@/core/safety-levels';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

const HOUR = 3600n;
const DAY = 86400n;

/**
 * The answers worth offering. Anything else is one Custom entry away. The vault refuses anything
 * outside {RISK_BOUNDS}, so it is offered only what it accepts — and an allowance of 0, which turns
 * regular sends or market trading off, only on a vault release that accepts it.
 */
const PRESETS = {
  timelock: [DAY, 2n * DAY, 3n * DAY, 5n * DAY, 7n * DAY, 14n * DAY, 30n * DAY],
  sendDailyAllowance: [100n, 500n, 1_000n, 5_000n, 10_000n],
  marketTradeDailyLossAllowance: [50n, 100n, 500n, 1_000n, 5_000n, 10_000n],
} as const;

/**
 * One risk number, on a page of its own: Security › Timelock, Send to new in
 * 24 hours, and Market trade slippage in 24 hours.
 *
 * The page is the choices, with the value in force checked — what the number protects against, its
 * rules and what $0 does are behind the ⓘ in the header — and Custom for any other value (hours for the timelock, whole USD for the allowances).
 * Save writes this one number. Before saving it says when the change lands: a stricter value at
 * once, a looser one after the timelock in force now. A change already waiting shows under the
 * choices. A locked vault shows the page but nothing can be picked.
 */
export function RiskValueScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const {field} = useRoute<RouteProp<RootStackParamList, 'VaultRiskValue'>>().params;
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const [chosen, setChosen] = useState<bigint | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // The explanation lives behind an ⓘ in the header, so the page itself is just the choices.
  const [explainOpen, setExplainOpen] = useState(false);
  const nav = useNavigation();

  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);

  const load = useCallback(() => {
    if (!vault) return;
    getRiskConfig(vault, network).then(setRisk);
  }, [vault, network]);
  useFocusEffect(load);
  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Pressable onPress={() => setExplainOpen(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel={t(RISK_TITLE[field])}>
          <InfoIcon color={c.accent} size={22} />
        </Pressable>
      ),
    });
  }, [nav, c, t, field]);
  // The countdown to a change already waiting.
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const {busy, ready, run, sheet} = useVaultWrite(() => {
    setChosen(null);
    setCustomOpen(false);
    load();
  });

  const isTimelock = field === 'timelock';
  const inForceAll = risk ? valuesInForce(risk) : null;
  const inForce = inForceAll ? inForceAll[field] : null;
  // What the page is set to: the unsaved pick where there is one, otherwise the value in force.
  const current = chosen ?? inForce;
  // A vault not activated yet is born on a release that takes 0 (and starts with sends at 0).
  const zeroOk = (useAllowsZeroAllowance(vault, network) || (risk != null && !risk.read)) && !isTimelock;
  const presets: readonly bigint[] = zeroOk ? [0n, ...PRESETS[field]] : PRESETS[field];
  const bounds = {min: zeroOk ? 0n : RISK_BOUNDS[field].min, max: RISK_BOUNDS[field].max};
  const zeroHint = zeroOk ? riskZeroHintKey(field) : null;
  const isCustom = current != null && !presets.includes(current);
  // A lock freezes these too, so nothing can be picked rather than signed and refused on chain.
  const gate = useCapability('updateRisk');
  const locked = !gate.allowed;
  const canPick = !locked && risk != null && busy === null;
  // The window lives here, on the choices, rather than in the setting's name: "$500 per 24 hours".
  const fmt = (v: bigint) => (isTimelock || v === 0n ? fmtRiskValue(field, v, t) : t('mobile.vault.per_24h', {value: fmtRiskValue(field, v, t)}));

  // Picking the value in force again clears the pick rather than offering a no-op save.
  const pick = (value: bigint) => setChosen(value === inForce ? null : value);

  const customValue = (): bigint | null => {
    const n = Number(custom);
    if (custom.trim() === '' || !Number.isFinite(n) || n < 0) return null;
    const v = isTimelock ? BigInt(Math.round(n * Number(HOUR))) : BigInt(Math.floor(n));
    // Outside the bounds the vault would refuse it, so it cannot be picked.
    if (v < bounds.min || v > bounds.max) return null;
    return v;
  };
  const parsed = customValue();
  const customOff = !canPick || parsed == null || parsed === current;

  // The accepted range, in the unit typed: hours for the timelock, whole USD for the allowances.
  const range = isTimelock
    ? `${Number(bounds.min / HOUR)}–${Number(bounds.max / HOUR)}`
    : `${Number(bounds.min).toLocaleString()}–${Number(bounds.max).toLocaleString()}`;
  const unit = isTimelock ? t('vault.time_unit.hours') : 'USD';

  // When the pick would land: at once when it is stricter (or the vault is not activated yet, where
  // it is written at creation), otherwise after the timelock in force now.
  const dirty = chosen != null && inForce != null && chosen !== inForce;
  const loosens = dirty && risk!.read && isLoosening(field, inForce!, chosen!);
  const effectAt = inForceAll ? now + Number(inForceAll.timelock) : 0;
  const applies = !dirty
    ? undefined
    : loosens
      ? t('mobile.vault.safety_applies_later', {date: new Date(effectAt * 1000).toLocaleString(), time: fmtCountdown(effectAt - now, t) ?? ''})
      : t('mobile.vault.safety_applies_now');

  const save = () =>
    chosen != null && run('save', t(RISK_TITLE[field]), (b) => updateRiskSettings({...b, changes: {[field]: chosen}}));

  return (
    <View style={styles.fill}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        style={styles.container}
        contentContainerStyle={styles.body}>
        <LockNotice blocked={locked} />
        <SettingsGroup footer={fmtPending(field, risk, t)}>
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
                onPress={() => {
                  if (parsed == null) return;
                  pick(parsed);
                  setCustomOpen(false);
                }}
                style={[styles.doneBtn, customOff && styles.doneOff]}>
                <Text style={[styles.doneText, customOff && styles.doneTextOff]}>{t('vault.done')}</Text>
              </Pressable>
            </View>
          ) : null}
        </SettingsGroup>
        <View style={styles.saveArea}>
          {applies ? <Text style={styles.applies}>{applies}</Text> : null}
          <Button title={t('vault.save')} onPress={save} loading={busy === 'save'} disabled={!dirty || !ready} locked={locked} />
        </View>
        {sheet}
        {/* What this number is for, put as what it protects against, then its rules and what $0
            does: opened from the ⓘ in the header. */}
        <Sheet visible={explainOpen} title={t(RISK_TITLE[field])} onClose={() => setExplainOpen(false)}>
          <View style={styles.explain}>
            <Text style={styles.explainText}>{t(`${RISK_TITLE[field]}_why`)}</Text>
            <Text style={styles.explainSub}>{t(riskHintKey(field))}</Text>
            {zeroHint ? <Text style={styles.explainSub}>{t(zeroHint)}</Text> : null}
          </View>
        </Sheet>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    fill: {flex: 1},
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    explain: {gap: 12, paddingHorizontal: 4, paddingBottom: 24},
    explainSub: {color: c.subtext, fontSize: 13, lineHeight: 19},
    explainText: {color: c.text, fontSize: 15, lineHeight: 22},
    customRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10},
    input: {flex: 1, height: 40, borderRadius: 10, backgroundColor: c.input, color: c.text, paddingHorizontal: 12, fontSize: 17},
    unit: {color: c.subtext, fontSize: 13},
    doneBtn: {
      height: 40,
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
    saveArea: {gap: 10},
    applies: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4, textAlign: 'center'},
  });

import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {useDiscardGuard} from '@/components/DiscardGuard';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getRiskConfig, updateRiskSettings, useAllowsZeroAllowance, ZERO_ALLOWANCE_SINCE, type RiskConfig, type RiskField} from '@/vault/risk';
import {useCapability} from '@/vault/gate';
import {useRiskDraft} from '@/core/risk-draft';
import {useVaultWrite} from '@/components/useVaultWrite';
import {Button} from '@/components/Button';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {RISK_TITLE, fmtCountdown, fmtPending, fmtRiskValue} from '@/components/riskFormat';
import {
  RISK_FIELDS,
  SAFETY_LEVELS,
  SAFETY_TITLE,
  isLoosening,
  levelOf,
  valuesInForce,
  safetyColor,
  type RiskValues,
  type SafetyLevel,
  type SafetyLevelOrCustom,
} from '@/core/safety-levels';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

const ICON = {timelock: 'timelock', sendDailyAllowance: 'dailyLimit', marketTradeDailyLossAllowance: 'dailyLimit'} as const;


/**
 * Safety settings (Security › Safety settings).
 *
 * The page is two groups: the safety level — Maximum, Balanced, Standard, Custom — and
 * under it the three numbers, which follow the level picked. Picking a level fills all three into
 * the draft; the numbers can be edited by hand only under Custom. Save writes every changed number in ONE transaction,
 * and leaving with changes unsaved asks whether to discard them.
 *
 * Before saving, the page says when the change lands: a stricter level applies at once, a looser one
 * waits out the timelock in force now. A change already waiting shows under the levels, counting
 * down to the second. A locked
 * vault cannot change any of it, so the cards are shown but cannot be picked.
 */
export function RiskSettingsScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  // High sets both allowances to 0, which a vault before 1.0.5 refuses: there it is not offered.
  const zeroOk = useAllowsZeroAllowance(vault, network);
  const needsZero = (id: SafetyLevelOrCustom) => {
    const v = SAFETY_LEVELS.find((l) => l.id === id)?.values;
    return !!v && (v.sendDailyAllowance === 0n || v.marketTradeDailyLossAllowance === 0n);
  };
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const changes = useRiskDraft((s) => s.changes);
  const setDraft = useRiskDraft((s) => s.set);
  const clearDraft = useRiskDraft((s) => s.clear);
  const dirty = Object.keys(changes).length > 0;

  const load = useCallback(() => {
    if (!vault) return;
    getRiskConfig(vault, network).then(setRisk);
  }, [vault, network]);

  const {busy, ready, run, sheet} = useVaultWrite(() => {
    clearDraft();
    load();
  });

  // A draft belongs to one visit: whatever way the page goes, it does not survive it.
  useEffect(() => clearDraft, [clearDraft]);

  // Leaving with changes unsaved asks first, by the back button or the swipe — and before the page
  // goes, not after it has slid off and come back (see DiscardGuard).
  const {edge} = useDiscardGuard(dirty && !busy, clearDraft);

  // Re-read on focus — the value pages write, and the new value has to show on the way back — and
  // tick once a second while in view, for the countdowns.
  useFocusEffect(
    useCallback(() => {
      load();
      setNow(Math.floor(Date.now() / 1000));
      const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
      return () => clearInterval(id);
    }, [load]),
  );

  const save = () => run('save', t('mobile.vault.risk_settings'), (b) => updateRiskSettings({...b, changes}));

  const fmt = (f: RiskField, v: bigint) => fmtRiskValue(f, v, t);

  /** A row's second line: what an unsaved pick replaces, or a change already waiting. */
  const sub = (f: RiskField) =>
    changes[f] !== undefined && risk ? t('mobile.vault.unsaved_from', {value: fmt(f, risk[f])}) : fmtPending(f, risk, t);

  const saveButton = <Button title={t('vault.save')} onPress={save} loading={busy === 'save'} disabled={!dirty || !ready} />;

  const inForce = risk ? valuesInForce(risk) : null;
  const picked: RiskValues | null = inForce
    ? {
        timelock: changes.timelock ?? inForce.timelock,
        sendDailyAllowance: changes.sendDailyAllowance ?? inForce.sendDailyAllowance,
        marketTradeDailyLossAllowance: changes.marketTradeDailyLossAllowance ?? inForce.marketTradeDailyLossAllowance,
      }
    : null;
  const selected: SafetyLevelOrCustom | null = picked ? levelOf(picked) : null;
  // A lock freezes the risk settings in both directions (vault/gate).
  const locked = !useCapability('updateRisk').allowed;

  // A change already waiting: the level it lands on, and when the last of it does.
  const waiting = risk ? RISK_FIELDS.filter((f) => risk.pending[f]) : [];
  const landsAt = waiting.reduce((at, f) => Math.max(at, Number(risk!.pending[f]!.at)), 0);
  const landsOn =
    inForce && waiting.length > 0
      ? levelOf({
          timelock: risk!.pending.timelock?.value ?? inForce.timelock,
          sendDailyAllowance: risk!.pending.sendDailyAllowance?.value ?? inForce.sendDailyAllowance,
          marketTradeDailyLossAllowance: risk!.pending.marketTradeDailyLossAllowance?.value ?? inForce.marketTradeDailyLossAllowance,
        })
      : null;

  // When the unsaved choice would land: at once if nothing in it loosens, otherwise after the
  // timelock in force now.
  const loosens = inForce != null && RISK_FIELDS.some((f) => changes[f] !== undefined && isLoosening(f, inForce[f], changes[f]!));
  const effectAt = inForce ? now + Number(inForce.timelock) : 0;
  const preview = !dirty
    ? undefined
    : loosens
      ? t('mobile.vault.safety_applies_later', {
          date: new Date(effectAt * 1000).toLocaleString(),
          time: fmtCountdown(effectAt - now, t) ?? '',
        })
      : t('mobile.vault.safety_applies_now');

  /** Put a level's three numbers into the draft, dropping any that are already in force. */
  const apply = (id: SafetyLevel) => {
    if (!inForce) return;
    const preset = SAFETY_LEVELS.find((l) => l.id === id)!.values;
    RISK_FIELDS.forEach((f) => setDraft(f, preset[f] === inForce[f] ? undefined : preset[f]));
    setCustomOpen(false);
  };
  const pick = (id: SafetyLevel) => {
    if (locked || !inForce || (needsZero(id) && !zeroOk)) return;
    // Already this level's numbers — the one in force, with Custom opened over it and nothing
    // edited. There is nothing to put in the draft, but the choice still has to move back from
    // Custom; returning early here is what left Custom stuck on.
    if (selected === id) {
      setCustomOpen(false);
      return;
    }
    apply(id);
  };

  // Custom is a choice of its own: picking it keeps the numbers and opens them for editing.
  const level: SafetyLevelOrCustom | null = customOpen ? 'custom' : selected;

  const levelRow = (id: SafetyLevelOrCustom, onPress: () => void, last: boolean) => {
    const color = safetyColor(id, c);
    const on = level === id;
    const unavailable = needsZero(id) && !zeroOk;
    return (
      <Pressable
        key={id}
        onPress={onPress}
        disabled={locked || !inForce || unavailable}
        style={({pressed}) => [styles.levelRow, !last && styles.divider, pressed && styles.pressed]}
        accessibilityRole="radio"
        accessibilityState={{selected: on, disabled: locked}}>
        <View style={[styles.dot, {backgroundColor: color}]} />
        <Text style={[styles.levelTitle, (locked || unavailable) && styles.dim]}>{t(SAFETY_TITLE[id])}</Text>
        <View style={styles.flex} />
        {unavailable && !on ? <Text style={styles.needs}>{t('mobile.vault.safety_needs_version', {version: ZERO_ALLOWANCE_SINCE})}</Text> : null}
        {on ? <Text style={[styles.check, {color}]}>✓</Text> : null}
      </Pressable>
    );
  };

  const editable = !locked && level === 'custom';

  // The change already waiting, under the levels: what it lands on and when.
  const waitingNote =
    landsOn && landsAt > now
      ? t('mobile.vault.safety_changing_to', {level: t(SAFETY_TITLE[landsOn]), time: fmtCountdown(landsAt - now, t) ?? ''})
      : undefined;

  return (
    <View style={styles.fill}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        style={styles.container}
        contentContainerStyle={styles.body}>
        {/* First the choice; the three numbers below follow it, and editing one makes it Custom.
            No headings over the two cards: the page is titled Security level, and the rows say
            what they are. */}
        <SettingsGroup footer={locked ? t('mobile.vault.safety_locked') : waitingNote}>
          {SAFETY_LEVELS.map((l) => levelRow(l.id, () => pick(l.id), false))}
          {levelRow('custom', () => !locked && setCustomOpen(true), true)}
        </SettingsGroup>

        <SettingsGroup footer={preview}>
          {RISK_FIELDS.map((f, i) => (
            <SettingsRow
              key={f}
              icon={ICON[f]}
              title={t(RISK_TITLE[f])}
              value={picked ? fmt(f, picked[f]) : undefined}
              sub={sub(f)}
              // Only Custom is edited by hand; a preset level's numbers are shown, not offered.
              onPress={editable ? () => nav.navigate('VaultRiskValue', {field: f}) : undefined}
              chevron={editable}
              last={i === RISK_FIELDS.length - 1}
            />
          ))}
        </SettingsGroup>
        {saveButton}
        {sheet}
      </ScrollView>
      {edge}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    fill: {flex: 1},
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    levelRow: {flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16},
    divider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    pressed: {opacity: 0.7},
    dot: {width: 10, height: 10, borderRadius: 5},
    levelTitle: {color: c.text, fontSize: 16, fontWeight: '600'},
    dim: {color: c.subtext},
    needs: {color: c.subtext, fontSize: 12},
    flex: {flex: 1},
    check: {fontSize: 17, fontWeight: '700'},
    note: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
  });

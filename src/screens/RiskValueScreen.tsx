import React, {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {getRiskConfig, isOpenRiskVersion, needsLimits, riskBoundsFor, updateRiskSettings, useAllowsZeroAllowance, type RiskConfig} from '@/vault/risk';
import {useCapability, useVaultGate} from '@/vault/gate';
import {NO_LIMIT, versionAtLeast} from '@/vault/capabilities';
import {BRIDGE_SINCE} from '@/vault/bridge';
import {LockNotice} from '@/components/LockNotice';
import {OptionRow, SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {PickerSheet} from '@/components/AssetPicker';
import {Button} from '@/components/Button';
import {Sheet} from '@/components/Sheet';
import {InfoIcon} from '@/components/TradeMenu';
import {useVaultWrite} from '@/components/useVaultWrite';
import {RISK_TITLE, fmtCountdown, fmtRiskValue, riskHintKey, riskWhyKey, riskZeroHintKey} from '@/components/riskFormat';
import {PendingRow} from '@/components/PendingRow';
import {pendingValue} from '@/screens/PendingChangesScreen';
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
 * From vault 1.1.1 (deployed as 1.2.0): a timelock of none, allowances up to $1,000,000, and no
 * limit — which is where a new vault starts.
 */
const OPEN_PRESETS = {
  timelock: [0n, ...PRESETS.timelock],
  sendDailyAllowance: [0n, ...PRESETS.sendDailyAllowance, 100_000n, NO_LIMIT],
  marketTradeDailyLossAllowance: [0n, ...PRESETS.marketTradeDailyLossAllowance, 100_000n, NO_LIMIT],
} as const;

type Allowance = 'sendDailyAllowance' | 'marketTradeDailyLossAllowance';
const ALLOWANCES: readonly Allowance[] = ['sendDailyAllowance', 'marketTradeDailyLossAllowance'];
/** The amounts offered for a limit a timelock needs: any number, never no limit. */
const LIMIT_CHOICES = [0n, 100n, 500n, 1_000n, 5_000n, 10_000n, 100_000n, 1_000_000n];

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
  // The daily limits a timelock above none needs, picked on the timelock page (see {limitsNeeded}).
  const [limits, setLimits] = useState<Partial<Record<Allowance, bigint>>>({});
  const [limitPick, setLimitPick] = useState<Allowance | null>(null);
  // A limit row's ⓘ: what that limit is for, as its own page explains it.
  const [limitInfo, setLimitInfo] = useState<Allowance | null>(null);
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
    setLimits({});
    setCustomOpen(false);
    load();
  });

  const isTimelock = field === 'timelock';
  const inForceAll = risk ? valuesInForce(risk) : null;
  const inForce = inForceAll ? inForceAll[field] : null;
  // What the page is set to: the unsaved pick where there is one, otherwise the value in force.
  const current = chosen ?? inForce;
  const vaultVersion = useVaultGate().vaultVersion;
  // From 1.1.1 (deployed as 1.2.0) the timelock may be none and an allowance no limit.
  const open = risk?.open ?? isOpenRiskVersion(vaultVersion);
  // A vault not activated yet is born on a release that takes 0 (and starts with sends at 0).
  // Called on every render: behind `open ||` it was skipped once a 1.2.0 vault loaded, and React
  // crashed on the changed hook count.
  const zeroAllowed = useAllowsZeroAllowance(vault, network);
  const zeroOk = open || ((zeroAllowed || (risk != null && !risk.read)) && !isTimelock);
  const presets: readonly bigint[] = open ? OPEN_PRESETS[field] : zeroOk ? [0n, ...PRESETS[field]] : PRESETS[field];
  const known = riskBoundsFor(open ? '1.1.1' : null, field);
  const bounds = {min: zeroOk ? 0n : known.min, max: known.max};
  // A 1.1.0 vault's loss limit also covers bridges, and its explanations say so.
  const bridges = versionAtLeast(vaultVersion, BRIDGE_SINCE);
  const zeroHint = zeroOk ? riskZeroHintKey(field, bridges) : null;
  const isCustom = current != null && !presets.includes(current);
  // A lock freezes these too, so nothing can be picked rather than signed and refused on chain.
  const gate = useCapability('updateRisk');
  const locked = !gate.allowed;
  const canPick = !locked && risk != null && busy === null;
  // The window lives here, on the choices, rather than in the setting's name: "$500 per 24 hours".
  const fmt = (v: bigint) =>
    isTimelock || v === 0n || v === NO_LIMIT ? fmtRiskValue(field, v, t) : t('mobile.vault.per_24h', {value: fmtRiskValue(field, v, t)});

  // Picking the value in force again clears the pick rather than offering a no-op save.
  const pick = (value: bigint) => setChosen(value === inForce ? null : value);

  const customValue = (): bigint | null => {
    const n = Number(custom);
    if (custom.trim() === '' || !Number.isFinite(n) || n < 0) return null;
    const v = isTimelock ? BigInt(Math.round(n * Number(HOUR))) : BigInt(Math.floor(n));
    // Outside the bounds the vault would refuse it, so it cannot be picked.
    if (v < bounds.min || v > bounds.max) return null;
    // A timelock is none or at least a day (RiskTimelockTooShort).
    if (isTimelock && v > 0n && v < DAY) return null;
    return v;
  };
  const parsed = customValue();
  const customOff = !canPick || parsed == null || parsed === current;

  // The accepted range, in the unit typed: hours for the timelock, whole USD for the allowances.
  const range = isTimelock
    ? open
      ? `0, ${Number(DAY / HOUR)}–${Number(bounds.max / HOUR)}`
      : `${Number(bounds.min / HOUR)}–${Number(bounds.max / HOUR)}`
    : `${Number(bounds.min).toLocaleString()}–${Number(bounds.max).toLocaleString()}`;
  const unit = isTimelock ? t('vault.time_unit.hours') : 'USD';

  // When the pick would land: at once when it is stricter (or the vault is not activated yet, where
  // it is written at creation), otherwise after the timelock in force now.
  const dirty = chosen != null && inForce != null && chosen !== inForce;
  // With no timelock in force (a 1.2.0 vault's start) a loosening has nothing to wait out.
  const loosens = dirty && risk!.read && isLoosening(field, inForce!, chosen!) && inForceAll!.timelock > 0n;
  const effectAt = inForceAll ? now + Number(inForceAll.timelock) : 0;
  const applies = !dirty
    ? undefined
    : loosens
      ? t('mobile.vault.safety_applies_later', {date: new Date(effectAt * 1000).toLocaleString(), time: fmtCountdown(effectAt - now, t) ?? ''})
      : isTimelock
        ? undefined // the timelock page says nothing for a change that applies at once
        : t('mobile.vault.safety_applies_now');

  // A change to this number already waiting out the timelock: first on the page, as the Pending page
  // draws it, with Cancel (writing the value in force back, which is how the vault cancels one).
  const waiting = risk?.pending[field];
  const cancel = () =>
    run('cancel', t('mobile.vault.cancel_change'), async (b) => {
      const r = await getRiskConfig(b.vault, b.network);
      if (!r.read) throw new Error(t('mobile.vault.cancel_change_unread'));
      return updateRiskSettings({...b, changes: {[field]: r[field]}});
    });

  // Above none, a timelock needs both allowances to be amounts — what they are headed to, a
  // loosening still waiting included — or the vault refuses the write (TimelockNeedsLimits).
  const headed =
    risk && inForceAll
      ? {
          timelock: risk.pending.timelock?.value ?? inForceAll.timelock,
          sendDailyAllowance: risk.pending.sendDailyAllowance?.value ?? inForceAll.sendDailyAllowance,
          marketTradeDailyLossAllowance: risk.pending.marketTradeDailyLossAllowance?.value ?? inForceAll.marketTradeDailyLossAllowance,
        }
      : null;
  /**
   * On the timelock page: the limits still at no limit that a timelock above none needs. They are
   * picked here and written with the timelock in the same updateRisk — the vault checks the rule after
   * all three are set, and from no limit each is a tightening, so it all applies at once.
   */
  const limitsNeeded: Allowance[] =
    open && isTimelock && dirty && headed != null && chosen! > 0n ? ALLOWANCES.filter((f) => headed[f] === NO_LIMIT) : [];
  const picked = Object.fromEntries(limitsNeeded.flatMap((f) => (limits[f] != null ? [[f, limits[f]!]] : []))) as Partial<Record<Allowance, bigint>>;
  // On a limit's page: no limit under a timelock above none takes the timelock to none in the same
  // write (both loosen, so both wait out the timelock in force; the vault checks what they head to).
  const clearsTimelock = open && !isTimelock && dirty && chosen === NO_LIMIT && headed != null && headed.timelock > 0n;
  const refusedForLimits =
    open && dirty && headed != null && needsLimits({...headed, ...picked, [field]: chosen!, ...(clearsTimelock ? {timelock: 0n} : {})});
  const fmtLimit = (f: Allowance, v: bigint) => (v === 0n ? fmtRiskValue(f, v, t) : t('mobile.vault.per_24h', {value: fmtRiskValue(f, v, t)}));

  const save = () =>
    chosen != null &&
    run('save', t(RISK_TITLE[field]), (b) =>
      updateRiskSettings({...b, changes: {[field]: chosen, ...picked, ...(clearsTimelock ? {timelock: 0n} : {})}}),
    );

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
        {waiting && risk ? (
          <SettingsGroup label={t('mobile.vault.pending_timelock')}>
            <PendingRow
              at={Number(waiting.at)}
              now={now}
              timelock={Number(risk.timelock)}
              title={t(RISK_TITLE[field])}
              value={pendingValue({kind: field, value: waiting.value, at: waiting.at, from: inForce ?? undefined}, t)}
              onCancel={locked ? undefined : cancel}
              cancelling={busy === 'cancel'}
              cancelDisabled={!ready || busy !== null}
              onMatured={load}
              last
            />
          </SettingsGroup>
        ) : null}
        <SettingsGroup>
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
        {limitsNeeded.length > 0 ? (
          <>
            <SettingsGroup label={t('mobile.vault.timelock_set_limits')}>
              {limitsNeeded.map((f, i) => (
                <SettingsRow
                  key={f}
                  icon={f === 'sendDailyAllowance' ? 'sendNew' : 'dailyLimit'}
                  title={t(RISK_TITLE[f])}
                  value={limits[f] != null ? fmtLimit(f, limits[f]!) : t('mobile.vault.choose_amount')}
                  onPress={canPick ? () => setLimitPick(f) : undefined}
                  info={() => setLimitInfo(f)}
                  last={i === limitsNeeded.length - 1}
                />
              ))}
            </SettingsGroup>
          </>
        ) : null}
        <Sheet visible={limitInfo !== null} title={limitInfo ? t(RISK_TITLE[limitInfo]) : ''} onClose={() => setLimitInfo(null)}>
          {limitInfo ? (
            <View style={styles.explain}>
              <Text style={styles.explainText}>{t(riskWhyKey(limitInfo, bridges))}</Text>
              <Text style={styles.explainSub}>{t(riskHintKey(limitInfo, bridges, open))}</Text>
            </View>
          ) : null}
        </Sheet>
        <PickerSheet
          visible={limitPick !== null}
          title={limitPick ? t(RISK_TITLE[limitPick]) : ''}
          items={LIMIT_CHOICES.map((v) => ({key: String(v), label: limitPick ? fmtLimit(limitPick, v) : ''}))}
          selected={limitPick && limits[limitPick] != null ? String(limits[limitPick]) : undefined}
          onSelect={(k) => limitPick && setLimits((l) => ({...l, [limitPick]: BigInt(k)}))}
          onClose={() => setLimitPick(null)}
        />
        <View style={styles.saveArea}>
          {clearsTimelock ? <Text style={styles.applies}>{t('mobile.vault.no_limit_clears_timelock')}</Text> : null}
          {refusedForLimits && limitsNeeded.length === 0 ? (
            <Text style={styles.applies}>{t('mobile.vault.timelock_needs_limits')}</Text>
          ) : applies ? (
            <Text style={styles.applies}>{applies}</Text>
          ) : null}
          <Button title={t('vault.save')} onPress={save} loading={busy === 'save'} disabled={!dirty || !ready || refusedForLimits} locked={locked} />
        </View>
        {sheet}
        {/* What this number is for, put as what it protects against, then its rules and what $0
            does: opened from the ⓘ in the header. */}
        <Sheet visible={explainOpen} title={t(RISK_TITLE[field])} onClose={() => setExplainOpen(false)}>
          <View style={styles.explain}>
            <Text style={styles.explainText}>{t(riskWhyKey(field, bridges))}</Text>
            <Text style={styles.explainSub}>{t(riskHintKey(field, bridges, open))}</Text>
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
    saveArea: {gap: 10},
    applies: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4, textAlign: 'center'},
  });

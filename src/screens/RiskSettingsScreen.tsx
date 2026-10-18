import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, usePreventRemove} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getLockLevel, getRiskConfig, updateRiskSettings, type LockLevel, type RiskConfig, type RiskField} from '@/vault/risk';
import {useRiskDraft} from '@/core/risk-draft';
import {useVaultWrite} from '@/components/useVaultWrite';
import {Button} from '@/components/Button';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {RISK_TITLE, fmtCountdown, fmtPending, fmtRiskValue, riskHintKey} from '@/components/riskFormat';
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
import {ownerVaultAddress} from '@/vault/read';
import {useAssetCatalog} from '@/core/asset-catalog';
import {isLegacy} from '@/core/vault-generation';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

const ICON = {timelock: 'timelock', sendDailyAllowance: 'dailyLimit', marketTradeDailyLossAllowance: 'dailyLimit'} as const;


/**
 * Safety settings (Security › Safety settings).
 *
 * On v1.0.0+ the page is a choice of safety level — Maximum, Balanced, Standard — each a card that
 * spells out its three numbers in full, and Custom for any other values, which opens the three
 * number rows. Picking a level fills all three into the draft; Save writes every changed number in
 * ONE transaction, and leaving with changes unsaved asks whether to discard them.
 *
 * Before saving, the page says when the change lands: a stricter level applies at once, a looser one
 * waits out the timelock in force now. A change already waiting shows on the vault's current card,
 * counting down to the second. Maximum asks first, since leaving it later takes a week. A locked
 * vault cannot change any of it, so the cards are shown but cannot be picked.
 *
 * v1.0.3 has no levels: its rules are different (0 turns a number off, there is no trade-loss
 * allowance), so it keeps the plain number rows.
 */
export function RiskSettingsScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const symbol = useAssetCatalog(network).find((a) => a.kind === 'stable')?.symbol;
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const [lockLevel, setLockLevel] = useState<LockLevel | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const changes = useRiskDraft((s) => s.changes);
  const setDraft = useRiskDraft((s) => s.set);
  const clearDraft = useRiskDraft((s) => s.clear);
  const dirty = Object.keys(changes).length > 0;

  const load = useCallback(() => {
    if (!vault) return;
    getRiskConfig(vault, network).then(setRisk);
    getLockLevel(vault, network).then(setLockLevel);
  }, [vault, network]);

  const {busy, ready, run, sheet} = useVaultWrite(() => {
    clearDraft();
    load();
  });

  // A draft belongs to one visit: whatever way the page goes, it does not survive it.
  useEffect(() => clearDraft, [clearDraft]);

  // Leaving with changes unsaved asks first, whether by the back button or the swipe. usePreventRemove
  // rather than a bare beforeRemove listener: on the native stack only the hook stops the native back
  // button and swipe up front, where the listener heard of the pop after the page had already gone.
  usePreventRemove(dirty && !busy, ({data}) =>
    Alert.alert(t('mobile.vault.discard_title'), t('mobile.vault.discard_msg'), [
      {text: t('mobile.vault.keep_editing'), style: 'cancel'},
      {text: t('mobile.vault.discard'), style: 'destructive', onPress: () => nav.dispatch(data.action)},
    ]),
  );

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

  const legacy = risk ? !risk.hasLocks : isLegacy();
  const fmt = (f: RiskField, v: bigint) => fmtRiskValue(f, v, risk, symbol, t);

  /** The row's value — the unsaved pick where there is one — and its second line. */
  const shown = (f: RiskField) => {
    const v = changes[f] ?? risk?.[f];
    return v === undefined ? undefined : fmt(f, v);
  };
  const sub = (f: RiskField) =>
    changes[f] !== undefined && risk ? t('mobile.vault.unsaved_from', {value: fmt(f, risk[f])}) : fmtPending(f, risk, symbol, t);

  const numberRows = (bounded: boolean) =>
    RISK_FIELDS.filter((f) => bounded || f !== 'marketTradeDailyLossAllowance').map((f) => (
      <SettingsGroup key={f} footer={t(riskHintKey(f, bounded))}>
        <SettingsRow
          icon={ICON[f]}
          title={t(RISK_TITLE[f])}
          value={shown(f)}
          sub={sub(f)}
          onPress={() => nav.navigate('VaultRiskValue', {field: f})}
          last
        />
      </SettingsGroup>
    ));

  const saveButton = <Button title={t('vault.save')} onPress={save} loading={busy === 'save'} disabled={!dirty || !ready} />;

  if (legacy) {
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        style={styles.container}
        contentContainerStyle={styles.body}>
        {numberRows(false)}
        {saveButton}
        {sheet}
      </ScrollView>
    );
  }

  const inForce = risk ? valuesInForce(risk) : null;
  const picked: RiskValues | null = inForce
    ? {
        timelock: changes.timelock ?? inForce.timelock,
        sendDailyAllowance: changes.sendDailyAllowance ?? inForce.sendDailyAllowance,
        marketTradeDailyLossAllowance: changes.marketTradeDailyLossAllowance ?? inForce.marketTradeDailyLossAllowance,
      }
    : null;
  const selected: SafetyLevelOrCustom | null = picked ? levelOf(picked) : null;
  const current: SafetyLevelOrCustom | null = inForce ? levelOf(inForce) : null;
  const locked = lockLevel === 1 || lockLevel === 2;

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
    if (locked || !inForce || selected === id) return;
    if (id !== 'maximum') return apply(id);
    Alert.alert(t('mobile.vault.safety_maximum_confirm_title'), t('mobile.vault.safety_maximum_confirm_msg'), [
      {text: t('common.cancel'), style: 'cancel'},
      {text: t('mobile.vault.safety_switch'), onPress: () => apply(id)},
    ]);
  };

  const valueRows = (v: RiskValues) =>
    RISK_FIELDS.map((f) => (
      <View key={f} style={styles.valueRow}>
        <Text style={styles.valueName} numberOfLines={1}>
          {t(RISK_TITLE[f])}
        </Text>
        <Text style={styles.valueNum}>{fmt(f, v[f])}</Text>
      </View>
    ));

  const card = (id: SafetyLevelOrCustom, values: RiskValues | null, onPress: () => void, recommended?: boolean) => {
    const color = safetyColor(id, c);
    const isSelected = selected === id;
    return (
      <Pressable
        key={id}
        onPress={onPress}
        disabled={locked || !inForce}
        style={({pressed}) => [styles.card, isSelected && {borderColor: color}, pressed && styles.pressed]}
        accessibilityRole="radio"
        accessibilityState={{selected: isSelected, disabled: locked}}>
        <View style={styles.cardHead}>
          <View style={[styles.dot, {backgroundColor: color}]} />
          <Text style={[styles.cardTitle, locked && styles.dim]}>{t(SAFETY_TITLE[id])}</Text>
          {recommended ? (
            <View style={styles.tag}>
              <Text style={styles.tagText}>{t('mobile.vault.safety_recommended')}</Text>
            </View>
          ) : null}
          {id === 'custom' ? <Text style={styles.cardSub}>{t('mobile.vault.safety_custom_sub')}</Text> : null}
          <View style={styles.flex} />
          {isSelected ? <Text style={[styles.check, {color}]}>✓</Text> : id === 'custom' ? <Text style={styles.chev}>›</Text> : null}
        </View>
        {values ? valueRows(values) : null}
        {id === current && landsOn && landsAt > now ? (
          <Text style={styles.waiting}>
            {t('mobile.vault.safety_changing_to', {level: t(SAFETY_TITLE[landsOn]), time: fmtCountdown(landsAt - now, t) ?? ''})}
          </Text>
        ) : null}
      </Pressable>
    );
  };

  const showNumbers = customOpen || selected === 'custom';

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <View style={styles.cards}>
        {SAFETY_LEVELS.map((l) => card(l.id, l.values, () => pick(l.id), l.recommended))}
        {card('custom', picked, () => !locked && setCustomOpen(true))}
        {locked ? <Text style={styles.note}>{t('mobile.vault.safety_locked')}</Text> : null}
      </View>
      {showNumbers ? numberRows(true) : null}
      {preview ? <Text style={styles.note}>{preview}</Text> : null}
      {saveButton}
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    cards: {gap: 12},
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 8, borderWidth: 2, borderColor: 'transparent'},
    pressed: {opacity: 0.7},
    cardHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
    dot: {width: 10, height: 10, borderRadius: 5},
    cardTitle: {color: c.text, fontSize: 16, fontWeight: '700'},
    cardSub: {color: c.subtext, fontSize: 13},
    dim: {color: c.subtext},
    tag: {backgroundColor: c.accentSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2},
    tagText: {color: c.accent, fontSize: 11, fontWeight: '700'},
    flex: {flex: 1},
    check: {fontSize: 17, fontWeight: '700'},
    chev: {color: c.subtext, fontSize: 22, fontWeight: '300'},
    valueRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingLeft: 18},
    valueName: {color: c.subtext, fontSize: 13, flexShrink: 1},
    valueNum: {color: c.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
    waiting: {color: c.accent, fontSize: 12, fontWeight: '600', paddingLeft: 18, fontVariant: ['tabular-nums']},
    note: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
  });

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {SettingsGroup} from '@/components/SettingsRow';
import {GuardLevelRows, GuardParams, type GuardChoice} from '@/components/GuardLevelRows';
import {PickerSheet} from '@/components/AssetPicker';
import {NetworkFee} from '@/components/NetworkFee';
import {Button} from '@/components/Button';
import {useVaultWrite} from '@/components/useVaultWrite';
import {RISK_TITLE, fmtRiskValue} from '@/components/riskFormat';
import {GUARD_LEVELS, guardLevelOf, sameGuardValues, type GuardValues} from '@/core/new-vault-defaults';
import {valuesInForce} from '@/core/safety-levels';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useNetwork} from '@/core/network-store';
import {getRiskConfig, needsLimits, updateRiskSettings} from '@/vault/risk';
import {NO_LIMIT} from '@/vault/capabilities';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

const DAY = 86_400n;
/** Custom's choices: the timelock (none, or 1–30 days) and the amounts a daily limit may be. */
const CHOICES: Record<keyof GuardValues, bigint[]> = {
  timelock: [0n, DAY, 3n * DAY, 7n * DAY, 14n * DAY, 30n * DAY],
  sendDailyAllowance: [0n, 100n, 500n, 1_000n, 5_000n, 10_000n, 100_000n, 1_000_000n, NO_LIMIT],
  marketTradeDailyLossAllowance: [0n, 100n, 500n, 1_000n, 5_000n, 10_000n, 100_000n, 1_000_000n, NO_LIMIT],
};

/**
 * Guard › Guard level: Basic, Standard, Maximum or Custom. The choice's timelock and both daily
 * limits show below it — Custom's set row by row — and Confirm writes all three in one change, with
 * its network fee above. Raising them applies at once; a loosening waits out the timelock in force.
 */
export function GuardLevelScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const [now, setNow] = useState<GuardValues | null>(null);
  const [choice, setChoice] = useState<GuardChoice | null>(null);
  const [custom, setCustom] = useState<GuardValues | null>(null);
  const [editing, setEditing] = useState<keyof GuardValues | null>(null);
  /**
   * What Confirm sent, until the chain shows it — in force, or waiting out the timelock. Until then
   * a re-read (the write's own, or coming back to the page) keeps the choice on screen, with a
   * spinner in place of its mark, rather than snapping back to the level still in force.
   */
  const sent = useRef<{choice: GuardChoice; values: GuardValues} | null>(null);
  const [sending, setSending] = useState<GuardChoice | null>(null);
  const load = useCallback(() => {
    if (!vault) return;
    getRiskConfig(vault, network).then((r) => {
      if (!r.read) return;
      const v = valuesInForce(r);
      const values = {timelock: v.timelock, sendDailyAllowance: v.sendDailyAllowance, marketTradeDailyLossAllowance: v.marketTradeDailyLossAllowance};
      const headed = {
        timelock: r.pending.timelock?.value ?? values.timelock,
        sendDailyAllowance: r.pending.sendDailyAllowance?.value ?? values.sendDailyAllowance,
        marketTradeDailyLossAllowance: r.pending.marketTradeDailyLossAllowance?.value ?? values.marketTradeDailyLossAllowance,
      };
      setNow(values);
      if (sent.current && !sameGuardValues(headed, sent.current.values)) return; // not on chain yet
      sent.current = null;
      setSending(null);
      setChoice(guardLevelOf(values));
      setCustom(values);
    });
  }, [vault, network]);
  // While a change is on its way, read again every few seconds until it lands.
  useEffect(() => {
    if (sending == null) return;
    const id = setInterval(load, 3000);
    const stop = setTimeout(() => {
      sent.current = null;
      setSending(null);
      load();
    }, 120_000);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, [sending, load]);
  useFocusEffect(load);
  const {busy, ready, run, sheet} = useVaultWrite(load);

  // Custom starts from the level last chosen, so it is a tweak of what was on screen, not a reset.
  const pickChoice = (next: GuardChoice) => {
    if (next === 'custom' && choice != null && choice !== 'custom') setCustom(GUARD_LEVELS[choice]);
    setChoice(next);
  };
  const want = choice == null ? null : choice === 'custom' ? custom : GUARD_LEVELS[choice];
  const changed = want != null && now != null && !sameGuardValues(want, now);
  // Above none, a timelock needs both limits to be amounts: the vault refuses the mix otherwise.
  const refused = want != null && needsLimits(want);
  const confirm = () =>
    want &&
    choice != null &&
    run('level', t('mobile.vault.change_guard_config'), async (b) => {
      const hash = await updateRiskSettings({...b, changes: want});
      sent.current = {choice, values: want};
      setSending(choice);
      return hash;
    });

  return (
    <View style={styles.fill}>
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
        <SettingsGroup>
          <GuardLevelRows selected={choice} onSelect={pickChoice} custom={custom ?? GUARD_LEVELS[0]} disabled={!now || busy != null || sending != null} loading={busy === 'level' ? choice : sending} />
        </SettingsGroup>
        {want ? <GuardParams values={want} onEdit={choice === 'custom' ? setEditing : undefined} /> : null}
        {refused ? <Text style={[styles.note, {color: c.danger}]}>{t('mobile.vault.timelock_needs_limits')}</Text> : null}
        <View style={styles.confirmArea}>
          {changed && !refused ? <NetworkFee /> : null}
          <Button title={t('vault.confirm')} onPress={confirm} loading={busy === 'level' || sending != null} disabled={!changed || refused || !ready || sending != null} />
        </View>
      </ScrollView>
      <PickerSheet
        visible={editing !== null}
        title={editing ? t(RISK_TITLE[editing]) : ''}
        items={editing ? CHOICES[editing].map((v) => ({key: String(v), label: fmtRiskValue(editing, v, t)})) : []}
        selected={editing && custom ? String(custom[editing]) : undefined}
        onSelect={(k) => editing && setCustom((v) => (v ? {...v, [editing]: BigInt(k)} : v))}
        onClose={() => setEditing(null)}
      />
      {sheet}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    fill: {flex: 1, backgroundColor: c.bg},
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    note: {fontSize: 13, lineHeight: 19, paddingHorizontal: 4, marginTop: -8},
    confirmArea: {gap: 10},
  });

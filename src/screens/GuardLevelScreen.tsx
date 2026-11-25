import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {SettingsGroup} from '@/components/SettingsRow';
import {GuardLevelRows, type GuardChoice} from '@/components/GuardLevelRows';
import {NetworkFee} from '@/components/NetworkFee';
import {Button} from '@/components/Button';
import {useVaultWrite} from '@/components/useVaultWrite';
import {GUARD_LEVELS, guardLevelOf, sameGuardValues, type GuardValues} from '@/core/new-vault-defaults';
import {valuesInForce} from '@/core/safety-levels';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useNetwork} from '@/core/network-store';
import {getRiskConfig, needsLimits, updateRiskSettings} from '@/vault/risk';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * A change the Custom page sent, until the chain shows it: this page keeps Custom on screen with a
 * spinner, as it does for a level confirmed here, rather than snapping back to the level in force.
 */
let customSent: GuardValues | null = null;
export const noteCustomSent = (values: GuardValues) => {
  customSent = values;
};

/**
 * Guard › Guard level: None, Low, Basic, High, Highest, or Custom. The chosen level shows its
 * timelock and both daily limits under its name, and Confirm writes all three in one change, with
 * its network fee above. Custom opens its own page to set the three. Raising them applies at once;
 * a loosening waits out the timelock in force.
 */
export function GuardLevelScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const [now, setNow] = useState<GuardValues | null>(null);
  const [choice, setChoice] = useState<GuardChoice | null>(null);
  /**
   * What Confirm sent, until the chain shows it — in force, or waiting out the timelock. Until then
   * a re-read (the write's own, or coming back to the page) keeps the choice on screen, with a
   * spinner in place of its mark, rather than snapping back to the level still in force.
   */
  const sent = useRef<{choice: GuardChoice; values: GuardValues} | null>(null);
  const [sending, setSending] = useState<GuardChoice | null>(null);
  const load = useCallback(() => {
    if (!vault) return;
    if (customSent) {
      sent.current = {choice: 'custom', values: customSent};
      customSent = null;
      setChoice('custom');
      setSending('custom');
    }
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

  // Custom's row shows the values in force, or the ones on their way from the Custom page.
  const customValues = sending === 'custom' && sent.current ? sent.current.values : now ?? GUARD_LEVELS[0];
  const want = choice == null || choice === 'custom' ? null : GUARD_LEVELS[choice];
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
          <GuardLevelRows
            selected={choice}
            onSelect={setChoice}
            onCustom={() => nav.navigate('GuardCustom')}
            custom={customValues}
            disabled={!now || busy != null || sending != null}
            loading={busy === 'level' ? choice : sending}
          />
        </SettingsGroup>
        {refused ? <Text style={[styles.note, {color: c.danger}]}>{t('mobile.vault.timelock_needs_limits')}</Text> : null}
        <View style={styles.confirmArea}>
          {changed && !refused ? <NetworkFee /> : null}
          <Button title={t('vault.confirm')} onPress={confirm} loading={busy === 'level' || sending != null} disabled={!changed || refused || !ready || sending != null} />
        </View>
      </ScrollView>
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

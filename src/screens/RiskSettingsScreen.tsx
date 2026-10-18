import React, {useCallback, useEffect, useState} from 'react';
import {Alert, ScrollView, StyleSheet} from 'react-native';
import {useFocusEffect, useNavigation, usePreventRemove} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getRiskConfig, updateRiskSettings, type RiskConfig, type RiskField} from '@/vault/risk';
import {useRiskDraft} from '@/core/risk-draft';
import {useVaultWrite} from '@/components/useVaultWrite';
import {Button} from '@/components/Button';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {fmtPending, fmtRiskValue} from '@/components/riskFormat';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {useAssetCatalog} from '@/core/asset-catalog';
import {isLegacy} from '@/core/vault-generation';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * Risk settings (Security › Risk settings) — the vault's risk numbers, one card each with what it
 * does written under it and its value on the right: the timelock, the daily send allowance, and the
 * market-trade daily loss allowance. The two allowances are separate ceilings — trading never uses
 * up what may be sent. Each row pushes a page that picks the new value (see {RiskValueScreen}) into a
 * draft; Save writes every changed field in ONE transaction, and leaving with changes unsaved asks
 * whether to discard them. A loosening still waiting out the timelock shows on the row's second line
 * with the day it applies.
 *
 * On v1.0.3 the send allowance is `maxSendValue`, in stablecoin tokens over the vault's own window,
 * and there is no market-trade allowance, so that card is left out.
 */
export function RiskSettingsScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const symbol = useAssetCatalog(network).find((a) => a.kind === 'stable')?.symbol;
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const changes = useRiskDraft((s) => s.changes);
  const clearDraft = useRiskDraft((s) => s.clear);
  const dirty = Object.keys(changes).length > 0;
  const {busy, ready, run, sheet} = useVaultWrite(() => {
    clearDraft();
    if (vault) getRiskConfig(vault, network).then(setRisk);
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

  const save = () =>
    run('save', t('mobile.vault.risk_settings'), (b) => updateRiskSettings({...b, changes}));

  // Re-read on focus: the value pages write, and the new value has to show on the way back.
  useFocusEffect(
    useCallback(() => {
      if (vault) getRiskConfig(vault, network).then(setRisk);
    }, [vault, network]),
  );

  const legacy = risk ? !risk.hasLocks : isLegacy();

  /** The row's value — the unsaved pick where there is one — and its second line. */
  const shown = (f: RiskField) => {
    const v = changes[f] ?? risk?.[f];
    return v === undefined ? undefined : fmtRiskValue(f, v, risk, symbol, t);
  };
  const sub = (f: RiskField) =>
    changes[f] !== undefined && risk
      ? t('mobile.vault.unsaved_from', {value: fmtRiskValue(f, risk[f], risk, symbol, t)})
      : fmtPending(f, risk, symbol, t);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup footer={t('mobile.vault.change_timelock_hint')}>
        <SettingsRow
          icon="timelock"
          title={t('mobile.vault.change_timelock')}
          value={shown('timelock')}
          sub={sub('timelock')}
          onPress={() => nav.navigate('VaultRiskValue', {field: 'timelock'})}
          last
        />
      </SettingsGroup>
      <SettingsGroup footer={t('mobile.vault.send_daily_allowance_hint')}>
        <SettingsRow
          icon="dailyLimit"
          title={t('mobile.vault.send_daily_allowance')}
          value={shown('sendDailyAllowance')}
          sub={sub('sendDailyAllowance')}
          onPress={() => nav.navigate('VaultRiskValue', {field: 'sendDailyAllowance'})}
          last
        />
      </SettingsGroup>
      {legacy ? null : (
        <SettingsGroup footer={t('mobile.vault.market_trade_loss_allowance_hint')}>
          <SettingsRow
            icon="dailyLimit"
            title={t('mobile.vault.market_trade_loss_allowance')}
            value={shown('marketTradeDailyLossAllowance')}
            sub={sub('marketTradeDailyLossAllowance')}
            onPress={() => nav.navigate('VaultRiskValue', {field: 'marketTradeDailyLossAllowance'})}
            last
          />
        </SettingsGroup>
      )}
      <Button title={t('vault.save')} onPress={save} loading={busy === 'save'} disabled={!dirty || !ready} />
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
  });

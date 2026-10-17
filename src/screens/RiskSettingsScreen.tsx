import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getRiskConfig, type RiskConfig} from '@/vault/risk';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {fmtDuration, fmtAllowance, fmtLossAllowance, fmtPending} from '@/components/riskFormat';
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
 * up what may be sent. Each row pushes a page that picks the new value (see {RiskValueScreen}). A
 * loosening still waiting out the timelock shows on the row's second line with the day it applies.
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

  // Re-read on focus: the value pages write, and the new value has to show on the way back.
  useFocusEffect(
    useCallback(() => {
      if (vault) getRiskConfig(vault, network).then(setRisk);
    }, [vault, network]),
  );

  const legacy = risk ? !risk.hasLocks : isLegacy();

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
          value={risk ? fmtDuration(risk.timelock, t) : undefined}
          sub={fmtPending('timelock', risk, symbol, t)}
          onPress={() => nav.navigate('VaultRiskValue', {field: 'timelock'})}
          last
        />
      </SettingsGroup>
      <SettingsGroup footer={t('mobile.vault.send_daily_allowance_hint')}>
        <SettingsRow
          icon="dailyLimit"
          title={t('mobile.vault.send_daily_allowance')}
          value={risk ? fmtAllowance(risk.sendDailyAllowance, risk, symbol, t) : undefined}
          sub={fmtPending('sendDailyAllowance', risk, symbol, t)}
          onPress={() => nav.navigate('VaultRiskValue', {field: 'sendDailyAllowance'})}
          last
        />
      </SettingsGroup>
      {legacy ? null : (
        <SettingsGroup footer={t('mobile.vault.market_trade_loss_allowance_hint')}>
          <SettingsRow
            icon="dailyLimit"
            title={t('mobile.vault.market_trade_loss_allowance')}
            value={risk ? fmtLossAllowance(risk.marketTradeDailyLossAllowance, t) : undefined}
            sub={fmtPending('marketTradeDailyLossAllowance', risk, symbol, t)}
            onPress={() => nav.navigate('VaultRiskValue', {field: 'marketTradeDailyLossAllowance'})}
            last
          />
        </SettingsGroup>
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
  });

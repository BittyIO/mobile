import React, {useCallback, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getPendingChanges, type PendingChange} from '@/vault/risk';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import type {SettingsIconName} from '@/components/SettingsIcon';
import {RISK_TITLE, fmtRiskValue} from '@/components/riskFormat';
import {fmtPerms} from '@/components/useAssetManagerRow';
import {shortAddress} from '@/core/format';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

type T = ReturnType<typeof useT>['t'];

const ICON: Record<PendingChange['kind'], SettingsIconName> = {
  timelock: 'timelock',
  sendDailyAllowance: 'dailyLimit',
  marketTradeDailyLossAllowance: 'dailyLimit',
  gasBudgetDaily: 'stableCoinAsGas',
  maxFeePerOp: 'stableCoinAsGas',
  newOwner: 'security',
  newAssetManager: 'delegation',
  whitelistAdd: 'allowlist',
  whitelistRemove: 'allowlist',
};

function title(p: PendingChange, t: T): string {
  switch (p.kind) {
    case 'timelock':
    case 'sendDailyAllowance':
    case 'marketTradeDailyLossAllowance':
      return t(RISK_TITLE[p.kind]);
    case 'gasBudgetDaily':
      return t('mobile.vault.pending_gas_budget');
    case 'maxFeePerOp':
      return t('mobile.vault.pending_max_fee');
    case 'newOwner':
      return t('mobile.vault.pending_new_owner');
    case 'newAssetManager':
      return t('mobile.vault.pending_new_asset_manager');
    case 'whitelistAdd':
      return t('mobile.vault.pending_whitelist_add');
    case 'whitelistRemove':
      return t('mobile.vault.pending_whitelist_remove');
  }
}

function value(p: PendingChange, t: T): string {
  switch (p.kind) {
    case 'timelock':
    case 'sendDailyAllowance':
    case 'marketTradeDailyLossAllowance':
      return fmtRiskValue(p.kind, p.value, null, undefined, t);
    case 'gasBudgetDaily':
    case 'maxFeePerOp':
      // Whole dollars, as the contract stores them.
      return `$${Number(p.value).toLocaleString()}`;
    default:
      return shortAddress(p.address);
  }
}

/**
 * Overview › Pending — everything the vault has been told to do and has not done yet: a loosened
 * risk number, a handover, an asset-manager grant, an address-book entry maturing or leaving. Each
 * shows when it takes effect, because that is the owner's window to lock the vault if they did not
 * ask for it — which the footer row goes straight to.
 */
export function PendingChangesScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const [items, setItems] = useState<PendingChange[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (vault) getPendingChanges(vault, network).then(setItems);
    }, [vault, network]),
  );

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      {items === null ? (
        <ActivityIndicator />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>{t('mobile.vault.pending_none')}</Text>
      ) : (
        <SettingsGroup>
          {items.map((p, i) => {
            const when = new Date(Number(p.at) * 1000).toLocaleString();
            const perms = p.kind === 'newAssetManager' ? ` · ${fmtPerms(p.perms, t)}` : '';
            return (
              <SettingsRow
                key={`${p.kind}:${'address' in p ? p.address : ''}:${p.at}`}
                icon={ICON[p.kind]}
                title={title(p, t)}
                value={value(p, t)}
                sub={t('mobile.vault.applies', {when: t('mobile.vault.on_date', {date: when})}) + perms}
                chevron={false}
                last={i === items.length - 1}
              />
            );
          })}
        </SettingsGroup>
      )}
      <SettingsGroup footer={t('mobile.vault.pending_lock_hint')}>
        <SettingsRow icon="lock" title={t('mobile.vault.vault_lock')} onPress={() => nav.navigate('VaultLock')} last />
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    empty: {color: c.subtext, fontSize: 15, textAlign: 'center', marginTop: 24},
  });

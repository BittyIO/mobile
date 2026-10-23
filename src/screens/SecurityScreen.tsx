import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {getLockLevel, getRiskConfig, type LockLevel} from '@/vault/risk';
import {SAFETY_TITLE, levelOf, valuesInForce, type SafetyLevelOrCustom} from '@/core/safety-levels';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {LOCK_ICON, LOCK_TITLE} from '@/core/lock-status';

/**
 * Security — three groups of rows, each opening what it names: Safety settings (the timelock and the
 * two daily allowances, with the vault's safety level beside it on v1.0.0+); the allow list and the asset manager;
 * Lock status (temporarily / forever locked), the recovery phrase and Transfer ownership. The writes live on
 * the pages the rows open.
 */
export function SecurityScreen() {
  const {t} = useT();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const styles = useStyles(makeStyles);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);

  // The lock state answers the Vault lock row. Re-read on focus: the row's own page changes it.
  const [lockLevel, setLockLevel] = useState<LockLevel | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (vault) getLockLevel(vault, network).then(setLockLevel);
    }, [vault, network]),
  );
  // The safety level answers the Safety settings row.
  const [level, setLevel] = useState<SafetyLevelOrCustom | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!vault) return;
      getRiskConfig(vault, network).then((r) => setLevel(levelOf(valuesInForce(r))));
    }, [vault, network]),
  );
  // Both rows answer with plain text on the right, as every other settings row does.
  const levelValue = level == null ? undefined : t(SAFETY_TITLE[level]);

  const lockValue = lockLevel == null ? undefined : t(LOCK_TITLE[lockLevel]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      {/* The safety numbers lead: the delay and the caps every other control is measured against. */}
      <SettingsGroup>
        <SettingsRow
          icon="security"
          title={t('mobile.vault.risk_settings')}
          value={levelValue}
          onPress={() => nav.navigate('VaultRiskSettings')}
          last
        />
      </SettingsGroup>
      {/* What the vault lets happen beyond the owner's own hand: what it may touch and who else may
          act for it. */}
      <SettingsGroup>
        <SettingsRow icon="allowlist" title={t('mobile.settings.allow_list')} onPress={() => nav.navigate('VaultAssets')} />
        {/* No status here: who it is and what is pending live on the asset manager's own page. */}
        <SettingsRow icon="delegation" title={t('vault.asset_manager')} onPress={() => nav.navigate('VaultAssetManager')} last />
      </SettingsGroup>
      {/* The last resorts: freezing the vault, the phrase that restores the key, and handing the vault
          to another key. */}
      <SettingsGroup>
        <SettingsRow icon={LOCK_ICON[lockLevel ?? 0]} title={t('mobile.vault.vault_lock')} value={lockValue} onPress={() => nav.navigate('VaultLock')} />
        <SettingsRow icon="recovery" title={t('mobile.settings.recovery_phrase')} onPress={() => nav.navigate('VaultRecoveryPhrase')} />
        <SettingsRow icon="ownership" title={t('mobile.vault.transfer_ownership')} onPress={() => nav.navigate('VaultTransferOwnership')} last />
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
  });

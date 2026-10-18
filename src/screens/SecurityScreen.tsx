import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {useFocusEffect, useIsFocused, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {useVaultGeneration} from '@/core/vault-generation';
import {useAssetManagerRow} from '@/components/useAssetManagerRow';
import {getLockLevel, type LockLevel} from '@/vault/risk';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {customRpc} from '@/core/chain';

/**
 * Security — three groups of rows, each opening what it names: Risk settings (the timelock and the
 * two daily allowances); the allow list, the asset manager, Legacy ETH (wrap idle native ETH) and RPC
 * (the owner's own node for on-chain reads);
 * Vault lock (emergency / forever lock) and the recovery phrase. The writes live on the pages the
 * rows open.
 *
 * Vault lock is left out on v1.0.3, which has no locks.
 */
export function SecurityScreen() {
  const {t} = useT();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const styles = useStyles(makeStyles);
  const hasLocks = useVaultGeneration((s) => s.generation) !== 'v1.0.3';
  const manager = useAssetManagerRow();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  // Re-render on return from the RPC page, so its row shows what was just saved.
  useIsFocused();

  // The lock state answers the Vault lock row. Re-read on focus: the row's own page changes it.
  const [lockLevel, setLockLevel] = useState<LockLevel | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (vault && hasLocks) getLockLevel(vault, network).then(setLockLevel);
    }, [vault, network, hasLocks]),
  );
  const lockValue =
    lockLevel == null
      ? undefined
      : t(lockLevel === 2 ? 'mobile.vault.locked_forever' : lockLevel === 1 ? 'mobile.vault.locked_emergency' : 'mobile.vault.unlocked');

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      {/* The risk numbers lead: the delay and the cap every other control is measured against. */}
      <SettingsGroup>
        <SettingsRow icon="dailyLimit" title={t('mobile.vault.risk_settings')} onPress={() => nav.navigate('VaultRiskSettings')} last />
      </SettingsGroup>
      {/* What the vault lets happen beyond the owner's own hand: what it may touch, who else may act
          for it, and the idle native ETH it can wrap. */}
      <SettingsGroup>
        <SettingsRow icon="allowlist" title={t('mobile.settings.allow_list')} onPress={() => nav.navigate('VaultAssets')} />
        <SettingsRow
          icon="delegation"
          title={t('vault.asset_manager')}
          value={manager.value}
          sub={manager.sub}
          onPress={manager.onPress}
        />
        <SettingsRow icon="eth" title={t('mobile.vault.legacy_eth')} onPress={() => nav.navigate('VaultLegacyEth')} />
        <SettingsRow
          icon="network"
          title={t('mobile.settings.rpc')}
          value={customRpc(network) ? t('mobile.settings.rpc_custom') : t('mobile.settings.rpc_default')}
          onPress={() => nav.navigate('Rpc')}
          last
        />
      </SettingsGroup>
      {/* The last resorts: freezing the vault, and the phrase that restores the key. */}
      <SettingsGroup>
        {/* v1.0.0 only — v1.0.3 has no locks. */}
        {hasLocks ? (
          <SettingsRow icon="lock" title={t('mobile.vault.vault_lock')} value={lockValue} onPress={() => nav.navigate('VaultLock')} />
        ) : null}
        <SettingsRow
          icon="recovery"
          title={t('mobile.settings.recovery_phrase')}
          sub={t('mobile.settings.reveal_face_id')}
          onPress={() => nav.navigate('VaultRecoveryPhrase')}
          last
        />
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
  });

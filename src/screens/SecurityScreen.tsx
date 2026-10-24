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
import {isPhraseVerified} from '@/wallet/phrase-backup';

/**
 * Security — three groups of rows, each opening what it names: Safety settings (the timelock and the
 * two daily allowances, with the vault's safety level beside it) and the allow list; the asset
 * manager and Transfer ownership; Lock status (temporarily / forever locked) and the recovery
 * phrase. The writes live on the pages the rows open.
 */
export function SecurityScreen() {
  const {t} = useT();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const styles = useStyles(makeStyles);
  const owner = useWallet((s) => s.address);
  const signer = useWallet((s) => s.account?.address);
  // Re-read on focus: the Recovery phrase page is where it is verified.
  const [phraseOk, setPhraseOk] = useState(() => isPhraseVerified(signer));
  useFocusEffect(useCallback(() => setPhraseOk(isPhraseVerified(signer)), [signer]));
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
      {/* What the vault may do: the safety numbers every other control is measured against, and
          what it may touch. */}
      <SettingsGroup>
        <SettingsRow icon="security" title={t('mobile.vault.risk_settings')} value={levelValue} onPress={() => nav.navigate('VaultRiskSettings')} />
        <SettingsRow icon="allowlist" title={t('mobile.settings.allow_list')} onPress={() => nav.navigate('VaultAssets')} last />
      </SettingsGroup>
      {/* Who else may act for it, and handing it to another key. */}
      <SettingsGroup>
        {/* No status here: who it is and what is pending live on the asset manager's own page. */}
        <SettingsRow icon="delegation" title={t('vault.asset_manager')} onPress={() => nav.navigate('VaultAssetManager')} />
        <SettingsRow icon="ownership" title={t('mobile.vault.transfer_ownership')} onPress={() => nav.navigate('VaultTransferOwnership')} last />
      </SettingsGroup>
      {/* The last resorts: freezing the vault, and the phrase that restores the key. */}
      <SettingsGroup>
        <SettingsRow icon={LOCK_ICON[lockLevel ?? 0]} title={t('mobile.vault.vault_lock')} value={lockValue} onPress={() => nav.navigate('VaultLock')} />
        <SettingsRow
          icon="recovery"
          title={t('mobile.settings.recovery_phrase')}
          value={t(phraseOk ? 'mobile.settings.phrase_verified' : 'mobile.settings.phrase_not_verified')}
          onPress={() => nav.navigate('VaultRecoveryPhrase')} last />
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
  });

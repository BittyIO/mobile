import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {getRiskConfig} from '@/vault/risk';
import {useVaultGate} from '@/vault/gate';
import {SAFETY_TITLE, levelOf, valuesInForce, type SafetyLevelOrCustom} from '@/core/safety-levels';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {LOCK_ICON, LOCK_TITLE} from '@/core/lock-status';
import {isPhraseVerified} from '@/wallet/phrase-backup';
import {useRotationOn} from '@/wallet/rotation-store';
import {useVaults} from '@/core/vault-store';
import {useVaultVersionRow} from '@/components/useVaultVersionRow';

/**
 * Security — three groups of rows, each opening what it names: Safety settings (the timelock and the
 * two daily allowances, with the vault's safety level beside it) and the allow list; the asset
 * manager, Ownership (and from it, transferring it) and Quantum-safe keys; Lock status (temporarily / forever locked) and the recovery
 * phrase. The writes live on the pages the rows open.
 */
export function SecurityScreen() {
  const {t} = useT();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const styles = useStyles(makeStyles);
  const owner = useWallet((s) => s.address);
  // Re-read on focus: the Recovery phrase page is where it is verified.
  const [phraseOk, setPhraseOk] = useState(() => isPhraseVerified());
  useFocusEffect(useCallback(() => setPhraseOk(isPhraseVerified()), []));
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const isSafe = useVaults((s) => !!s.vaults.find((v) => v.index === s.activeIndex)?.safe);
  const quantumOn = useRotationOn(network, vault);
  // The Upgrade row answers with the vault's version, "1.0.5 → 1.0.6" when one is waiting.
  const version = useVaultVersionRow();

  // The lock state answers the Vault lock row: the shared gate, read again on focus and whenever a
  // write settles — the row's own page changes it.
  const {lockLevel} = useVaultGate();
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
        <SettingsRow icon="allowlist" title={t('mobile.settings.allow_list')} onPress={() => nav.navigate('VaultAssets')} />
        <SettingsRow icon="whitelist" title={t('mobile.settings.whitelisted_addresses')} onPress={() => nav.navigate('VaultWhitelist')} />
        {/* The vault's version and its auto-upgrade switches, the vault's and each protocol's. */}
        {/* The vault's CONTRACT, said as such now that Settings also shows the app's own version. */}
        <SettingsRow icon="upgrade" title={t('mobile.settings.contract_upgrade')} value={version.value} onPress={() => nav.navigate('VaultUpgrade')} last />
      </SettingsGroup>
      {/* Who else may act for it, and handing it to another key. */}
      <SettingsGroup>
        {/* No status here: who it is and what is pending live on the asset manager's own page. */}
        <SettingsRow icon="delegation" title={t('mobile.vault.delegation')} onPress={() => nav.navigate('VaultAssetManager')} />
        <SettingsRow icon="ownership" title={t('mobile.vault.ownership')} onPress={() => nav.navigate('VaultOwnership')} last={isSafe} />
        {/* A Safe's keys are its owners' to manage: there is no one key here to retire. */}
        {isSafe ? null : (
          <SettingsRow
            icon="quantum"
            title={t('mobile.quantum.title')}
            value={t(quantumOn ? 'mobile.quantum.on' : 'mobile.quantum.off')}
            onPress={() => nav.navigate('QuantumSafe')}
            last
          />
        )}
      </SettingsGroup>
      {/* The last resorts: freezing the vault, and the phrase that restores the key. */}
      <SettingsGroup>
        <SettingsRow icon={LOCK_ICON[lockLevel ?? 0]} title={t('mobile.vault.vault_lock')} value={lockValue} onPress={() => nav.navigate('VaultLock')} />
        <SettingsRow
          icon="recovery"
          title={t('mobile.settings.recovery_phrase')}
          // "Verified" once the words have been checked; nothing otherwise — a standing "Not
          // verified" read as a fault on every visit, where the page itself is where to deal with it.
          value={phraseOk ? t('mobile.settings.phrase_verified') : undefined}
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

import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import {useVaultGeneration} from '@/core/vault-generation';
import {getLockLevel, getRiskConfig, type LockLevel} from '@/vault/risk';
import {SAFETY_TITLE, levelOf, safetyColor, valuesInForce, type SafetyLevelOrCustom} from '@/core/safety-levels';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {LOCK_ICON, LOCK_TITLE, lockColor} from '@/core/lock-status';

/**
 * Security — three groups of rows, each opening what it names: Safety settings (the timelock and the
 * two daily allowances, with the vault's safety level beside it on v1.0.0+); the allow list and the asset manager;
 * Lock status (temporarily / forever locked), the recovery phrase and Transfer ownership. The writes live on
 * the pages the rows open.
 *
 * Vault lock is left out on v1.0.3, which has no locks.
 */
export function SecurityScreen() {
  const {t} = useT();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const styles = useStyles(makeStyles);
  const hasLocks = useVaultGeneration((s) => s.generation) !== 'v1.0.3';
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  // The lock state answers the Vault lock row. Re-read on focus: the row's own page changes it.
  const [lockLevel, setLockLevel] = useState<LockLevel | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (vault && hasLocks) getLockLevel(vault, network).then(setLockLevel);
    }, [vault, network, hasLocks]),
  );
  // The safety level answers the Safety settings row, as a chip in the level's own colour.
  const c = useColors();
  const [level, setLevel] = useState<SafetyLevelOrCustom | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!vault || !hasLocks) return;
      getRiskConfig(vault, network).then((r) => setLevel(levelOf(valuesInForce(r))));
    }, [vault, network, hasLocks]),
  );
  const levelChip =
    level == null ? undefined : (
      <View style={[styles.chip, {borderColor: safetyColor(level, c)}]}>
        <View style={[styles.chipDot, {backgroundColor: safetyColor(level, c)}]} />
        <Text style={styles.chipText}>{t(SAFETY_TITLE[level])}</Text>
      </View>
    );

  // The lock state answers the Lock status row, as a chip in its own colour like the level above.
  const lockChip =
    lockLevel == null ? undefined : (
      <View style={[styles.chip, {borderColor: lockColor(lockLevel, c)}]}>
        <View style={[styles.chipDot, {backgroundColor: lockColor(lockLevel, c)}]} />
        <Text style={styles.chipText}>{t(LOCK_TITLE[lockLevel])}</Text>
      </View>
    );

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      {/* The safety numbers lead: the delay and the caps every other control is measured against. */}
      <SettingsGroup>
        <SettingsRow
          icon="dailyLimit"
          title={t('mobile.vault.risk_settings')}
          right={levelChip}
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
        {/* v1.0.0 only — v1.0.3 has no locks. */}
        {hasLocks ? (
          <SettingsRow icon={LOCK_ICON[lockLevel ?? 0]} title={t('mobile.vault.vault_lock')} right={lockChip} onPress={() => nav.navigate('VaultLock')} />
        ) : null}
        <SettingsRow
          icon="recovery"
          title={t('mobile.settings.recovery_phrase')}
          onPress={() => nav.navigate('VaultRecoveryPhrase')}
          last={!hasLocks}
        />
        {/* v1.0.0 only — the handover waits out the timelock, which v1.0.3 does not queue it behind. */}
        {hasLocks ? (
          <SettingsRow icon="delegation" title={t('mobile.vault.transfer_ownership')} onPress={() => nav.navigate('VaultTransferOwnership')} last />
        ) : null}
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    chip: {flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3},
    chipDot: {width: 8, height: 8, borderRadius: 4},
    chipText: {color: c.text, fontSize: 12, fontWeight: '600'},
  });

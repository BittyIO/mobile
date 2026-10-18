import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getAssetManager, revokeAssetManager, type AssetManagerSettings} from '@/vault/delegate';
import {getRiskConfig} from '@/vault/risk';
import {shortAddress} from '@/core/format';
import {useVaultGeneration} from '@/core/vault-generation';
import {OptionRow, SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {Button} from '@/components/Button';
import {Sheet} from '@/components/Sheet';
import {ProgressRing, leftUnit, waitDone} from '@/components/ProgressRing';
import {useVaultWrite} from '@/components/useVaultWrite';
import {PERM_ROWS, fmtExpiry, isSet} from '@/components/useAssetManagerRow';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * Asset manager (Security › Asset manager) — who may act for the vault.
 *
 * First what is in force: the manager's address (tap it to set a new one, {SetAssetManagerScreen})
 * and expiry. Second, an appointment still waiting out the timelock, with a ring for how far the
 * wait has run; tap it for the permissions it will carry. Then, on v1.0.0, the permissions the
 * manager in force holds. Revoke at the bottom when there is someone to revoke.
 */
export function AssetManagerScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const legacy = useVaultGeneration((s) => s.generation) === 'v1.0.3';
  const [am, setAm] = useState<AssetManagerSettings | null>(null);
  const [timelock, setTimelock] = useState(0);
  const [permSheet, setPermSheet] = useState(false);

  const {vault, network, busy, ready, run, sheet} = useVaultWrite(() => load());

  const load = useCallback(() => {
    if (!vault) return;
    getAssetManager(vault, network).then(setAm).catch(() => setAm(null));
    getRiskConfig(vault, network).then((r) => setTimelock(Number(r.timelock)));
  }, [vault, network]);
  useFocusEffect(load);

  // A clock for the pending ring, ticking while the page is up.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const hasManager = !!am && isSet(am.manager);
  const hasPending = !!am && isSet(am.pendingManager);
  const pendingAt = hasPending ? Number(am!.pendingAt) : 0;

  const revoke = () =>
    run('revoke', t('mobile.vault.revoke_manager_title'), (b) => revokeAssetManager(b), t('mobile.vault.revoke_manager_msg'));

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup label={t('vault.current')}>
        <SettingsRow
          icon="delegation"
          title={t('mobile.vault.manager_address')}
          value={am ? (hasManager ? shortAddress(am.manager) : t('vault.none')) : undefined}
          onPress={() => nav.navigate('VaultSetAssetManager')}
          last={!hasManager}
        />
        {hasManager ? (
          <SettingsRow icon="timelock" title={t('vault.expires')} value={fmtExpiry(am!.expiresAt, t)} chevron={false} last />
        ) : null}
      </SettingsGroup>

      {hasPending ? (
        <SettingsGroup label={t('mobile.vault.pending_changes')}>
          <SettingsRow
            icon="delegation"
            title={t('mobile.vault.pending_new_asset_manager')}
            sub={am!.pendingManager}
            onPress={legacy ? undefined : () => setPermSheet(true)}
            chevron={false}
            right={
              <View style={styles.wait}>
                <Text style={styles.left}>{leftUnit(pendingAt - now, t).join(' ')}</Text>
                <ProgressRing size={22} done={waitDone(pendingAt, now, timelock)} left={pendingAt - now} />
              </View>
            }
            last
          />
        </SettingsGroup>
      ) : null}

      {/* What the manager in force may do. Read-only: Set asset manager is where it changes. */}
      {legacy || !hasManager ? null : (
        <SettingsGroup label={t('mobile.vault.permissions')}>
          {PERM_ROWS.map((p, i) => (
            <OptionRow key={p.bit} title={t(p.key)} checked={(Number(am!.permissions) & p.bit) !== 0} last={i === PERM_ROWS.length - 1} />
          ))}
        </SettingsGroup>
      )}

      {hasManager || hasPending ? (
        <Button title={t('vault.revoke')} variant="danger" onPress={revoke} loading={busy === 'revoke'} disabled={!ready} />
      ) : null}

      {/* The pending appointment in full: who, and what it will be allowed to do. */}
      <Sheet visible={permSheet} title={t('mobile.vault.permissions')} onClose={() => setPermSheet(false)}>
        {hasPending ? (
          <View style={styles.sheetBody}>
            <Text style={styles.sheetAddr}>{am!.pendingManager}</Text>
            <SettingsGroup>
              {PERM_ROWS.map((p, i) => (
                <OptionRow
                  key={p.bit}
                  title={t(p.key)}
                  checked={(Number(am!.pendingPermissions) & p.bit) !== 0}
                  last={i === PERM_ROWS.length - 1}
                />
              ))}
            </SettingsGroup>
          </View>
        ) : null}
      </Sheet>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    wait: {flexDirection: 'row', alignItems: 'center', gap: 8},
    left: {color: c.subtext, fontSize: 14, fontVariant: ['tabular-nums']},
    sheetBody: {gap: 12},
    sheetAddr: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums'], paddingHorizontal: 4},
  });

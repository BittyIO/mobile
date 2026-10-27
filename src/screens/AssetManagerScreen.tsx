import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {cancelPendingAssetManager, getAssetManager, revokeAssetManager, type AssetManagerSettings} from '@/vault/delegate';
import {getRiskConfig} from '@/vault/risk';
import {shortAddress} from '@/core/format';
import {OptionRow, SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {Sheet} from '@/components/Sheet';
import {PendingRow} from '@/components/PendingRow';
import {useVaultWrite} from '@/components/useVaultWrite';
import {PERM_ROWS, fmtExpiry, isSet} from '@/components/useAssetManagerRow';
import {useT} from '@/i18n';
import {GateHint, LockNotice} from '@/components/LockNotice';
import {useCapability} from '@/vault/gate';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * Asset manager (Security › Asset manager) — who may act for the vault.
 *
 * First what is in force: the manager's address (tap it to set a new one, {SetAssetManagerScreen})
 * and expiry. Second, an appointment still waiting out the timelock, with a ring for how far the
 * wait has run; tap it for the permissions it will carry. Then, on v1.0.0, the permissions the
 * manager in force holds. Tapping a manager in force offers Change or Revoke, in a sheet.
 */
export function AssetManagerScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [am, setAm] = useState<AssetManagerSettings | null>(null);
  const [timelock, setTimelock] = useState(0);
  const [permSheet, setPermSheet] = useState(false);
  const [actionSheet, setActionSheet] = useState(false);

  const {vault, network, busy, ready, run, sheet} = useVaultWrite(() => load());

  const load = useCallback(() => {
    if (!vault) return;
    return Promise.all([
      getAssetManager(vault, network).then(setAm).catch(() => setAm(null)),
      getRiskConfig(vault, network).then((r) => setTimelock(Number(r.timelock))),
    ]);
  }, [vault, network]);

  const [refreshing, setRefreshing] = useState(false);
  const onPull = () => {
    setRefreshing(true);
    Promise.resolve(load()).finally(() => setRefreshing(false));
  };
  useFocusEffect(useCallback(() => void load(), [load]));

  // A clock for the pending ring, ticking while the page is up.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const hasManager = !!am && isSet(am.manager);
  // Locked, the appointment is frozen: the manager in force stays until its grant runs out.
  const managerGate = useCapability('setAssetManager');
  const hasPending = !!am && isSet(am.pendingManager);
  const pendingAt = hasPending ? Number(am!.pendingAt) : 0;

  const cancelPending = () =>
    am &&
    run(
      'cancel',
      t('mobile.vault.cancel_pending_manager'),
      (b) => cancelPendingAssetManager({...b, current: am}),
      am.pendingManager,
    );

  const revoke = () =>
    run('revoke', t('mobile.vault.revoke_manager_title'), (b) => revokeAssetManager(b), t('mobile.vault.revoke_manager_msg'));

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}>
      <LockNotice />
      <SettingsGroup label={t('vault.current')}>
        <SettingsRow
          icon="delegation"
          title={t('mobile.vault.manager_address')}
          value={am ? (hasManager ? shortAddress(am.manager) : t('vault.none')) : undefined}
          // With a manager in force, a tap asks which: change them or revoke them. With none, set one.
          onPress={managerGate.allowed ? () => (hasManager ? setActionSheet(true) : nav.navigate('VaultSetAssetManager')) : undefined}
          chevron={managerGate.allowed}
          last={!hasManager}
        />
        {hasManager ? (
          <SettingsRow icon="timelock" title={t('vault.expires')} value={fmtExpiry(am!.expiresAt, t)} chevron={false} last />
        ) : null}
      </SettingsGroup>
      <GateHint gate={managerGate} />

      {hasPending ? (
        <SettingsGroup label={t('mobile.vault.pending_changes')}>
          <PendingRow
            at={pendingAt}
            now={now}
            timelock={timelock}
            title={t('mobile.vault.pending_new_asset_manager')}
            value={am!.pendingManager}
            onPress={() => setPermSheet(true)}
            onCancel={cancelPending}
            cancelling={busy === 'cancel'}
            cancelDisabled={!ready || busy !== null || !managerGate.allowed}
            last
          />
        </SettingsGroup>
      ) : null}

      {/* What the manager in force may do. Read-only: Set asset manager is where it changes. */}
      {!hasManager ? null : (
        <SettingsGroup label={t('mobile.vault.permissions')}>
          {PERM_ROWS.map((p, i) => (
            <OptionRow key={p.bit} title={t(p.key)} checked={(Number(am!.permissions) & p.bit) !== 0} last={i === PERM_ROWS.length - 1} />
          ))}
        </SettingsGroup>
      )}

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
      <Sheet visible={actionSheet} title={t('vault.asset_manager')} onClose={() => setActionSheet(false)}>
        <View style={styles.sheetBody}>
          {hasManager ? <Text style={styles.sheetAddr}>{am!.manager}</Text> : null}
          <SettingsGroup>
            <Pressable
              style={({pressed}) => [styles.action, styles.actionDivider, pressed && styles.pressed]}
              onPress={() => {
                setActionSheet(false);
                nav.navigate('VaultSetAssetManager');
              }}>
              <Text style={styles.actionText}>{t('mobile.vault.change_asset_manager')}</Text>
            </Pressable>
            <Pressable
              style={({pressed}) => [styles.action, (pressed || !ready) && styles.pressed]}
              disabled={!ready}
              onPress={() => {
                setActionSheet(false);
                revoke();
              }}>
              <Text style={[styles.actionText, styles.actionDanger]}>{t('vault.revoke')}</Text>
            </Pressable>
          </SettingsGroup>
        </View>
      </Sheet>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    sheetBody: {gap: 12},
    action: {minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
    actionDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    actionText: {color: c.accent, fontSize: 16, fontWeight: '600'},
    actionDanger: {color: c.danger},
    pressed: {opacity: 0.6},
    sheetAddr: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums'], paddingHorizontal: 4},
  });

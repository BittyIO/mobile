import React, {useCallback, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import type {Address} from 'viem';
import {getAssetManager, setAssetManager, revokeAssetManager, type AssetManagerSettings} from '@/vault/delegate';
import {isPayableAddress} from '@/core/asset-catalog';
import {shortAddress} from '@/core/format';
import {ASSET_MANAGER_ALL_PERMISSIONS} from '@/core/abi';
import {useVaultGeneration} from '@/core/vault-generation';
import {OptionRow, SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {Button} from '@/components/Button';
import {useVaultWrite} from '@/components/useVaultWrite';
import {EXPIRIES, PERM_ROWS, fmtExpiry, fmtPerms, isSet} from '@/components/useAssetManagerRow';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * Asset manager (Security › Asset manager) — who may act for the vault, and the place to change it.
 *
 * The top half is what is in force: the manager's address and expiry, on v1.0.0 the permissions
 * they hold (a ✓ on each granted one), and any appointment still waiting out the timelock. The
 * bottom half sets a new one: an address, how long it lasts, and on v1.0.0 the permissions it
 * carries — prefilled from the current manager, or everything for a first appointment — then Set,
 * through the Face-ID and fee confirm. Revoke sits under it when there is someone to revoke.
 *
 * Narrowing the same manager's permissions applies at once; anything wider waits out the timelock.
 */
/** The vault's MAX_GRANT_DURATION: no asset manager grant may run past a year. */
const MAX_GRANT_SECONDS = 365 * 86400;

export function AssetManagerScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const legacy = useVaultGeneration((s) => s.generation) === 'v1.0.3';
  const [am, setAm] = useState<AssetManagerSettings | null>(null);

  // The form, prefilled from what is in force each time it is read.
  const [addr, setAddr] = useState('');
  const [days, setDays] = useState<number>(EXPIRIES[0].days);
  const [perms, setPerms] = useState<number>(ASSET_MANAGER_ALL_PERMISSIONS);

  const {vault, network, busy, ready, run, sheet} = useVaultWrite(() => load());

  const load = useCallback(() => {
    if (!vault) return;
    getAssetManager(vault, network)
      .then((r) => {
        setAm(r);
        const current = isSet(r.manager);
        setAddr(current ? r.manager : '');
        setPerms(current && r.permissions > 0n ? Number(r.permissions) : ASSET_MANAGER_ALL_PERMISSIONS);
      })
      .catch(() => setAm(null));
  }, [vault, network]);
  useFocusEffect(load);

  const hasManager = !!am && isSet(am.manager);
  const hasPending = !!am && isSet(am.pendingManager);
  const badAddr = addr.length > 0 && !isPayableAddress(addr, network);
  const canSet = ready && isPayableAddress(addr, network) && (legacy || perms !== 0);

  const set = () => {
    if (!canSet) return;
    // The vault caps a grant at one year from the block it lands in. The 1y choice sits exactly on
    // that cap, so it is pulled in by an hour: a phone clock running ahead must not push it past.
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.min(days * 86400, MAX_GRANT_SECONDS - 3600));
    run('set', t('mobile.vault.set_asset_manager'), (b) =>
      setAssetManager({...b, manager: addr as Address, expiresAt, permissions: perms}),
    );
  };

  const revoke = () =>
    run('revoke', t('mobile.vault.revoke_manager_title'), (b) => revokeAssetManager(b), t('mobile.vault.revoke_manager_msg'));

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup label={t('vault.current')}>
        <SettingsRow
          icon="delegation"
          title={t('mobile.vault.manager_address')}
          value={am ? (hasManager ? shortAddress(am.manager) : t('vault.none')) : undefined}
          chevron={false}
          last={!hasManager && !hasPending}
        />
        {hasManager ? (
          <SettingsRow icon="timelock" title={t('vault.expires')} value={fmtExpiry(am!.expiresAt, t)} chevron={false} last={!hasPending} />
        ) : null}
        {hasPending ? (
          <SettingsRow
            icon="dailyLimit"
            title={t('mobile.vault.pending_timelock')}
            value={shortAddress(am!.pendingManager)}
            sub={[
              legacy ? null : fmtPerms(Number(am!.pendingPermissions), t),
              t('mobile.vault.applies', {when: fmtExpiry(am!.pendingAt, t, 'on')}),
            ]
              .filter(Boolean)
              .join(' · ')}
            chevron={false}
            last
          />
        ) : null}
      </SettingsGroup>

      {/* What the manager in force may do. Read-only: the switches below are where it changes. */}
      {legacy || !hasManager ? null : (
        <SettingsGroup label={t('mobile.vault.permissions')}>
          {PERM_ROWS.map((p, i) => (
            <OptionRow key={p.bit} title={t(p.key)} checked={(Number(am!.permissions) & p.bit) !== 0} last={i === PERM_ROWS.length - 1} />
          ))}
        </SettingsGroup>
      )}

      <View style={styles.section}>
        <Text style={styles.label}>{t('mobile.vault.set_asset_manager')}</Text>
        <TextInput
          style={[styles.input, badAddr && styles.inputBad]}
          placeholder={t('mobile.vault.enter_manager_address')}
          placeholderTextColor={c.subtext}
          autoCapitalize="none"
          autoCorrect={false}
          value={addr}
          onChangeText={setAddr}
        />

        <Text style={styles.label}>{t('vault.expires')}</Text>
        <View style={styles.chips}>
          {EXPIRIES.map((e) => {
            const on = e.days === days;
            return (
              <Pressable key={e.label} style={[styles.chip, on && styles.chipOn]} onPress={() => setDays(e.days)}>
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{e.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {legacy ? null : (
          <>
            <Text style={styles.label}>{t('mobile.vault.permissions')}</Text>
            <View style={styles.permGroup}>
              {PERM_ROWS.map((p, i) => (
                <View key={p.bit} style={[styles.permRow, i < PERM_ROWS.length - 1 && styles.permDivider]}>
                  <Text style={styles.permText}>{t(p.key)}</Text>
                  <Switch value={(perms & p.bit) !== 0} onValueChange={(on) => setPerms(on ? perms | p.bit : perms & ~p.bit)} />
                </View>
              ))}
            </View>
            <Text style={styles.fine}>{t('mobile.vault.permissions_hint')}</Text>
          </>
        )}

        <Button title={t('vault.set')} onPress={set} loading={busy === 'set'} disabled={!canSet} style={styles.setBtn} />
        {hasManager || hasPending ? (
          <Button title={t('vault.revoke')} variant="danger" onPress={revoke} loading={busy === 'revoke'} disabled={!ready} />
        ) : null}
      </View>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    section: {gap: 10},
    label: {color: c.subtext, fontSize: 15, fontWeight: '600', paddingHorizontal: 16, marginTop: 8},
    input: {height: 52, borderRadius: 12, backgroundColor: c.card, paddingHorizontal: 16, color: c.text, fontSize: 15},
    inputBad: {borderWidth: 1, borderColor: c.danger},
    chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    chip: {paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: c.border},
    chipOn: {borderColor: c.accent, backgroundColor: c.accentSoft},
    chipText: {color: c.subtext, fontSize: 14, fontWeight: '600'},
    chipTextOn: {color: c.text},
    permGroup: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    permRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10},
    permDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    permText: {color: c.text, fontSize: 15, fontWeight: '600'},
    fine: {color: c.subtext, fontSize: 12, lineHeight: 17, paddingHorizontal: 16},
    setBtn: {marginTop: 8},
  });

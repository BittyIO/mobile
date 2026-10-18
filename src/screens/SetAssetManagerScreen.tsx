import React, {useCallback, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {Address} from 'viem';
import {getAssetManager, setAssetManager} from '@/vault/delegate';
import {isPayableAddress} from '@/core/asset-catalog';
import {ASSET_MANAGER_ALL_PERMISSIONS} from '@/core/abi';
import {useVaultGeneration} from '@/core/vault-generation';
import {Button} from '@/components/Button';
import {useVaultWrite} from '@/components/useVaultWrite';
import {EXPIRIES, PERM_ROWS, isSet} from '@/components/useAssetManagerRow';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/** The vault's MAX_GRANT_DURATION: no asset manager grant may run past a year. */
const MAX_GRANT_SECONDS = 365 * 86400;

/**
 * Asset manager › Set asset manager — an address, how long it lasts, and on v1.0.0 the permissions
 * it carries, prefilled from the current manager (or everything for a first appointment), then Set
 * through the Face-ID and fee confirm. Back to the manager's page once it is sent.
 *
 * Narrowing the same manager's permissions applies at once; anything wider waits out the timelock.
 */
export function SetAssetManagerScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const legacy = useVaultGeneration((s) => s.generation) === 'v1.0.3';

  const [addr, setAddr] = useState('');
  const [days, setDays] = useState<number>(EXPIRIES[0].days);
  const [perms, setPerms] = useState<number>(ASSET_MANAGER_ALL_PERMISSIONS);
  const [custom, setCustom] = useState(false);
  const [customDays, setCustomDays] = useState('');
  const n = Number(customDays);
  const badDays = custom && customDays.length > 0 && !(Number.isInteger(n) && n >= 1 && n <= 365);
  const grantDays = custom ? n : days;

  const {vault, network, busy, ready, run, sheet} = useVaultWrite(() => nav.goBack());

  useFocusEffect(
    useCallback(() => {
      if (!vault) return;
      getAssetManager(vault, network)
        .then((r) => {
          const current = isSet(r.manager);
          setAddr(current ? r.manager : '');
          setPerms(current && r.permissions > 0n ? Number(r.permissions) : ASSET_MANAGER_ALL_PERMISSIONS);
        })
        .catch(() => {});
    }, [vault, network]),
  );

  const badAddr = addr.length > 0 && !isPayableAddress(addr, network);
  const daysOk = Number.isInteger(grantDays) && grantDays >= 1 && grantDays <= 365;
  const canSet = ready && isPayableAddress(addr, network) && daysOk && (legacy || perms !== 0);

  const set = () => {
    if (!canSet) return;
    // The vault caps a grant at one year from the block it lands in. The 1y choice sits exactly on
    // that cap, so it is pulled in by an hour: a phone clock running ahead must not push it past.
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.min(grantDays * 86400, MAX_GRANT_SECONDS - 3600));
    run('set', t('mobile.vault.set_asset_manager'), (b) =>
      setAssetManager({...b, manager: addr as Address, expiresAt, permissions: perms}),
    );
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <View style={styles.section}>
        {/* Who, and for how long, in one group: the address row, then the expiry row. */}
        <View style={styles.group}>
          <TextInput
            style={[styles.input, styles.divider, badAddr && styles.inputBad]}
            placeholder={t('mobile.vault.enter_manager_address')}
            placeholderTextColor={c.subtext}
            autoCapitalize="none"
            autoCorrect={false}
            value={addr}
            onChangeText={setAddr}
          />
          <View style={styles.expRow}>
            <Text style={styles.expTitle}>{t('vault.expires')}</Text>
            <View style={styles.chips}>
              {EXPIRIES.map((e) => {
                const on = !custom && e.days === days;
                return (
                  <Pressable key={e.label} style={[styles.chip, on && styles.chipOn]} onPress={() => {
                    setCustom(false);
                    setDays(e.days);
                  }}>
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{e.label}</Text>
                  </Pressable>
                );
              })}
              <Pressable style={[styles.chip, custom && styles.chipOn]} onPress={() => setCustom(true)}>
                <Text style={[styles.chipText, custom && styles.chipTextOn]}>{t('mobile.vault.safety_custom')}</Text>
              </Pressable>
            </View>
            {/* Whole days, 1 to 365: the vault refuses a grant past a year. */}
            {custom ? (
              <View style={styles.customRow}>
                <TextInput
                  style={[styles.daysInput, badDays && styles.inputBad]}
                  keyboardType="number-pad"
                  placeholder="1–365"
                  placeholderTextColor={c.subtext}
                  autoFocus
                  value={customDays}
                  onChangeText={setCustomDays}
                />
                <Text style={styles.daysUnit}>{t('mobile.vault.unit_days')}</Text>
              </View>
            ) : null}
          </View>
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
    group: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    divider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    input: {minHeight: 52, paddingHorizontal: 16, paddingVertical: 14, color: c.text, fontSize: 15},
    inputBad: {color: c.danger},
    expRow: {paddingHorizontal: 16, paddingVertical: 12, gap: 10},
    expTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
    customRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
    daysInput: {flex: 1, height: 40, borderRadius: 10, backgroundColor: c.input, paddingHorizontal: 12, color: c.text, fontSize: 15},
    daysUnit: {color: c.subtext, fontSize: 14, fontWeight: '600'},
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

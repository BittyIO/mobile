import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import type {Address} from 'viem';
import {isPayableAddress} from '@/core/asset-catalog';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {ASSETS} from '@/core/assets';
import {getAssetManager, setAssetManager, revokeAssetManager, type AssetManagerSettings} from '@/vault/delegate';
import {shortAddress} from '@/core/format';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {useConfirmAction} from '@/components/ConfirmAction';
import {Sheet} from '@/components/Sheet';
import {Button, ConfirmButton} from '@/components/Button';
import {useColors, useStyles, type Colors} from '@/theme';
import {relayGasFor} from '@/vault/fee-quote';

const isSet = (a?: string) => !!a && !/^0x0+$/.test(a);

/** Expiry choices for an appointment, in days; 0 = never. */
const EXPIRIES: {label: string; days: number}[] = [
  {label: '30d', days: 30},
  {label: '90d', days: 90},
  {label: '1y', days: 365},
  {label: 'Never', days: 0},
];

/**
 * The Asset manager settings row and the sheet behind it.
 *
 * The row shows who the manager is and when the appointment expires; tapping it opens a sheet with
 * the address, the expiry, and Revoke where there is something to revoke. It used to be three
 * stacked system dialogs — an action sheet, then a text prompt, then another action sheet — which
 * gave the address no room, showed no fee, and could not be corrected without starting again.
 *
 * Appointments land in a pending slot until the change timelock passes.
 */
export function useAssetManagerRow(): {
  value?: string;
  sub?: string;
  onPress: () => void;
  /** Mount this in the settings page: the editor, and the confirmation it leads to. */
  sheet: React.ReactNode;
} {
  const {t} = useT();
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = ASSETS[network].find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [am, setAm] = useState<AssetManagerSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (vault) getAssetManager(vault, network).then(setAm).catch(() => setAm(null));
  }, [vault, network]);
  useEffect(load, [load]);

  const fmtExpiry = (expiresAt: bigint, mode: 'until' | 'on' = 'until'): string => {
    if (expiresAt === 0n) return t('mobile.vault.no_expiry');
    const d = new Date(Number(expiresAt) * 1000);
    if (d < new Date()) return t('mobile.vault.expired');
    return t(mode === 'on' ? 'mobile.vault.on_date' : 'mobile.vault.until_date', {date: d.toLocaleDateString()});
  };

  const {ask, sheet} = useConfirmAction();

  const runNow = async (title: string, fn: (acct: Awaited<ReturnType<typeof getSigner>>) => Promise<string>) => {
    if (!vault || !stable) return;
    setBusy(true);
    const tx = showTx(title, network);
    try {
      const acct = await getSigner();
      tx.success(await fn(acct));
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  /** Revoke's confirmation: destructive, and reached in one tap, so it asks before it signs. */
  const run = (title: string, fn: Parameters<typeof runNow>[1], message?: string) =>
    ask({title, message, gas: relayGasFor({}), run: () => runNow(title, fn)});

  // The sheet's own state: who, and for how long.
  const [open, setOpen] = useState(false);
  const [addr, setAddr] = useState('');
  const [days, setDays] = useState<number>(EXPIRIES[0].days);

  const onPress = () => {
    if (busy || !vault) return;
    setAddr(am && isSet(am.manager) ? am.manager : '');
    setDays(EXPIRIES[0].days);
    setOpen(true);
  };

  /**
   * Appointing signs from the editor itself: the address and the expiry are right there, and the
   * fee is on the button, so a second sheet asking the same question would be a step for its own
   * sake. Revoking still goes through the confirmation, because it is destructive and reached in
   * one tap.
   */
  const appoint = () => {
    if (!isPayableAddress(addr, network)) return;
    setOpen(false);
    const expiresAt = days === 0 ? 0n : BigInt(Math.floor(Date.now() / 1000) + days * 86400);
    void runNow(t('mobile.vault.appoint'), (acct) =>
      setAssetManager({account: acct, vault: vault!, network, manager: addr as Address, expiresAt, stableCoin: stable!.address}),
    );
  };

  const revoke = () => {
    setOpen(false);
    run(
      t('mobile.vault.revoke_manager_title'),
      (acct) => revokeAssetManager({account: acct, vault: vault!, network, stableCoin: stable!.address}),
      t('mobile.vault.revoke_manager_msg'),
    );
  };

  const editor = (
    <AssetManagerSheet
      visible={open}
      onClose={() => setOpen(false)}
      addr={addr}
      onAddr={setAddr}
      days={days}
      onDays={setDays}
      canRevoke={!!am && isSet(am.manager)}
      onAppoint={appoint}
      onRevoke={revoke}
    />
  );
  // Both nodes go out together: the editor, and the confirmation its buttons lead to.
  const sheets = (
    <>
      {editor}
      {sheet}
    </>
  );

  if (busy) return {value: '…', onPress, sheet: sheets};
  if (!am) return {onPress, sheet: sheets};
  const value = isSet(am.manager) ? shortAddress(am.manager) : undefined;
  const parts: string[] = [];
  if (isSet(am.manager)) parts.push(fmtExpiry(am.expiresAt));
  if (isSet(am.pendingManager)) parts.push(`${t('mobile.vault.pending_timelock')}: ${shortAddress(am.pendingManager)} · ${t('mobile.vault.applies', {when: fmtExpiry(am.pendingAt, 'on')})}`);
  return {value, sub: parts.length ? parts.join(' · ') : undefined, onPress, sheet: sheets};
}

/** The editor: an address, how long the appointment lasts, and the way out of an existing one. */
function AssetManagerSheet({
  visible,
  onClose,
  addr,
  onAddr,
  days,
  onDays,
  canRevoke,
  onAppoint,
  onRevoke,
}: {
  visible: boolean;
  onClose: () => void;
  addr: string;
  onAddr: (v: string) => void;
  days: number;
  onDays: (d: number) => void;
  canRevoke: boolean;
  onAppoint: () => void;
  onRevoke: () => void;
}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  // This sheet is its own component, so it reads the network rather than taking it as a prop.
  const network = useNetwork((s) => s.network);
  const bad = addr.length > 0 && !isPayableAddress(addr, network);
  return (
    <Sheet visible={visible} title={t('vault.asset_manager')} onClose={onClose}>
      <TextInput
        style={[styles.input, bad && styles.inputBad]}
        placeholder={t('mobile.vault.enter_manager_address')}
        placeholderTextColor={c.subtext}
        autoCapitalize="none"
        autoCorrect={false}
        value={addr}
        onChangeText={onAddr}
      />

      <Text style={styles.label}>{t('vault.expires')}</Text>
      <View style={styles.chips}>
        {EXPIRIES.map((e) => {
          const on = e.days === days;
          return (
            <Pressable key={e.label} style={[styles.chip, on && styles.chipOn]} onPress={() => onDays(e.days)}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {e.days === 0 ? t('mobile.vault.never_expires') : e.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.spacer} />
      {/* Appointing is the ordinary path, so it takes the Face ID button; revoking sits under it
          as the quieter, destructive way out, and is only there when there is one to revoke. */}
      <ConfirmButton onPress={onAppoint} disabled={!isPayableAddress(addr, network)} gas={relayGasFor({})} />
      {canRevoke ? (
        <Button title={t('vault.revoke')} variant="danger" onPress={onRevoke} />
      ) : null}
    </Sheet>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    input: {
      height: 52,
      borderRadius: 12,
      backgroundColor: c.input,
      paddingHorizontal: 16,
      color: c.text,
      fontSize: 15,
    },
    inputBad: {borderWidth: 1, borderColor: c.danger},
    label: {color: c.subtext, fontSize: 13, fontWeight: '600', marginTop: 4},
    chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    chip: {paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: c.border},
    chipOn: {borderColor: c.accent, backgroundColor: c.accentSoft},
    chipText: {color: c.subtext, fontSize: 14, fontWeight: '600'},
    chipTextOn: {color: c.text},
    spacer: {flex: 1},
  });

import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useDiscardGuard} from '@/components/DiscardGuard';
import {useNetwork} from '@/core/network-store';
import {useWallet} from '@/wallet/store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {isActivated} from '@/vault/activate';
import {getPendingChanges, type PendingChange} from '@/vault/risk';
import {
  getStableCoinAsGasConfig,
  setStableCoinAsGasLimits,
  STABLE_COIN_AS_GAS_MAX_DAILY,
  STABLE_COIN_AS_GAS_MAX_PER_OP,
  type StableCoinAsGasConfig,
} from '@/vault/stableCoinAsGas';
import {PickerSheet} from '@/components/AssetPicker';
import {makeSettingsStyles} from '@/components/SettingsRow';
import {Button} from '@/components/Button';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {GateHint, LockNotice} from '@/components/LockNotice';
import {useCapability} from '@/vault/gate';

type Field = 'maxFeePerOp' | 'dailyLimit';
const FIELDS: Field[] = ['maxFeePerOp', 'dailyLimit'];

/**
 * What the pickers offer, in whole dollars, up to the contract's ceilings ($10 per operation,
 * $100 per day). Never 0: a zero daily budget turns relaying off, and relaying is how this app
 * signs everything — the same trap the last fee coin's switch guards against.
 */
const CHOICES: Record<Field, number[]> = {
  maxFeePerOp: [1, 2, 5, STABLE_COIN_AS_GAS_MAX_PER_OP],
  dailyLimit: [10, 20, 50, STABLE_COIN_AS_GAS_MAX_DAILY],
};
const TITLE: Record<Field, string> = {
  maxFeePerOp: 'mobile.settings.gas_max_per_op',
  dailyLimit: 'mobile.settings.gas_max_daily',
};
/** The pending-changes kind each row's raise waits under. */
const PENDING_KIND: Record<Field, PendingChange['kind']> = {maxFeePerOp: 'maxFeePerOp', dailyLimit: 'gasBudgetDaily'};

/**
 * Network fee › Advanced settings: the two ceilings on what the relayer may bill the vault — per
 * operation and per 24 hours.
 *
 * Picked into a draft and written together by Save, in ONE Face-ID-gated write that keeps the
 * fee-coin list as it is (the vault sets coins and both caps in the same call). Lowering applies at
 * once; raising waits out the vault's timelock, and a raise still waiting shows under its row with
 * the moment it lands. Leaving with the draft unsaved asks whether to discard it, as Safety settings
 * does.
 */
export function NetworkFeeLimitsScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);

  const [cfg, setCfg] = useState<StableCoinAsGasConfig | null>(null);
  const [activated, setActivated] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [draft, setDraft] = useState<Partial<Record<Field, number>>>({});
  const [picking, setPicking] = useState<Field | null>(null);

  const load = useCallback(() => {
    if (!vault) return;
    isActivated(vault, network).then(setActivated).catch(() => setActivated(null));
    getStableCoinAsGasConfig(vault, network).then(setCfg);
    getPendingChanges(vault, network).then(setPending).catch(() => setPending([]));
  }, [vault, network]);
  useEffect(load, [load]);

  const {busy, ready, run, sheet} = useVaultWrite(() => {
    setDraft({});
    load();
  });

  // Before activation the vault starts on the system defaults; nothing is writable until it exists.
  const preActivation = activated === false;
  const current = (f: Field): number | null =>
    preActivation ? (f === 'dailyLimit' ? STABLE_COIN_AS_GAS_MAX_DAILY : STABLE_COIN_AS_GAS_MAX_PER_OP) : cfg ? Number(cfg[f]) : null;
  const value = (f: Field): number | null => draft[f] ?? current(f);
  const dirty = FIELDS.some((f) => draft[f] !== undefined && draft[f] !== current(f));
  // A lock freezes the fee limits as it does every other setting (vault/gate).
  const gasGate = useCapability('setTokenAsGas');
  const locked = !cfg || preActivation || busy !== null || !gasGate.allowed;

  // Leaving with changes unsaved asks first, by the back button or the swipe — before the page goes.
  const {edge} = useDiscardGuard(dirty && !busy, () => setDraft({}));

  const save = () => {
    if (!cfg) return;
    const maxFeePerOp = value('maxFeePerOp') ?? Number(cfg.maxFeePerOp);
    const dailyLimit = value('dailyLimit') ?? Number(cfg.dailyLimit);
    const what = FIELDS.filter((f) => draft[f] !== undefined && draft[f] !== current(f))
      .map((f) => `${t(TITLE[f])}: $${current(f)} → $${value(f)}`)
      .join('\n');
    run(
      'save',
      t('mobile.fees.advanced'),
      (b) => setStableCoinAsGasLimits({...b, coins: cfg.stableCoins as `0x${string}`[], dailyLimit, maxFeePerOp}),
      what,
    );
  };

  const row = (f: Field, last: boolean) => {
    const v = value(f);
    const p = pending.find((x) => x.kind === PENDING_KIND[f]);
    const when = p ? new Date(Number(p.at) * 1000).toLocaleString() : '';
    const changed = draft[f] !== undefined && draft[f] !== current(f);
    return (
      <Pressable key={f} style={[styles.row, !last && styles.rowDivider]} onPress={() => !locked && setPicking(f)} disabled={locked}>
        <View style={styles.titleCol}>
          <Text style={styles.rowTitle}>{t(TITLE[f])}</Text>
          {changed ? (
            <Text style={styles.sub}>{t('mobile.vault.unsaved_from', {value: `$${current(f)}`})}</Text>
          ) : p && 'value' in p ? (
            <Text style={styles.sub}>
              {t('mobile.vault.pending_timelock')}: ${Number(p.value)} · {t('mobile.vault.applies', {when: t('mobile.vault.on_date', {date: when})})}
            </Text>
          ) : null}
        </View>
        <View style={styles.amount}>
          <Text style={styles.rowValue}>{v != null ? `$${v}` : '—'}</Text>
          <Text style={[styles.chev, locked && styles.off]}>›</Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.fill}>
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
        <LockNotice />
        <View style={styles.group}>{FIELDS.map((f, i) => row(f, i === FIELDS.length - 1))}</View>
        <Button title={t('vault.save')} onPress={save} loading={busy === 'save'} disabled={!dirty || !ready || locked} />
        <GateHint gate={gasGate} />
        <PickerSheet
          visible={picking !== null}
          title={picking ? t(TITLE[picking]) : ''}
          items={(picking ? CHOICES[picking] : []).map((n) => ({key: String(n), label: `$${n}`}))}
          selected={picking && value(picking) != null ? String(value(picking)) : undefined}
          onSelect={(k) => {
            const f = picking;
            setPicking(null);
            if (f) setDraft((d) => ({...d, [f]: Number(k)}));
          }}
          onClose={() => setPicking(null)}
        />
        {sheet}
      </ScrollView>
      {edge}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    fill: {flex: 1},
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 20, paddingBottom: 32},
    titleCol: {flex: 1, gap: 2},
    sub: {color: c.subtext, fontSize: 12},
    amount: {flexDirection: 'row', alignItems: 'center', gap: 6},
    off: {opacity: 0.4},
  });

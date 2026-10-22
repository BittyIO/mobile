import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
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
import {useConfirmAction} from '@/components/ConfirmAction';
import {showTx} from '@/components/Toast';
import {relayGasFor} from '@/vault/fee-quote';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

type Field = 'maxFeePerOp' | 'dailyLimit';

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
 * Network fee › the two ceilings on what the relayer may bill: per operation and per 24 hours.
 * Lowering applies at once; raising waits out the vault's timelock, and a raise still waiting shows
 * under its row with the moment it lands. Each change is a gasless, Face-ID-gated write that keeps
 * the fee-coin list as it is.
 */
export function StableCoinAsGasLimits({
  leading,
}: {
  /**
   * A row drawn first in the same card — the page's fee reserve, which is a local setting and so
   * stays editable before activation, unlike the two ceilings.
   */
  leading?: {title: string; value: string; onPress: () => void};
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const feeCoin = useAssetCatalog(network).find((a) => a.kind === 'stable')?.address;
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [cfg, setCfg] = useState<StableCoinAsGasConfig | null>(null);
  const [activated, setActivated] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [picking, setPicking] = useState<Field | null>(null);
  const [busy, setBusy] = useState<Field | null>(null);
  const {ask, sheet} = useConfirmAction();

  const load = useCallback(() => {
    if (!vault) return;
    isActivated(vault, network).then(setActivated).catch(() => setActivated(null));
    getStableCoinAsGasConfig(vault, network).then(setCfg);
    getPendingChanges(vault, network).then(setPending).catch(() => setPending([]));
  }, [vault, network]);
  useEffect(load, [load]);

  // Before activation the vault starts on the system defaults; nothing is writable until it exists.
  const preActivation = activated === false;
  const value = (f: Field): bigint | null =>
    preActivation ? BigInt(f === 'dailyLimit' ? STABLE_COIN_AS_GAS_MAX_DAILY : STABLE_COIN_AS_GAS_MAX_PER_OP) : cfg ? cfg[f] : null;
  const locked = !cfg || preActivation || busy !== null;

  const write = async (f: Field, n: number) => {
    if (!vault || !cfg || !feeCoin) return;
    setBusy(f);
    const tx = showTx(`${t(TITLE[f])} · $${n}`, network);
    try {
      tx.success(
        await setStableCoinAsGasLimits({
          account: await getSigner(),
          vault,
          network,
          coins: cfg.stableCoins as `0x${string}`[],
          dailyLimit: f === 'dailyLimit' ? n : Number(cfg.dailyLimit),
          maxFeePerOp: f === 'maxFeePerOp' ? n : Number(cfg.maxFeePerOp),
          stableCoin: feeCoin,
        }),
      );
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const row = (f: Field, last: boolean) => {
    const v = value(f);
    const p = pending.find((x) => x.kind === PENDING_KIND[f]);
    const when = p ? new Date(Number(p.at) * 1000).toLocaleString() : '';
    return (
      <Pressable style={[styles.row, !last && styles.rowDivider]} onPress={() => !locked && setPicking(f)} disabled={locked}>
        <View style={styles.titleCol}>
          <Text style={styles.rowTitle}>{t(TITLE[f])}</Text>
          {p && 'value' in p ? (
            <Text style={styles.sub}>
              {t('mobile.vault.pending_timelock')}: ${Number(p.value)} · {t('mobile.vault.applies', {when: t('mobile.vault.on_date', {date: when})})}
            </Text>
          ) : null}
        </View>
        <View style={styles.amount}>
          <Text style={styles.rowValue}>{busy === f ? '…' : v != null ? `$${Number(v)}` : '—'}</Text>
          <Text style={[styles.chev, locked && styles.off]}>›</Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.group}>
        {leading ? (
          <Pressable style={[styles.row, styles.rowDivider]} onPress={leading.onPress}>
            <View style={styles.titleCol}>
              <Text style={styles.rowTitle}>{leading.title}</Text>
            </View>
            <View style={styles.amount}>
              <Text style={styles.rowValue}>{leading.value}</Text>
              <Text style={styles.chev}>›</Text>
            </View>
          </Pressable>
        ) : null}
        {row('maxFeePerOp', false)}
        {row('dailyLimit', true)}
      </View>
      <PickerSheet
        visible={picking !== null}
        title={picking ? t(TITLE[picking]) : ''}
        items={(picking ? CHOICES[picking] : []).map((n) => ({key: String(n), label: `$${n}`}))}
        selected={picking && value(picking) != null ? String(Number(value(picking))) : undefined}
        onSelect={(k) => {
          const f = picking;
          setPicking(null);
          if (!f || Number(k) === Number(value(f))) return;
          ask({
            title: t(TITLE[f]),
            message: `$${Number(value(f))} → $${k}`,
            gas: relayGasFor({}),
            run: () => write(f, Number(k)),
          });
        }}
        onClose={() => setPicking(null)}
      />
      {sheet}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    // No margin of its own: the page spaces its sections, and this one's was stacking on top.
    wrap: {gap: 8},
    titleCol: {flex: 1, gap: 2},
    sub: {color: c.subtext, fontSize: 12},
    amount: {flexDirection: 'row', alignItems: 'center', gap: 6},
    off: {opacity: 0.4},
  });

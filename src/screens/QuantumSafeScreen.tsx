import React, {useCallback, useEffect, useState} from 'react';
import {Alert, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import {useFocusEffect} from '@react-navigation/native';
import type {Address} from 'viem';
import {publicClientFor} from '@/core/chain';
import {FORWARDER_ABI, VAULT_FWD_ABI} from '@/core/abi';
import {shortAddress} from '@/core/format';
import {getLockLevel, getPendingChanges, getRiskConfig} from '@/vault/risk';
import {vaultOwnerOf} from '@/vault/owned-vaults';
import {handOverToFreshKey} from '@/vault/ownership';
import {Button} from '@/components/Button';
import {useCapability} from '@/vault/gate';
import {PendingRow} from '@/components/PendingRow';
import {QuantumInfoButton, QuantumKeys} from '@/components/QuantumHandover';
import {SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {fmtRiskValue} from '@/components/riskFormat';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useWallet} from '@/wallet/store';
import {hasOpenOrders, isOwnKey} from '@/wallet/rotation';
import {setRotationOn, useRotationOn, useRotationStore} from '@/wallet/rotation-store';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

type Note = 'elsewhere' | 'timelock' | 'fee' | 'orders' | 'phrase';
const NOTES: Note[] = ['elsewhere', 'timelock', 'fee', 'orders', 'phrase'];

/** One line-drawn mark per note (lucide Ban, Clock, Fuel, ListOrdered, KeyRound). */
function NoteIcon({name, color}: {name: Note; color: string}) {
  const st = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      {name === 'elsewhere' ? (
        <>
          <Circle cx={12} cy={12} r={10} {...st} />
          <Path d="M4.9 4.9l14.2 14.2" {...st} />
        </>
      ) : name === 'timelock' ? (
        <>
          <Circle cx={12} cy={12} r={10} {...st} />
          <Path d="M12 6v6l4 2" {...st} />
        </>
      ) : name === 'fee' ? (
        <Path d="M3 22h12M4 9h10M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.8a2 2 0 0 0-.6-1.4L18 5" {...st} />
      ) : name === 'orders' ? (
        <Path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" {...st} />
      ) : (
        <>
          <Path d="M2.6 18.2A2 2 0 0 0 2 19.6V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z" {...st} />
          <Circle cx={16.5} cy={7.5} r={0.5} {...st} />
        </>
      )}
    </Svg>
  );
}

type Status = {
  owner: Address | null;
  /** The owner key's public key is out: it has signed, here or (as far as the chain shows) anywhere. */
  used: boolean;
  pending: {address: Address; at: number} | null;
  timelock: bigint | null;
  locked: boolean;
  orders: boolean;
};

/**
 * Security › Quantum-safe keys — the vault moves to a fresh key of the same phrase after every
 * operation (see wallet/rotation).
 *
 * The switch, then — while it is on — which key holds the vault now and whether it has signed: a
 * fresh key, a used one already being handed on (the handover's ring), or a used one waiting for the
 * next operation, with a button to hand it on at once. Under it, what the feature asks of the user,
 * because the one thing the app cannot check is the one that matters most: that this phrase signs
 * nothing anywhere else.
 */
export function QuantumSafeScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const me = useWallet((s) => s.address);
  const [status, setStatus] = useState<Status | null>(null);
  // Re-derived when a key is marked used or learned, so the page follows a write made elsewhere.
  const usedHere = useRotationStore((s) => s.used);
  const keys = useRotationStore((s) => s.keys);

  const {vault, network, busy, ready, run, sheet} = useVaultWrite(() => load());
  const on = useRotationOn(network, vault);

  const load = useCallback(async () => {
    if (!vault) return;
    const client = publicClientFor(network);
    const [owner, pending, risk, lock, orders] = await Promise.all([
      vaultOwnerOf(network, vault),
      getPendingChanges(vault, network).catch(() => []),
      getRiskConfig(vault, network).catch(() => null),
      getLockLevel(vault, network).catch(() => 0),
      hasOpenOrders(vault, network).catch(() => false),
    ]);
    // Signed for this vault through the relayer: the forwarder has counted a request from it.
    const lane = owner
      ? await client
          .readContract({address: vault, abi: VAULT_FWD_ABI, functionName: 'trustedForwarder'})
          .then((fwd) => client.readContract({address: fwd, abi: FORWARDER_ABI, functionName: 'nonceFor', args: [owner, vault]}))
          .catch(() => 0n)
      : 0n;
    const p = pending.find((x) => x.kind === 'newOwner');
    setStatus({
      owner,
      used: !!owner && lane > 0n,
      pending: p && p.kind === 'newOwner' ? {address: p.address, at: Number(p.at)} : null,
      timelock: risk?.timelock ?? null,
      locked: lock !== 0,
      orders,
    });
  }, [vault, network]);
  useFocusEffect(useCallback(() => void load(), [load]));

  const [refreshing, setRefreshing] = useState(false);
  const onPull = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };

  // A clock for the handover's ring, ticking while the page is up.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  /**
   * Turning it on asks first, and says the one rule in so many words. Turning it off does not: the
   * vault simply stays with the key it has, and keeps every handover already queued.
   */
  const toggle = (next: boolean) => {
    if (!vault) return;
    if (!next) return setRotationOn(network, vault, false);
    Alert.alert(t('mobile.quantum.confirm_title'), t('mobile.quantum.confirm_body'), [
      {text: t('common.cancel'), style: 'cancel'},
      {text: t('mobile.quantum.confirm_button'), onPress: () => setRotationOn(network, vault, true)},
    ]);
  };

  const owner = status?.owner ?? null;
  const used = !!owner && (status?.used || !!usedHere[owner.toLowerCase()]);
  const ours = isOwnKey(owner, me);
  const pending = status?.pending ?? null;
  const freshPending = !!pending && !!keys[pending.address.toLowerCase()];

  // What happens next with the key in charge, when it is not already being handed on.
  const state = !owner
    ? 'inactive'
    : !used
      ? 'fresh'
      : pending
        ? 'handing'
        : status?.locked
          ? 'locked'
          : status?.orders
            ? 'orders'
            : 'used';
  const canHandOver = on && ours && state === 'used' && ready;
  const transferGate = useCapability('transferOwnership');

  const handOver = () =>
    canHandOver &&
    run('rotate', t('mobile.quantum.hand_over_now'), (b) => handOverToFreshKey(b), t('mobile.quantum.hand_over_confirm'));

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}>
      <SettingsGroup footer={t('mobile.quantum.about')}>
        <SettingsRow icon="quantum" title={t('mobile.quantum.title')} toggle={{value: on, onValueChange: toggle}} chevron={false} last />
      </SettingsGroup>

      {on && status ? (
        <View style={styles.section}>
          <SettingsGroup footer={t(`mobile.quantum.state_${state}`)}>
            <SettingsRow
              icon="recovery"
              title={t('mobile.quantum.owner_address')}
              value={owner ? shortAddress(owner) : undefined}
              chevron={false}
              last={!pending}
            />
            {pending ? (
              <PendingRow
                at={pending.at}
                now={now}
                timelock={Number(status.timelock ?? 0)}
                title={t(freshPending ? 'mobile.quantum.pending_title' : 'mobile.vault.pending_new_owner')}
                value={pending.address}
                titleRight={freshPending ? <QuantumInfoButton /> : undefined}
                detail={freshPending ? <QuantumKeys to={pending.address} /> : undefined}
                last
              />
            ) : null}
          </SettingsGroup>
          {state === 'used' && ours ? (
            <Button title={t('mobile.quantum.hand_over_now')} onPress={handOver} loading={busy === 'rotate'} disabled={!canHandOver} locked={!transferGate.allowed} />
          ) : null}
        </View>
      ) : null}

      {/* What it asks of the user. Said whether it is on or off: it is what to know before turning it on. */}
      <SettingsGroup>
        <View style={styles.notes}>
          {NOTES.map((n) => (
            <View key={n} style={styles.note}>
              <NoteIcon name={n} color={n === 'elsewhere' ? c.danger : c.accent} />
              <Text style={[styles.noteText, n === 'elsewhere' && styles.noteWarn]}>
                {t(`mobile.quantum.note_${n}`, {
                  time: status?.timelock != null ? fmtRiskValue('timelock', status.timelock, t) : '—',
                })}
              </Text>
            </View>
          ))}
        </View>
      </SettingsGroup>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    section: {gap: 16},
    notes: {padding: 16, gap: 14},
    note: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
    noteText: {flex: 1, color: c.text, fontSize: 14, lineHeight: 20},
    noteWarn: {color: c.danger, fontWeight: '600'},
  });

import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {GasIcon} from '@/components/GasIcon';
import {useNetwork} from '@/core/network-store';
import {quoteOwnerFeeWei, quoteRelayFeeUsd, TYPICAL_RELAY_GAS} from '@/vault/fee-quote';
import {formatNative} from '@/vault/direct';
import {NATIVE} from '@/core/chain';
import {Amount} from '@/components/Amount';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {isActivated} from '@/vault/activate';
import {ACTIVATION_FEE_USD} from '@/core/activation-fee';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

// Quotes are shared across every confirm surface and go stale slowly, so one read per network per
// minute is plenty. Without this each sheet opening re-read gas and the price feed.
const TTL_MS = 60_000;
const cache = new Map<string, {usd: number | null; at: number}>();
const ownerCache = new Map<string, {wei: bigint | null; at: number}>();

/**
 * The fee line above every Face ID confirm: a fuel pump and a figure, no words.
 *
 * Renders nothing at all when the quote cannot be read, because a blank is better than a wrong
 * number on the one line whose job is to prevent a surprise.
 *
 * `free` is for an action that sends no transaction — a CoW order on a vault that is already set up
 * is signed and posted off-chain, and costs nothing. That states the zero instead of quoting gas
 * for a relay that will not happen, and instead of hiding the line, which left the user to guess
 * whether the fee was nil or merely unknown.
 *
 * When the owner pays (see core/fee-payer-store) the figure is in ETH, because that is what leaves
 * the owner wallet — no dollar conversion, and no relayer margin, since no relayer is paid.
 */
export function NetworkFee({gas = TYPICAL_RELAY_GAS, free}: {gas?: bigint; free?: boolean}) {
  const network = useNetwork((s) => s.network);
  const {payer} = useActiveFeePayer(network);
  if (payer === 'owner' && !free) return <OwnerFee gas={gas} />;
  return <VaultFee gas={gas} free={free} />;
}

/** The fee in ETH, from the owner wallet. */
function OwnerFee({gas}: {gas: bigint}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const network = useNetwork((s) => s.network);
  const key = `${network}:${gas}`;
  const [wei, setWei] = useState<bigint | null>(() => {
    const hit = ownerCache.get(key);
    return hit && Date.now() - hit.at < TTL_MS ? hit.wei : null;
  });
  useEffect(() => {
    const hit = ownerCache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setWei(hit.wei);
      return;
    }
    let live = true;
    quoteOwnerFeeWei(network, gas).then((v) => {
      ownerCache.set(key, {wei: v, at: Date.now()});
      if (live) setWei(v);
    });
    return () => {
      live = false;
    };
  }, [key, network, gas]);
  if (wei == null) return null;
  return (
    <View style={styles.row}>
      <GasIcon color={c.subtext} />
      <Text style={styles.line}>
        <Amount v={formatNative(network, wei)} size={12} color={c.subtext} /> {NATIVE[network].symbol}
      </Text>
    </View>
  );
}

/** The fee in dollars, billed to the vault by the relayer. */
function VaultFee({gas, free}: {gas: bigint; free?: boolean}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const network = useNetwork((s) => s.network);
  const key = `${network}:${gas}`;
  const [usd, setUsd] = useState<number | null>(() => {
    const hit = cache.get(key);
    return hit && Date.now() - hit.at < TTL_MS ? hit.usd : null;
  });

  useEffect(() => {
    if (free) return;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setUsd(hit.usd);
      return;
    }
    let live = true;
    quoteRelayFeeUsd(network, gas).then((v) => {
      cache.set(key, {usd: v, at: Date.now()});
      if (live) setUsd(v);
    });
    return () => {
      live = false;
    };
  }, [key, network, gas, free]);

  if (free) {
    return (
      <View style={styles.row}>
        <GasIcon color={c.subtext} />
        <Text style={styles.line}>$0</Text>
      </View>
    );
  }
  if (usd == null) return null;
  // Sub-cent fees are the norm on an L2, so cents would print "$0.01" for everything and hide the
  // difference between a plain swap and one that unwinds two positions first. The switch to cents
  // waits until a dime, well clear of where L2 fees sit, so a heavier operation crossing one cent
  // does not suddenly lose the precision that made it comparable.
  const shown = usd >= 0.1 ? `$${usd.toFixed(2)}` : usd >= 0.0001 ? `$${usd.toFixed(4)}` : '<$0.0001';
  return (
    <View style={styles.row}>
      <GasIcon color={c.subtext} />
      <Text style={styles.line}>{shown}</Text>
    </View>
  );
}

/**
 * Whether the vault in front on this network will be activated by the next write the vault pays
 * for: not deployed yet, and the relayer paying (from the owner key the activation is the owner's
 * own gas, with no activation fee). False until the chain has answered.
 */
export function useActivationDue(): boolean {
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const {payer} = useActiveFeePayer(network);
  const [activated, setActivated] = useState<boolean | null>(null);
  useEffect(() => {
    setActivated(null);
    if (!vault) return;
    let live = true;
    isActivated(vault, network)
      .then((v) => live && setActivated(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vault, network]);
  return payer !== 'owner' && activated === false;
}

/** The activation fee, at the top left of a confirm button: "Activation $1.00". */
export function ActivationFee({usd = ACTIVATION_FEE_USD}: {usd?: number}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  return <Text style={styles.line}>{t('mobile.fees.activation_fee', {fee: `$${usd.toFixed(2)}`})}</Text>;
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5, paddingRight: 4},
    line: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
  });

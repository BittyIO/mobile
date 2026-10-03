import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {GasIcon} from '@/components/GasIcon';
import {useNetwork} from '@/core/network-store';
import {quoteRelayFeeUsd, TYPICAL_RELAY_GAS} from '@/vault/fee-quote';
import {useColors, useStyles, type Colors} from '@/theme';

// Quotes are shared across every confirm surface and go stale slowly, so one read per network per
// minute is plenty. Without this each sheet opening re-read gas and the price feed.
const TTL_MS = 60_000;
const cache = new Map<string, {usd: number | null; at: number}>();

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
 */
export function NetworkFee({gas = TYPICAL_RELAY_GAS, free}: {gas?: bigint; free?: boolean}) {
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

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5, paddingRight: 4},
    line: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
  });

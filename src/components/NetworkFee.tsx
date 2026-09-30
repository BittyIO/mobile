import React, {useEffect, useState} from 'react';
import {StyleSheet, Text} from 'react-native';
import {useNetwork} from '@/core/network-store';
import {quoteRelayFeeUsd, TYPICAL_RELAY_GAS} from '@/vault/fee-quote';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

// Quotes are shared across every confirm surface and go stale slowly, so one read per network per
// minute is plenty. Without this each sheet opening re-read gas and the price feed.
const TTL_MS = 60_000;
const cache = new Map<string, {usd: number | null; at: number}>();

/**
 * "Estimated network fee $0.01", the line above every Face ID confirm.
 *
 * Renders nothing at all when the quote cannot be read, because a blank is better than a wrong
 * number on the one line whose job is to prevent a surprise.
 */
export function NetworkFee({gas = TYPICAL_RELAY_GAS}: {gas?: bigint}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const key = `${network}:${gas}`;
  const [usd, setUsd] = useState<number | null>(() => {
    const hit = cache.get(key);
    return hit && Date.now() - hit.at < TTL_MS ? hit.usd : null;
  });

  useEffect(() => {
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
  }, [key, network, gas]);

  if (usd == null) return null;
  // Sub-cent fees are the norm on an L2, so cents would print "$0.01" for everything and hide the
  // difference between a plain swap and one that unwinds two positions first. The switch to cents
  // waits until a dime, well clear of where L2 fees sit, so a heavier operation crossing one cent
  // does not suddenly lose the precision that made it comparable.
  const shown = usd >= 0.1 ? `$${usd.toFixed(2)}` : usd >= 0.0001 ? `$${usd.toFixed(4)}` : '<$0.0001';
  return <Text style={styles.line}>{t('mobile.vault.est_network_fee', {amount: shown})}</Text>;
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    line: {color: c.subtext, fontSize: 12, textAlign: 'right', paddingRight: 4},
  });

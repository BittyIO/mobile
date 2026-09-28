import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {Defs, LinearGradient, Path, Stop} from 'react-native-svg';
import {fmtUsd, COINGECKO_ID as SHARED_ID} from '@/core/prices';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

// Base symbol → CoinGecko id (for USD price history): the shared price map, with the wrapped BTC
// tokens charted as themselves rather than as bitcoin.
const COINGECKO_ID: Record<string, string> = {
  ...SHARED_ID,
  WBTC: 'wrapped-bitcoin',
  cbBTC: 'coinbase-wrapped-btc',
};

// Range pills; `label` is the web translation key for the period name.
const RANGES: {label: string; days: number}[] = [
  {label: 'vault.period_24h', days: 1},
  {label: 'vault.period_1w', days: 7},
  {label: 'vault.period_1m', days: 30},
  {label: 'vault.period_1y', days: 365},
];

const H = 150;

/** Price chart for a base asset — CoinGecko USD history, line + area, green up / red down. Mirrors web PriceChart. */
export function PriceChart({symbol}: {symbol: string}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const [rangeIdx, setRangeIdx] = useState(1); // 1W
  const [pts, setPts] = useState<[number, number][] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const id = COINGECKO_ID[symbol];

  useEffect(() => {
    if (!id) {
      setPts(null);
      setError(true);
      return;
    }
    let live = true;
    setLoading(true);
    setError(false);
    const days = RANGES[rangeIdx].days;
    fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        const arr = Array.isArray(j?.prices) ? (j.prices as [number, number][]) : [];
        setPts(arr.length >= 2 ? arr : null);
      })
      .catch(() => live && setError(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id, rangeIdx]);

  const g = useMemo(() => {
    if (!pts) return null;
    const ys = pts.map((p) => p[1]);
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const span = max - min || 1;
    const n = ys.length;
    const path = ys.map((y, i) => `${i ? 'L' : 'M'}${((i / (n - 1)) * 100).toFixed(2)} ${(100 - ((y - min) / span) * 96 - 2).toFixed(2)}`).join(' ');
    const first = ys[0];
    const last = ys[n - 1];
    const changePct = first ? (last / first - 1) * 100 : 0;
    return {min, max, path, area: `${path} L100 100 L0 100 Z`, up: last >= first, changePct, last};
  }, [pts]);

  const color = g ? (g.up ? c.success : c.danger) : c.subtext;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <Text style={styles.price}>{g ? fmtUsd(g.last) : '—'}</Text>
          {g ? (
            <Text style={[styles.change, {color: g.changePct >= 0 ? c.success : c.danger}]}>
              {g.changePct >= 0 ? '+' : ''}
              {g.changePct.toFixed(2)}%
            </Text>
          ) : null}
        </View>
        <View style={styles.ranges}>
          {RANGES.map((r, i) => (
            <Pressable key={r.label} onPress={() => setRangeIdx(i)} style={[styles.pill, rangeIdx === i && styles.pillOn]}>
              <Text style={[styles.pillText, rangeIdx === i && styles.pillTextOn]}>{t(r.label)}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.plot}>
        {loading && !g ? (
          <ActivityIndicator color={c.accent} />
        ) : g ? (
          <>
            <Text style={[styles.corner, styles.top]}>{fmtUsd(g.max)}</Text>
            <Svg width="100%" height={H} viewBox="0 0 100 100" preserveAspectRatio="none">
              <Defs>
                <LinearGradient id="pcArea" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={color} stopOpacity={0.25} />
                  <Stop offset="1" stopColor={color} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Path d={g.area} fill="url(#pcArea)" />
              <Path d={g.path} stroke={color} strokeWidth={1.6} fill="none" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </Svg>
            <Text style={[styles.corner, styles.bottom]}>{fmtUsd(g.min)}</Text>
          </>
        ) : (
          <Text style={styles.msg}>{error ? t('vault.price_unavailable') : ''}</Text>
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 8},
  head: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  headLeft: {flexDirection: 'row', alignItems: 'baseline', gap: 8},
  price: {color: c.text, fontSize: 22, fontWeight: '700'},
  change: {fontSize: 13, fontWeight: '600'},
  ranges: {flexDirection: 'row', gap: 4},
  pill: {paddingVertical: 4, paddingHorizontal: 8, borderRadius: 7},
  pillOn: {backgroundColor: c.bg},
  pillText: {color: c.subtext, fontSize: 11, fontWeight: '600'},
  pillTextOn: {color: c.text},
  plot: {height: H, justifyContent: 'center', position: 'relative'},
  corner: {position: 'absolute', right: 0, color: c.subtext, fontSize: 10, fontVariant: ['tabular-nums']},
  top: {top: 0},
  bottom: {bottom: 0},
  msg: {color: c.subtext, fontSize: 13, textAlign: 'center'},
});

import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import Svg, {Circle} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {fmtUsd} from '@/core/prices';
import {displaySymbol} from '@/core/format';
import {useColors, useStyles, type Colors} from '@/theme';

export type PieSlice = {symbol: string; icon?: string; usd: number};

// Two decimals, and a floor rather than a rounded-away zero: a real holding that works out to a
// hundredth of a percent or less still says it is there ("< 0.01%"), never "0.00%".
const fmtPct = (p: number): string => (p > 0 && p < 0.01 ? '< 0.01%' : `${p.toFixed(2)}%`);

/**
 * Colours for the segments, in order of the largest holding down. A fixed, distinct-enough set that
 * cycles if a vault holds more assets than there are — the legend names each one anyway, so the
 * colour is a cross-reference, not the identity.
 */
const PALETTE = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4',
  '#ec4899', '#84cc16', '#fb7185', '#14b8a6', '#eab308', '#8b5cf6',
];

/**
 * A holdings-distribution donut with a legend — each asset's share of the total, largest first.
 *
 * The slices are passed already filtered and summed (the caller drops dust so a cent of some token
 * is not a sliver nobody can see), so the ring is the whole of what is shown and the percentages
 * are of that same total. The centre carries the total value; the legend names each asset with its
 * colour, its share, and what it is worth.
 */
export function PortfolioPie({slices, total}: {slices: PieSlice[]; total: number}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const SIZE = 150;
  const SW = 20;
  const R = (SIZE - SW) / 2;
  const C = 2 * Math.PI * R;
  const denom = total > 0 ? total : 1;

  let cum = 0;
  const segs = slices.map((s, i) => {
    const frac = Math.max(0, s.usd / denom);
    const seg = {color: PALETTE[i % PALETTE.length], frac, offset: cum};
    cum += frac;
    return seg;
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.donutWrap}>
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke={c.border} strokeWidth={SW} fill="none" />
          {segs.map((seg, i) =>
            seg.frac > 0 ? (
              <Circle
                key={i}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                stroke={seg.color}
                strokeWidth={SW}
                fill="none"
                strokeDasharray={`${C * seg.frac} ${C * (1 - seg.frac)}`}
                strokeDashoffset={-C * seg.offset}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              />
            ) : null,
          )}
        </Svg>
        <View style={styles.center} pointerEvents="none">
          <Text style={styles.centerVal} numberOfLines={1}>
            {fmtUsd(total)}
          </Text>
        </View>
      </View>

      <ScrollView style={styles.legend} contentContainerStyle={styles.legendContent} showsVerticalScrollIndicator={false}>
        {slices.map((s, i) => (
          <View key={s.symbol} style={styles.row}>
            <View style={[styles.dot, {backgroundColor: PALETTE[i % PALETTE.length]}]} />
            <TokenIcon symbol={s.symbol} size={24} uri={s.icon} />
            <Text style={styles.sym} numberOfLines={1}>
              {displaySymbol(s.symbol)}
            </Text>
            <Text style={styles.pct}>{fmtPct(total > 0 ? (s.usd / total) * 100 : 0)}</Text>
            <Text style={styles.val}>{fmtUsd(s.usd)}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {gap: 18, alignItems: 'stretch'},
    donutWrap: {width: 150, height: 150, alignSelf: 'center', alignItems: 'center', justifyContent: 'center'},
    center: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
    centerVal: {color: c.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums']},
    legend: {alignSelf: 'stretch'},
    legendContent: {gap: 12, paddingBottom: 4},
    row: {flexDirection: 'row', alignItems: 'center', gap: 10},
    dot: {width: 10, height: 10, borderRadius: 5},
    sym: {color: c.text, fontSize: 15, fontWeight: '600', flex: 1},
    pct: {color: c.subtext, fontSize: 14, fontVariant: ['tabular-nums'], width: 68, textAlign: 'right'},
    val: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'], minWidth: 72, textAlign: 'right'},
  });

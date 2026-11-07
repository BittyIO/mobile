import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Svg, {Circle} from 'react-native-svg';
import {fmtUsd} from '@/core/prices';
import {fmtNum, displaySymbol} from '@/core/format';
import type {Position} from '@/vault/position';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * The asset's position, above the Buy/Sell button — what the owner holds and how it is doing, so
 * the decision to trade is made next to its result rather than away from it.
 *
 * Header: the held amount on the left, the day's move on the right. Body: a vertical rule splitting
 * cost (market value, average price, cost basis) from return (unrealized, realized, total %). Every
 * figure is the SERVER's — see {Position} — so the panel only formats and colours.
 *
 * A gain is green and a loss red; an unknown figure is a dash, never a zero, because "we could not
 * price this" and "this has not moved" are different answers.
 */
export function PositionPanel({
  position,
  portfolioValue = 0,
  bare = false,
  loading = false,
  noPercent = false,
}: {
  position: Position;
  portfolioValue?: number;
  bare?: boolean;
  /** Figures still in flight: every value renders as a dash, exactly like the balance lines. */
  loading?: boolean;
  /**
   * Dollars only: no P&L percentage and no portfolio-share donut, and no market value (the caller
   * heads the card with it) — a 2×2 grid, for the Distribution page's position cards.
   */
  noPercent?: boolean;
}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);

  // While the fetch is in flight nothing is known, so nothing is shown as a number — a panel of
  // zeros that then snap to the real figures reads as "it was 0 a moment ago", which it never was.
  // Once loaded, a missing figure reads as 0, not a dash: the panel then shows a full set of
  // numbers, even before any trade has given them a value.
  const DASH = '—';
  const signedUsd = (v: number | null) => {
    if (loading) return {text: DASH, color: c.text};
    const n = v ?? 0;
    const sign = n > 1e-9 ? '+' : n < -1e-9 ? '−' : '';
    return {text: sign + fmtUsd(Math.abs(n)), color: sign === '+' ? c.success : sign === '−' ? c.danger : c.text};
  };
  const signedPct = (v: number | null) => {
    if (loading) return {text: DASH, color: c.text};
    const n = v ?? 0;
    const sign = n > 0.05 ? '+' : n < -0.05 ? '−' : '';
    return {text: `${sign}${Math.abs(n).toFixed(1)}%`, color: sign === '+' ? c.success : sign === '−' ? c.danger : c.text};
  };
  const plain = (v: number | null) => (loading ? DASH : fmtUsd(v ?? 0));

  const today = signedUsd(position.todayPnl);
  const unrealized = signedUsd(position.unrealizedPnl);
  const realized = signedUsd(position.realizedPnl);
  const pct = signedPct(position.pnlPct);

  const Cell = ({label, value, color}: {label: string; value: string; color?: string}) => (
    <View style={styles.cell}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.value, color ? {color} : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );

  // The portfolio-share donut: the accent arc is this asset's slice, the track ring the rest. The
  // slice is this holding's market value against the whole portfolio total (passed in, computed the
  // same way the Overview totals it), so the share matches what the user sees elsewhere.
  const SIZE = 104;
  const SW = 14;
  const R = (SIZE - SW) / 2;
  const C = 2 * Math.PI * R;
  const assetValue = position.marketValue ?? 0;
  const sharePct = portfolioValue > 0 ? (assetValue / portfolioValue) * 100 : 0;
  const share = Math.max(0, Math.min(1, sharePct / 100));
  const othersValue = Math.max(0, portfolioValue - assetValue);

  return (
    <View style={bare ? styles.bare : styles.card}>
      <View style={styles.head}>
        <Text style={styles.amount} numberOfLines={1}>
          {loading ? DASH : fmtNum(position.amount)} {displaySymbol(position.symbol)}
        </Text>
        <View style={styles.todayWrap}>
          <Text style={styles.todayLabel}>{t('mobile.trade.today_pnl')}</Text>
          <Text style={[styles.today, {color: today.color}]} numberOfLines={1}>
            {today.text}
          </Text>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.col}>
          {/* Without the percentages the market value is already the card's own heading, so it is
              left out here and the grid stays even: cost on the left, P&L on the right. */}
          {noPercent ? null : <Cell label={t('mobile.trade.market_value')} value={plain(position.marketValue)} />}
          <Cell label={t('mobile.trade.average_price')} value={plain(position.avgPrice)} />
          <Cell label={t('mobile.trade.cost_basis')} value={plain(position.costBasis)} />
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <Cell label={t('mobile.trade.unrealized_pnl')} value={unrealized.text} color={unrealized.color} />
          <Cell label={t('mobile.trade.realized_pnl')} value={realized.text} color={realized.color} />
          {noPercent ? null : <Cell label={t('mobile.trade.pnl_pct')} value={pct.text} color={pct.color} />}
        </View>
      </View>

      {/* How much of the whole portfolio this asset is — a donut with the share, and a legend
          naming the two sides by value. */}
      {noPercent ? null : (
      <View style={styles.pie}>
        <View style={styles.donutWrap}>
          <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
            <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke={c.border} strokeWidth={SW} fill="none" />
            {share > 0 ? (
              <Circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                stroke={c.accent}
                strokeWidth={SW}
                fill="none"
                strokeDasharray={`${C * share} ${C}`}
                strokeLinecap="round"
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              />
            ) : null}
          </Svg>
          <View style={styles.donutCenter} pointerEvents="none">
            <Text style={styles.donutPct}>{loading ? DASH : `${sharePct.toFixed(1)}%`}</Text>
          </View>
        </View>
        <View style={styles.legend}>
          <Text style={styles.legendTitle}>{t('mobile.trade.portfolio_share')}</Text>
          <View style={styles.legendRow}>
            <View style={[styles.legendDot, {backgroundColor: c.accent}]} />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {displaySymbol(position.symbol)}
            </Text>
            <Text style={styles.legendVal}>{loading ? DASH : fmtUsd(position.marketValue ?? 0)}</Text>
          </View>
          <View style={styles.legendRow}>
            <View style={[styles.legendDot, {backgroundColor: c.border}]} />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {t('mobile.trade.others')}
            </Text>
            <Text style={styles.legendVal}>{loading ? DASH : fmtUsd(othersValue)}</Text>
          </View>
        </View>
      </View>
      )}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 12},
    // Inside a sheet the card chrome is the sheet's own, so drop the background and the horizontal
    // padding — the columns get that width back, which is what lets a figure like "−$139.76" sit on
    // its label's line instead of being clipped.
    bare: {gap: 14},
    head: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8},
    amount: {color: c.text, fontSize: 16, fontWeight: '700', flexShrink: 1, fontVariant: ['tabular-nums']},
    todayWrap: {flexDirection: 'row', alignItems: 'baseline', gap: 6},
    todayLabel: {color: c.subtext, fontSize: 12},
    today: {fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums']},
    body: {flexDirection: 'row', alignItems: 'stretch'},
    col: {flex: 1, gap: 7},
    divider: {width: StyleSheet.hairlineWidth, backgroundColor: c.border, marginHorizontal: 12},
    cell: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 6},
    label: {color: c.subtext, fontSize: 12, flexShrink: 1},
    value: {color: c.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 0},
    // The portfolio-share donut and its legend, divided from the figures above by a hairline.
    pie: {flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 2, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    donutWrap: {width: 104, height: 104, alignItems: 'center', justifyContent: 'center'},
    donutCenter: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
    donutPct: {color: c.text, fontSize: 19, fontWeight: '800', fontVariant: ['tabular-nums']},
    legend: {flex: 1, gap: 10},
    legendTitle: {color: c.subtext, fontSize: 12, marginBottom: 2},
    legendRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
    legendDot: {width: 10, height: 10, borderRadius: 5},
    legendLabel: {color: c.text, fontSize: 13, fontWeight: '600', flexShrink: 1},
    legendVal: {color: c.subtext, fontSize: 13, marginLeft: 'auto', fontVariant: ['tabular-nums']},
  });

import React, {useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {formatUnits} from 'viem';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {fmtNum} from '@/core/format';
import type {DailyEarnings as Data, DailyEarning} from '@/vault/daily-earnings';

/** Rows shown at a time in the list, as on History: ten, then ten more on request. */
const PAGE = 10;

/**
 * An Earn position's earnings, day by day: a month calendar, or a list.
 *
 * Every date here is a UTC day — the server's one calendar for everyone — so dates are formatted
 * in UTC too: a phone in Sydney must not show the 4th's figure under the 5th.
 */
export function DailyEarningsCard({
  data,
  error,
  decimals,
  symbol,
  showTitle = true,
}: {
  data: Data | null;
  error: boolean;
  decimals: number | undefined;
  symbol: string;
  /** Off on its own page, where the navigation bar already names it. */
  showTitle?: boolean;
}) {
  const {t, language} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');

  const amount = (raw: bigint) => (decimals == null ? 0 : Number(formatUnits(raw, decimals)));

  return (
    <View style={styles.card}>
      <View style={[styles.head, !showTitle && styles.headEnd]}>
        {showTitle ? <Text style={styles.title}>{t('mobile.earn.daily_title')}</Text> : null}
        <View style={styles.seg}>
          {(['calendar', 'list'] as const).map((v) => (
            <Pressable key={v} onPress={() => setView(v)} style={[styles.segBtn, view === v && styles.segOn]} accessibilityRole="button" accessibilityState={{selected: view === v}}>
              <Text style={[styles.segText, view === v && styles.segTextOn]}>{t(v === 'calendar' ? 'mobile.earn.daily_calendar' : 'mobile.earn.daily_list')}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {!data ? (
        error ? (
          <Text style={styles.note}>{t('mobile.earn.daily_failed')}</Text>
        ) : (
          <ActivityIndicator color={c.subtext} style={styles.spinner} />
        )
      ) : data.days.length === 0 ? (
        <Text style={styles.note}>{t('mobile.earn.daily_none')}</Text>
      ) : view === 'calendar' ? (
        <Calendar data={data} amount={amount} symbol={symbol} locale={language} />
      ) : (
        <DayList days={data.days} amount={amount} symbol={symbol} locale={language} />
      )}
    </View>
  );
}

/** "+0.0123", "−0.01", "0", or "—" for a day the server could not account for. */
function signed(v: number | null): string {
  if (v == null) return '—';
  if (v === 0) return '0';
  return `${v > 0 ? '+' : '−'}${fmtNum(Math.abs(v))}`;
}

/** The figure in a calendar cell, which has room for about six characters. */
function compact(v: number): string {
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e6) s = `${(a / 1e6).toFixed(1)}M`;
  else if (a >= 1e4) s = `${(a / 1e3).toFixed(0)}K`;
  else if (a >= 100) s = a.toFixed(0);
  else if (a >= 1) s = String(Number(a.toFixed(2)));
  else if (a >= 0.0001) s = String(Number(a.toPrecision(2)));
  else s = fmtNum(a);
  return (v < 0 ? '−' : '+') + s;
}

const utcLabel = (day: string, locale: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {...opts, timeZone: 'UTC'});

function Calendar({data, amount, symbol, locale}: {data: Data; amount: (raw: bigint) => number; symbol: string; locale: string}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const byDay = useMemo(() => new Map(data.days.map((d) => [d.day, d])), [data]);
  const lastMonth = data.today.slice(0, 7);
  const firstMonth = data.days[data.days.length - 1].day.slice(0, 7);
  const [month, setMonth] = useState(lastMonth);
  const [picked, setPicked] = useState<string | null>(null);

  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = first.getUTCDay(); // Sunday first, as the iOS calendar
  const cells: (string | null)[] = [...Array(lead).fill(null)];
  for (let d = 1; d <= daysIn; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);

  const shift = (by: number) => {
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    setMonth(d.toISOString().slice(0, 7));
    setPicked(null);
  };
  const monthTotal = data.days
    .filter((d) => d.day.startsWith(month) && d.earned != null)
    .reduce((s, d) => s + amount(d.earned as bigint), 0);
  // A week's initials, in the reader's language: 4–10 Jan 1970 ran Sunday to Saturday.
  const weekdays = [4, 5, 6, 7, 8, 9, 10].map((d) => utcLabel(`1970-01-${String(d).padStart(2, '0')}`, locale, {weekday: 'narrow'}));
  const pickedDay = picked ? byDay.get(picked) : undefined;

  return (
    <View>
      <View style={styles.monthBar}>
        <Pressable onPress={() => shift(-1)} disabled={month <= firstMonth} hitSlop={10} style={month <= firstMonth && styles.off} accessibilityRole="button">
          <Chevron left color={c.accent} />
        </Pressable>
        <View style={styles.monthText}>
          <Text style={styles.monthName}>{utcLabel(`${month}-01`, locale, {month: 'long', year: 'numeric'})}</Text>
          <Text style={[styles.monthTotal, monthTotal > 0 && {color: c.success}]}>{`${signed(monthTotal)} ${symbol}`}</Text>
        </View>
        <Pressable onPress={() => shift(1)} disabled={month >= lastMonth} hitSlop={10} style={month >= lastMonth && styles.off} accessibilityRole="button">
          <Chevron color={c.accent} />
        </Pressable>
      </View>
      <View style={styles.grid}>
        {weekdays.map((w, i) => (
          <Text key={`w${i}`} style={styles.weekday}>
            {w}
          </Text>
        ))}
        {cells.map((day, i) => {
          if (!day) return <View key={`e${i}`} style={styles.cell} />;
          const e = byDay.get(day);
          const v = e && e.earned != null ? amount(e.earned) : null;
          const isToday = day === data.today;
          return (
            <Pressable key={day} style={[styles.cell, picked === day && styles.cellPicked]} onPress={() => setPicked(e ? day : null)} disabled={!e}>
              <Text style={[styles.dayNum, isToday && styles.today, !e && styles.dayIdle]}>{Number(day.slice(8))}</Text>
              {e ? (
                <Text style={[styles.dayAmt, v != null && v > 0 && {color: c.success}, v != null && v < 0 && {color: c.danger}]} numberOfLines={1} adjustsFontSizeToFit>
                  {v == null ? '—' : v === 0 ? '0' : compact(v)}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {pickedDay ? <DayRow d={pickedDay} amount={amount} symbol={symbol} locale={locale} /> : null}
    </View>
  );
}

function DayList({days, amount, symbol, locale}: {days: DailyEarning[]; amount: (raw: bigint) => number; symbol: string; locale: string}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const [shown, setShown] = useState(PAGE);
  return (
    <View>
      {days.slice(0, shown).map((d) => (
        <DayRow key={d.day} d={d} amount={amount} symbol={symbol} locale={locale} />
      ))}
      {shown < days.length ? (
        <Pressable onPress={() => setShown((n) => n + PAGE)} style={styles.more} accessibilityRole="button">
          <Text style={styles.moreText}>{t('mobile.earn.daily_more')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DayRow({d, amount, symbol, locale}: {d: DailyEarning; amount: (raw: bigint) => number; symbol: string; locale: string}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const v = d.earned != null ? amount(d.earned) : null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowDate}>{utcLabel(d.day, locale, {weekday: 'short', month: 'short', day: 'numeric'})}</Text>
      <Text style={[styles.rowAmt, v != null && v > 0 && {color: c.success}, v != null && v < 0 && {color: c.danger}]}>
        {v == null ? '—' : `${signed(v)} ${symbol}`}
      </Text>
    </View>
  );
}

function Chevron({left, color}: {left?: boolean; color: string}) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path d={left ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} stroke={color} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 12},
    head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
    headEnd: {justifyContent: 'flex-end'},
    title: {color: c.text, fontSize: 17, fontWeight: '700', flexShrink: 1},
    seg: {flexDirection: 'row', backgroundColor: c.bg, borderRadius: 10, padding: 2},
    segBtn: {paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8},
    segOn: {backgroundColor: c.accentSoft},
    segText: {color: c.subtext, fontSize: 13, fontWeight: '600'},
    segTextOn: {color: c.accent},
    spinner: {paddingVertical: 24},
    note: {color: c.subtext, fontSize: 14, textAlign: 'center', paddingVertical: 16},
    monthBar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8},
    monthText: {alignItems: 'center', gap: 2},
    monthName: {color: c.text, fontSize: 15, fontWeight: '700'},
    monthTotal: {color: c.subtext, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
    off: {opacity: 0.3},
    grid: {flexDirection: 'row', flexWrap: 'wrap'},
    weekday: {width: `${100 / 7}%`, textAlign: 'center', color: c.subtext, fontSize: 12, fontWeight: '600', paddingBottom: 6},
    cell: {width: `${100 / 7}%`, height: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 10, gap: 2},
    cellPicked: {backgroundColor: c.accentSoft},
    dayNum: {color: c.text, fontSize: 14, fontWeight: '600'},
    today: {color: c.accent},
    dayIdle: {color: c.subtext, fontWeight: '400'},
    dayAmt: {color: c.subtext, fontSize: 10, fontVariant: ['tabular-nums'], paddingHorizontal: 2},
    row: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, gap: 12},
    rowDate: {color: c.text, fontSize: 14},
    rowAmt: {color: c.subtext, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right'},
    more: {alignItems: 'center', paddingTop: 12},
    moreText: {color: c.accent, fontSize: 14, fontWeight: '600'},
  });

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Svg, {Circle} from 'react-native-svg';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

type T = ReturnType<typeof useT>['t'];

/** Time left in one unit, the largest that is not zero: 12 days, 5 hours, 40 min, 9 sec. */
export function leftUnit(left: number, t: T): [number, string] {
  const s = Math.max(0, Math.floor(left));
  if (s >= 86_400) return [Math.floor(s / 86_400), t('mobile.vault.unit_days')];
  if (s >= 3600) return [Math.floor(s / 3600), t('mobile.vault.unit_hours')];
  if (s >= 60) return [Math.floor(s / 60), t('mobile.vault.unit_minutes')];
  return [s, t('mobile.vault.unit_seconds')];
}

/**
 * Time left in the two largest units, short labels, for the ring: 12d 5h, 5h 40m, 40m 9s — or the
 * seconds alone in the last minute. One unit alone jumped from "1 hours" straight to "59 min".
 */
export function leftUnits(left: number, t: T): [number, string][] {
  const s = Math.max(0, Math.floor(left));
  if (s >= 86_400) return [[Math.floor(s / 86_400), t('mobile.vault.unit_d')], [Math.floor((s % 86_400) / 3600), t('mobile.vault.unit_h')]];
  if (s >= 3600) return [[Math.floor(s / 3600), t('mobile.vault.unit_h')], [Math.floor((s % 3600) / 60), t('mobile.vault.unit_m')]];
  if (s >= 60) return [[Math.floor(s / 60), t('mobile.vault.unit_m')], [s % 60, t('mobile.vault.unit_s')]];
  return [[s, t('mobile.vault.unit_s')]];
}

/** How far a wait has run, 0 to 1, given when it ends and how long it is. */
export function waitDone(at: number, now: number, length: number): number {
  return length > 0 ? Math.min(1, Math.max(0, 1 - (at - now) / length)) : 1;
}

/**
 * How far an item is through its timelock: the arc is the time passed, the track the time left.
 * Red in the last tenth, the window that is nearly shut. Large enough, the middle says the time
 * left in two units, one above the other; small, it is the ring alone and the caller writes the time beside it.
 *
 * `calm` keeps it blue to the end: for an ESTIMATE (Lido's queue), where nothing shuts and red
 * would claim a deadline there is not.
 */
export function ProgressRing({done, left, size = 56, calm = false}: {done: number; left: number; size?: number; calm?: boolean}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const stroke = size >= 40 ? 5 : 2.5;
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  const color = done >= 0.9 && !calm ? c.danger : c.accent;
  const parts = leftUnits(left, t);
  return (
    <View style={[styles.ring, {width: size, height: size}]}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${len} ${len}`}
          strokeDashoffset={len * (1 - done)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {size >= 40 ? (
        parts.map(([n, unit]) => (
          <Text key={unit} style={[styles.num, {color}]}>
            {n}
            <Text style={styles.unit}>{unit}</Text>
          </Text>
        ))
      ) : null}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ring: {alignItems: 'center', justifyContent: 'center'},
    num: {fontSize: 14, fontWeight: '700', lineHeight: 16, fontVariant: ['tabular-nums']},
    unit: {color: c.subtext, fontSize: 10, fontWeight: '600'},
  });

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

/** How far a wait has run, 0 to 1, given when it ends and how long it is. */
export function waitDone(at: number, now: number, length: number): number {
  return length > 0 ? Math.min(1, Math.max(0, 1 - (at - now) / length)) : 1;
}

/**
 * How far an item is through its timelock: the arc is the time passed, the track the time left.
 * Red in the last tenth, the window that is nearly shut. Large enough, the middle says the time
 * left; small, it is the ring alone and the caller writes the time beside it.
 */
export function ProgressRing({done, left, size = 56}: {done: number; left: number; size?: number}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const stroke = size >= 40 ? 5 : 2.5;
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  const color = done >= 0.9 ? c.danger : c.accent;
  const [n, unit] = leftUnit(left, t);
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
        <>
          <Text style={[styles.num, {color}]}>{n}</Text>
          <Text style={styles.unit}>{unit}</Text>
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ring: {alignItems: 'center', justifyContent: 'center'},
    num: {fontSize: 18, fontWeight: '700', lineHeight: 20, fontVariant: ['tabular-nums']},
    unit: {color: c.subtext, fontSize: 10, fontWeight: '600'},
  });

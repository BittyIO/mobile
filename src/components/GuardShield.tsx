import React from 'react';
import Svg, {Path} from 'react-native-svg';
import type {ShieldKind} from '@/core/new-vault-defaults';
import {useColors, useIsDark} from '@/theme';

/** Each level its own fill: None none at all (an outline), Low silver, Basic yellow, High blue, Highest black. */
const FILL: Record<ShieldKind, string> = {0: 'none', 1: '#C0C0C0', 2: '#FFCC00', 3: '#0E85FF', 4: '#000000'};

/** Guard's shield-check (Overview's Guard icon), filled with its level's colour, `size` tall. */
export function GuardShield({level, size = 28}: {level: ShieldKind; size?: number}) {
  const dark = useIsDark();
  const c = useColors();
  // None is the empty shield, as Overview's Guard icon draws it: outline and check in the accent, nothing filled.
  const empty = level === 0;
  // Black on a dark page needs an edge to be seen at all.
  const edge = empty ? c.accent : level === 4 && dark ? '#8E8E93' : FILL[level];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
        fill={FILL[level]}
        stroke={edge}
        strokeWidth={empty ? 2 : 1.5}
        strokeLinejoin="round"
      />
      <Path d="m9 12 2 2 4-4" fill="none" stroke={empty ? c.accent : '#fff'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

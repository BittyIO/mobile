import React from 'react';
import {Pressable} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useNetwork} from '@/core/network-store';
import {useFavorites, useIsFavorite} from '@/core/favorites-store';
import {useColors} from '@/theme';

const STAR = 'M11.5 3.3a.6.6 0 0 1 1 0l2.2 4.5 5 .7a.6.6 0 0 1 .3 1l-3.6 3.5.9 4.9a.6.6 0 0 1-.9.6L12 16.2l-4.4 2.3a.6.6 0 0 1-.9-.6l.9-4.9-3.6-3.5a.6.6 0 0 1 .3-1l5-.7z';

/**
 * Star an asset, which is what puts it on the Overview.
 *
 * Filled when starred and outlined when not, rather than two different glyphs: the shape stays
 * put and only its weight changes, so the control reads as one thing in two states.
 */
export function FavoriteStar({symbol, size = 22}: {symbol?: string; size?: number}) {
  const c = useColors();
  const network = useNetwork((s) => s.network);
  const on = useIsFavorite(network, symbol);
  const toggle = useFavorites((s) => s.toggle);
  if (!symbol) return null;
  return (
    <Pressable
      hitSlop={12}
      accessibilityRole="button"
      accessibilityState={{selected: on}}
      onPress={() => toggle(network, symbol)}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          d={STAR}
          fill={on ? c.warning : 'none'}
          stroke={on ? c.warning : c.subtext}
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      </Svg>
    </Pressable>
  );
}

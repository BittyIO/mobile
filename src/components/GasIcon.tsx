import React from 'react';
import Svg, {Line, Path} from 'react-native-svg';

/**
 * A fuel pump, standing in for the words "network fee".
 *
 * The phrase is three words in English and considerably more in Russian or Turkish, and it sat on
 * a line that already had a number to fit. The pump is the universal mark for this and costs one
 * glyph's width in every language. Drawn on the same 24×24 grid as the tab icons (lucide "Fuel").
 */
export function GasIcon({color, size = 13}: {color: string; size?: number}) {
  const c = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Line x1={3} y1={22} x2={15} y2={22} {...c} />
      <Line x1={4} y1={9} x2={14} y2={9} {...c} />
      <Path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18" {...c} />
      <Path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5" {...c} />
    </Svg>
  );
}

import React from 'react';
import Svg, {Circle, Path} from 'react-native-svg';

/** Three dots, the system's own mark for "more of this screen's actions". */
export function MoreIcon({color}: {color: string}) {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24">
      <Circle cx={5} cy={12} r={1.9} fill={color} />
      <Circle cx={12} cy={12} r={1.9} fill={color} />
      <Circle cx={19} cy={12} r={1.9} fill={color} />
    </Svg>
  );
}

/** A 22pt stroke glyph in the muted grey, no tinted tile. */
const glyph = (color: string) => ({
  stroke: color,
  strokeWidth: 1.9,
  fill: 'none' as const,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/** What the asset IS: the ⓘ in the chart's bottom-left corner, opening Asset details. */
export function InfoIcon({color, size = 22}: {color: string; size?: number}) {
  const c = glyph(color);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9.5} {...c} />
      <Path d="M12 11v5.5" {...c} strokeWidth={2} />
      <Circle cx={12} cy={7.9} r={1.15} fill={color} stroke="none" />
    </Svg>
  );
}

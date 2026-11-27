import React from 'react';
import Svg, {Circle, Path} from 'react-native-svg';

/** The address book (lucide book-user), as on the home screen's Payees: opens this phone's wallets. */
export function BookIcon({color, size = 22}: {color: string; size?: number}) {
  const p = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M15 13a3 3 0 1 0-6 0" {...p} />
      <Path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" {...p} />
      <Circle cx={12} cy={8} r={2} {...p} />
    </Svg>
  );
}

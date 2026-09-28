import React from 'react';
import Svg, {Path} from 'react-native-svg';

/** Apple's Face ID mark: corner brackets around eyes, nose and smile. */
export function FaceIdIcon({size = 20, color = '#fff'}: {size?: number; color?: string}) {
  const s = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2" {...s} />
      <Path d="M8 9v2M16 9v2M12 9v4.5h-1.3" {...s} />
      <Path d="M8.6 15.5a4.5 4.5 0 0 0 6.8 0" {...s} />
    </Svg>
  );
}

import React from 'react';
import Svg, {Circle, Line, Path} from 'react-native-svg';

export type TabName = 'Overview' | 'Earn' | 'Trade' | 'Settings';

/**
 * Minimal stroke icons for the bottom tab bar. Monochrome and driven by `color`, so React Navigation's
 * active/inactive tint flows straight through. Drawn on a 24×24 grid.
 */
export function TabIcon({name, color, size = 24}: {name: TabName; color: string; size?: number}) {
  const sw = 1.9;
  const common = {stroke: color, strokeWidth: sw, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'Overview' ? (
        <>
          <Path d="M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" {...common} />
          <Path d="M3 8l2.2-4h13.6L21 8" {...common} />
          <Path d="M16 13.5h3" {...common} />
        </>
      ) : name === 'Earn' ? (
        // lucide "Landmark" — matches the web's Earn section icon.
        <>
          <Path d="M12 2 20 7 4 7Z" {...common} />
          <Line x1={6} y1={11} x2={6} y2={18} {...common} />
          <Line x1={10} y1={11} x2={10} y2={18} {...common} />
          <Line x1={14} y1={11} x2={14} y2={18} {...common} />
          <Line x1={18} y1={11} x2={18} y2={18} {...common} />
          <Line x1={3} y1={22} x2={21} y2={22} {...common} />
        </>
      ) : name === 'Trade' ? (
        <>
          <Path d="M6 8h13M16 5l3 3-3 3" {...common} />
          <Path d="M18 16H5M8 13l-3 3 3 3" {...common} />
        </>
      ) : (
        // The classic cog (lucide "Settings"), in place of the sliders.
        <>
          <Path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            {...common}
          />
          <Circle cx={12} cy={12} r={3} {...common} />
        </>
      )}
    </Svg>
  );
}

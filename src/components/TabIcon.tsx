import React from 'react';
import Svg, {Circle, Line, Path, Rect} from 'react-native-svg';

export type TabName = 'Overview' | 'Earn' | 'Market' | 'Settings';

/** The cog body. Only its centre fills when selected, so the gear keeps its teeth readable. */
const COG =
  'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';

/**
 * Minimal icons for the bottom tab bar. Monochrome and driven by `color`, so React Navigation's
 * active/inactive tint flows straight through. Drawn on a 24×24 grid.
 *
 * The selected tab fills its shape instead of only tinting the outline — the tint alone is a small
 * difference to read at 24pt, where solid against outline is unmistakable. Only genuinely closed
 * shapes take the fill: an open path like the Market axis would close itself across the gap and
 * flood a triangle. The strokes that cannot be filled thicken slightly instead, so the whole glyph
 * gains weight together rather than half of it standing out.
 */
export function TabIcon({name, color, size = 24, focused}: {name: TabName; color: string; size?: number; focused?: boolean}) {
  const sw = focused ? 2.1 : 1.9;
  const common = {stroke: color, strokeWidth: sw, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  // Closed shapes: outlined when idle, solid when selected.
  const solid = {...common, fill: focused ? color : 'none'};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'Overview' ? (
        // lucide "LayoutDashboard" — four panels. The conventional mark for a screen that gathers
        // everything in one place, and the plainest silhouette of the four tabs, which is what a
        // first tab wants. A wallet named the wrong object and a vault named where the money sits
        // rather than what the screen shows.
        <>
          <Rect x={3} y={3} width={7} height={9} rx={1} {...solid} />
          <Rect x={14} y={3} width={7} height={5} rx={1} {...solid} />
          <Rect x={14} y={12} width={7} height={9} rx={1} {...solid} />
          <Rect x={3} y={16} width={7} height={5} rx={1} {...solid} />
        </>
      ) : name === 'Earn' ? (
        // lucide "Landmark" — matches the web's Earn section icon.
        <>
          <Path d="M12 2 20 7 4 7Z" {...solid} />
          <Line x1={6} y1={11} x2={6} y2={18} {...common} />
          <Line x1={10} y1={11} x2={10} y2={18} {...common} />
          <Line x1={14} y1={11} x2={14} y2={18} {...common} />
          <Line x1={18} y1={11} x2={18} y2={18} {...common} />
          <Line x1={3} y1={22} x2={21} y2={22} {...common} />
        </>
      ) : name === 'Market' ? (
        // lucide "ChartCandlestick" — the standard mark for a list of prices. The two arrows it
        // replaces meant "swap", which is what the pushed pair page does; this tab only browses.
        <>
          <Path d="M9 5v4" {...common} />
          <Rect x={7} y={9} width={4} height={6} rx={1} {...solid} />
          <Path d="M9 15v2" {...common} />
          <Path d="M17 3v2" {...common} />
          <Rect x={15} y={5} width={4} height={8} rx={1} {...solid} />
          <Path d="M17 13v3" {...common} />
          <Path d="M3 3v16a2 2 0 0 0 2 2h16" {...common} />
        </>
      ) : (
        // The classic cog (lucide "Settings"), in place of the sliders. Selected, only the centre
        // fills: a solid gear is nearly all ink and swamped the other three marks, which stay
        // mostly negative space even filled. The dot in the middle is enough to read as "on".
        <>
          <Path d={COG} {...common} />
          <Circle cx={12} cy={12} r={3} {...solid} />
        </>
      )}
    </Svg>
  );
}

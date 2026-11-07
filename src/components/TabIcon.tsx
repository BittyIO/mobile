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
        /**
         * An exchange ring: two arcs chasing each other round a circle, each ending in a head.
         *
         * It replaced lucide's ArrowRightLeft, which was two OPEN paths — nothing enclosed an area,
         * so there was nothing to fill and selecting the tab could only add 0.2 of stroke. Beside
         * three neighbours that go solid, the tab looked unselected whichever one you were on.
         *
         * The heads are closed triangles and carry the fill; the arcs stay strokes, slightly
         * heavier than the rest of the set so the loop reads as one continuous gesture rather than
         * two stray curves. Drawn as a loop and not a line, which also keeps it from reading as
         * navigation the way a sideways arrow does.
         *
         * CLOCKWISE: the top arc runs left to right and the bottom one returns right to left,
         * which is the direction a reader's eye already travels. The mirrored version was tried
         * and rejected.
         *
         * Each head is built ON THE ARC'S TANGENT: its base midpoint IS the arc's end point, the
         * base is perpendicular to the direction of travel there, and the point extends outward
         * along it. They were drawn as upright triangles sitting near the ends before, which left
         * the base skewed to the curve — the arc ran into a CORNER, so the line appeared to join
         * the sharp end and the head read as a bent flag rather than an arrowhead.
         *
         * Base 5.2 across, 4.2 deep. The bottom head is the top one rotated 180° about (12,12),
         * which is exactly the relationship the two arcs already have.
         */
        <>
          <Path d="M20.4 13.2a8.6 8.6 0 0 1-13.9 5.1" {...common} strokeWidth={sw + 0.1} />
          <Path d="M3.6 10.8a8.6 8.6 0 0 1 13.9-5.1" {...common} strokeWidth={sw + 0.1} />
          <Path d="M20.8 8.4 15.9 7.7 19.1 3.7Z" {...solid} strokeWidth={sw - 0.2} />
          <Path d="M3.2 15.6 8.1 16.3 4.9 20.3Z" {...solid} strokeWidth={sw - 0.2} />
        </>
      ) : (
        /**
         * The classic cog (lucide "Settings"), which is what this tab had before it was "Me".
         *
         * Selected, only the CENTRE fills. A solid gear is nearly all ink and swamped the other
         * three marks, which stay mostly negative space even filled; and filling the body closes
         * the hole the teeth are read against. The dot in the middle is enough to say "on".
         */
        <>
          <Path d={COG} {...common} />
          <Circle cx={12} cy={12} r={3} {...solid} />
        </>
      )}
    </Svg>
  );
}

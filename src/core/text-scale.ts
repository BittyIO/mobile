import React from 'react';
import {useWindowDimensions} from 'react-native';

/**
 * How far the system text size may scale the app's text.
 *
 * iOS's text size runs from xSmall to xxxLarge (×1.35 of the default), then, with Larger
 * Accessibility Sizes on, through five accessibility sizes: about ×1.8, ×2.1, ×2.6, ×3.1 and ×3.6.
 * Stopping at xxxLarge left anyone who needs those sizes with the app's text exactly as small as
 * at xxxLarge. Text now follows the setting through the first accessibility size and most of the
 * second. Past that, a row built around a price, an amount and a percentage has no room left: a
 * figure that is cut off is worse than one that stops growing.
 *
 * For that to hold, layouts grow with their text: buttons and fields have a minimum height rather
 * than a fixed one, labels wrap, and a figure on a line of its own shrinks to fit ({FIT}). A text
 * can still pass its own `maxFontSizeMultiplier` to differ.
 */
export const MAX_TEXT_SCALE = 2;

/**
 * The cap for text in the app's fixed chrome: the bar at the top (the vault and its address
 * opposite the chain) and the tab bar. They are one line in a bar of fixed height, as iOS's own
 * bars are, which don't follow the accessibility sizes either.
 */
export const CHROME_SCALE = 1.35;

/**
 * For a figure on a line of its own — a price, an amount, a total: shrink to fit the line rather
 * than wrap under itself or be cut off. Spread onto the Text: `<Text {...FIT} style={…}>`.
 */
export const FIT = {numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6} as const;

/**
 * Whether the text is at one of iOS's accessibility sizes (past xxxLarge): there a screen drops what
 * it can do without — an icon beside a name it already shows, choices past the usual ones — so what
 * is left has the room. Follows the setting live.
 */
export function useBigText(): boolean {
  return useWindowDimensions().fontScale > CHROME_SCALE;
}

/** Statics a component object carries that are React's own, not the component's API. */
const REACT_KEYS = new Set(['$$typeof', 'render', 'type', 'compare', 'displayName', 'propTypes', 'defaultProps']);

function capped(Base: React.ComponentType<any>): React.ComponentType<any> {
  const Capped = React.forwardRef<unknown, {maxFontSizeMultiplier?: number | null}>((props, ref) =>
    React.createElement(Base, {maxFontSizeMultiplier: MAX_TEXT_SCALE, ...props, ref}),
  );
  Capped.displayName = (Base as {displayName?: string}).displayName ?? 'Text';
  // TextInput.State and the like: whatever the component exposes, the wrapper exposes too.
  for (const key of Object.keys(Base)) {
    if (!REACT_KEYS.has(key)) (Capped as unknown as Record<string, unknown>)[key] = (Base as unknown as Record<string, unknown>)[key];
  }
  return Capped as unknown as React.ComponentType<any>;
}

/**
 * Put the cap on every Text and TextInput, the app's and its libraries' (the navigation header's
 * title too).
 *
 * React 19 dropped `defaultProps` on function components, which is how this used to be done, so
 * react-native's own export is swapped instead: its index exposes each component through a getter,
 * and every `import {Text} from 'react-native'` reads that property when it renders. Imported first
 * from index.js, before anything renders.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native') as Record<string, unknown>;
for (const name of ['Text', 'TextInput'] as const) {
  const wrapped = capped(RN[name] as React.ComponentType<any>);
  Object.defineProperty(RN, name, {configurable: true, enumerable: true, get: () => wrapped});
}

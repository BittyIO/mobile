import React from 'react';

/**
 * How far the system text size may scale the app's text.
 *
 * iOS's text size runs from xSmall to xxxLarge (×1.35 of the default), then on into the
 * accessibility sizes, which reach about ×3.1. At those, a row built around a price, an amount and a
 * percentage has nowhere to put them: "$97,123.45" ellipsized to "$97,1…", and a figure that is cut
 * off is worse than one that is smaller. So text follows the setting all the way up to xxxLarge and
 * stops there. A text can still pass its own `maxFontSizeMultiplier` to differ.
 */
export const MAX_TEXT_SCALE = 1.35;

/**
 * For a figure on a line of its own — a price, an amount, a total: shrink to fit the line rather
 * than wrap under itself or be cut off. Spread onto the Text: `<Text {...FIT} style={…}>`.
 */
export const FIT = {numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6} as const;

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

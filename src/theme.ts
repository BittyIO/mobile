import {useEffect, useMemo} from 'react';
import {Appearance, StyleSheet, useColorScheme} from 'react-native';
import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

/**
 * Colour palettes. Dark mirrors the web app's vault surfaces (#253345 cards, #0E85FF accent); light
 * follows iOS grouped-list surfaces (grey ground, white cards). Every screen builds its styles from a
 * palette via {@link useColors} / {@link useStyles}, so switching Appearance re-themes at once.
 */
export type Colors = {
  bg: string; // the screen ground
  card: string; // section cards
  cardAlt: string; // a surface one step off the card: chips, tab tracks, word tiles inside a card
  input: string; // text fields and pickers inside a card (iOS tertiarySystemFill)
  buttonSecondary: string; // the quiet button fill (Withdraw next to Deposit)
  neutralSoft: string; // a faint neutral fill for grey pills
  elevated: string; // sheets and bars over the content
  border: string;
  text: string;
  textMuted: string; // secondary text with more weight than subtext (table headers, amounts)
  subtext: string;
  accent: string;
  accentSoft: string; // accent at low alpha, for tinted chips and pills
  onAccent: string; // text on an accent fill
  danger: string;
  dangerSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  switchOff: string; // UISwitch off track (iOS systemFill for switches)
  switchOn: string; // UISwitch on track (iOS systemGreen)
  buy: string; // solid Buy fill (deeper than `success`, which is for text and pills)
  sell: string; // solid Sell fill
  overlay: string; // modal backdrop
};

export const DARK: Colors = {
  // iOS dark, from Apple's semantic colours: systemGroupedBackground (#000), secondary (#1C1C1E) for
  // cards, tertiary (#2C2C2E) for fields and quiet fills, separator #38383A, secondaryLabel #AEAEB2.
  bg: '#000000',
  card: '#1C1C1E',
  cardAlt: '#2C2C2E',
  input: 'rgba(118,118,128,0.24)',
  buttonSecondary: '#2C2C2E',
  neutralSoft: 'rgba(120,120,128,0.32)',
  elevated: '#1C1C1E',
  border: '#38383A',
  text: '#FFFFFF',
  textMuted: '#AEAEB2',
  subtext: '#8E8E93',
  accent: '#0A84FF',
  accentSoft: 'rgba(10,132,255,0.18)',
  onAccent: '#FFFFFF',
  danger: '#FF453A',
  dangerSoft: 'rgba(255,69,58,0.18)',
  success: '#30D158',
  successSoft: 'rgba(48,209,88,0.18)',
  warning: '#FFD60A',
  warningSoft: 'rgba(255,214,10,0.18)',
  switchOff: '#39393D',
  switchOn: '#30D158',
  buy: '#059669',
  sell: '#E11D48',
  overlay: 'rgba(0,0,0,0.6)',
};

export const LIGHT: Colors = {
  bg: '#F2F2F7',
  card: '#FFFFFF',
  cardAlt: '#F2F2F7',
  input: 'rgba(118,118,128,0.12)',
  buttonSecondary: '#E5E5EA',
  neutralSoft: 'rgba(110,118,129,0.14)',
  elevated: '#FFFFFF',
  border: '#E3E3E8',
  text: '#0B1420',
  textMuted: '#3C4652',
  subtext: '#6E7681',
  accent: '#0E85FF',
  accentSoft: 'rgba(14,133,255,0.12)',
  onAccent: '#FFFFFF',
  danger: '#E5484D',
  dangerSoft: 'rgba(229,72,77,0.12)',
  success: '#1F9D63',
  successSoft: 'rgba(31,157,99,0.12)',
  warning: '#C77A00',
  warningSoft: 'rgba(199,122,0,0.12)',
  switchOff: '#E9E9EA',
  switchOn: '#34C759',
  buy: '#059669',
  sell: '#E11D48',
  overlay: 'rgba(0,0,0,0.35)',
};

/**
 * The static dark palette, kept for module-level constants that cannot read the theme (icon tints,
 * chart strokes decided outside a component). Anything rendered should use {@link useColors}.
 */
export const colors = DARK;

// --- Appearance setting ---------------------------------------------------------------------

export type Appearance = 'system' | 'light' | 'dark';
export const APPEARANCES: Appearance[] = ['system', 'light', 'dark'];

const store = new MMKV({id: 'bitty.appearance'});
const KEY = 'appearance';

type AppearanceState = {
  appearance: Appearance;
  setAppearance: (a: Appearance) => void;
};

/** The chosen Appearance (system / light / dark), persisted across relaunches. */
export const useAppearance = create<AppearanceState>((set) => ({
  appearance: (store.getString(KEY) as Appearance) ?? 'system',
  setAppearance: (appearance) => {
    store.set(KEY, appearance);
    set({appearance});
  },
}));

/**
 * Push the app's Theme mode down to UIKit, so every NATIVE control follows the app rather than the
 * phone: switches, date pickers, keyboards, action sheets and the scroll indicators. Without this a
 * phone in light mode drew a light switch on the app's dark cards, and colouring the switch by hand
 * to compensate produced a filled grey pill (and, with ios_backgroundColor, a second shape behind it).
 * "System" hands control back to the phone.
 */
export function useSyncInterfaceStyle(): void {
  const appearance = useAppearance((s) => s.appearance);
  useEffect(() => {
    Appearance.setColorScheme(appearance === 'system' ? null : appearance);
  }, [appearance]);
}

/** Whether the app currently renders dark, after resolving "system" against the OS setting. */
export function useIsDark(): boolean {
  const appearance = useAppearance((s) => s.appearance);
  const system = useColorScheme();
  return appearance === 'system' ? system !== 'light' : appearance === 'dark';
}

/** The active palette. */
export function useColors(): Colors {
  return useIsDark() ? DARK : LIGHT;
}

/**
 * Theme-aware styles: `const styles = useStyles(makeStyles)` where `makeStyles` is
 * `(c: Colors) => StyleSheet.create({...})`. Rebuilt only when the palette changes.
 */
export function useStyles<T extends StyleSheet.NamedStyles<T>>(make: (c: Colors) => T): T {
  const c = useColors();
  return useMemo(() => make(c), [c, make]);
}

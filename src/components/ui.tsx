import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle} from 'react-native';
import {useColors, useStyles, type Colors} from '@/theme';

/** Section heading — text-lg font-semibold, matches the web `<h2>` used across Earn/Settings. */
export function SectionTitle({children, style}: {children: React.ReactNode; style?: ViewStyle}) {
  const ui = useStyles(makeUi);
  return <Text style={[ui.h2, style]}>{children}</Text>;
}

/** A rounded card on the palette's card surface. */
export function Card({children, style}: {children: React.ReactNode; style?: ViewStyle}) {
  const ui = useStyles(makeUi);
  return <View style={[ui.card, style]}>{children}</View>;
}

export type PillTone = 'green' | 'blue' | 'sky' | 'amber' | 'rose' | 'gray';
const toneFor = (c: Colors): Record<PillTone, {bg: string; fg: string}> => ({
  green: {bg: c.successSoft, fg: c.success},
  blue: {bg: c.accentSoft, fg: c.accent},
  sky: {bg: c.accentSoft, fg: c.accent},
  amber: {bg: c.warningSoft, fg: c.warning},
  rose: {bg: c.dangerSoft, fg: c.danger},
  gray: {bg: c.neutralSoft, fg: c.subtext},
});

/** Rounded-full status/APY pill. */
export function Pill({label, tone = 'gray'}: {label: string; tone?: PillTone}) {
  const ui = useStyles(makeUi);
  const c = useColors();
  const t = toneFor(c)[tone];
  return (
    <View style={[ui.pill, {backgroundColor: t.bg}]}>
      <Text style={[ui.pillText, {color: t.fg}]}>{label}</Text>
    </View>
  );
}

/**
 * The Market tab's category row: plain labels in a line, the selected one at full strength. Scrolls
 * sideways when they overflow, and draws no underline or divider — the card below is the only edge.
 *
 * Shared so the Market directory and the Payments sub-nav cannot drift apart. The caller owns the
 * outer spacing, because the two sit in differently padded screens.
 */
export function CategoryTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: {key: T; label: string}[];
  value: T;
  onChange: (k: T) => void;
}) {
  const ui = useStyles(makeUi);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ui.catRow}>
      {tabs.map((t) => (
        <Pressable key={t.key} onPress={() => onChange(t.key)} style={ui.catTab}>
          <Text style={[ui.catText, t.key === value && ui.catTextOn]}>{t.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const makeUi = (c: Colors) => StyleSheet.create({
  h2: {color: c.text, fontSize: 18, fontWeight: '700'},
  card: {backgroundColor: c.card, borderRadius: 12, padding: 14},
  pill: {borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start'},
  pillText: {fontSize: 11, fontWeight: '600'},
  catRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 20, paddingHorizontal: 4},
  catTab: {alignItems: 'center', paddingVertical: 6},
  catText: {color: c.subtext, fontSize: 15, fontWeight: '600'},
  catTextOn: {color: c.text, fontWeight: '700'},
});

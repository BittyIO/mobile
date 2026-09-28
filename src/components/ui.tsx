import React from 'react';
import {Pressable, StyleSheet, Text, View, type ViewStyle} from 'react-native';
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

type PillTone = 'green' | 'blue' | 'sky' | 'amber' | 'rose' | 'gray';
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

/** Underline sub-tab bar (Payments / Settings), full width, equal thirds. */
export function UnderlineTabs<T extends string>({
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
    <View style={ui.tabBar}>
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <Pressable key={t.key} style={ui.tabBtn} onPress={() => onChange(t.key)}>
            <Text style={[ui.tabText, on && ui.tabTextOn]}>{t.label}</Text>
            <View style={[ui.tabUnderline, on && ui.tabUnderlineOn]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const makeUi = (c: Colors) => StyleSheet.create({
  h2: {color: c.text, fontSize: 18, fontWeight: '700'},
  card: {backgroundColor: c.card, borderRadius: 12, padding: 14},
  pill: {borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start'},
  pillText: {fontSize: 11, fontWeight: '600'},
  tabBar: {flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.neutralSoft},
  tabBtn: {flex: 1, alignItems: 'center', paddingVertical: 10, gap: 8},
  tabText: {color: c.subtext, fontSize: 14, fontWeight: '600'},
  tabTextOn: {color: c.text},
  tabUnderline: {height: 2, width: '100%', backgroundColor: 'transparent'},
  tabUnderlineOn: {backgroundColor: c.accent},
});

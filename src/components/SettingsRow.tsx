import React from 'react';
import {Pressable, StyleSheet, Switch, Text, View} from 'react-native';
import {SettingsIcon, type SettingsIconName} from '@/components/SettingsIcon';
import {useStyles, type Colors} from '@/theme';

/**
 * One iOS-style settings row, and the card that groups them.
 *
 * Lifted out of the Settings screen when the Team rows moved to a page of their own: two screens
 * drawing the same row from two copies of the same twelve styles is how a hairline ends up one
 * point off on one of them. The Settings screen still owns everything that is only its own — the
 * recovery phrase box, the word grid — and imports these.
 *
 * A row shows an icon, a title with an optional second line, and on the right whatever answers it:
 * a value, a set of marks, a switch, or a chevron when it pushes a page.
 */
export function SettingsRow({
  icon,
  title,
  sub,
  value,
  onPress,
  chevron = true,
  last,
  toggle,
  right,
}: {
  icon: SettingsIconName;
  title: string;
  sub?: string;
  value?: string;
  onPress?: () => void;
  chevron?: boolean;
  last?: boolean;
  /** A row that flips a local setting in place, rather than pushing or opening a sheet. */
  toggle?: {value: boolean; onValueChange: (v: boolean) => void};
  /** Where a row's current answer is a set of things rather than a word — icons, marks. */
  right?: React.ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const body = (
    <>
      <SettingsIcon name={icon} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        {toggle ? (
          <Switch value={toggle.value} onValueChange={toggle.onValueChange} style={styles.rowSwitch} />
        ) : (
          <>
            {right ?? null}
            {value ? <Text style={styles.rowValue}>{value}</Text> : null}
            {chevron ? <Text style={styles.chev}>›</Text> : null}
          </>
        )}
      </View>
    </>
  );
  // A switch row has nothing to press: the control is the whole interaction, and a Pressable
  // wrapping it would fight the gesture.
  if (toggle) return <View style={[styles.row, !last && styles.rowDivider]}>{body}</View>;
  return (
    <Pressable style={[styles.row, !last && styles.rowDivider]} onPress={onPress}>
      {body}
    </Pressable>
  );
}

/** The rounded card a run of rows sits in, with an optional label above it. */
export function SettingsGroup({label, children}: {label?: string; children: React.ReactNode}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.section}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={styles.group}>{children}</View>
    </View>
  );
}

export const makeSettingsStyles = (c: Colors) =>
  StyleSheet.create({
    groupLabel: {color: c.subtext, fontSize: 15, fontWeight: '600', paddingHorizontal: 16, marginTop: 8, marginBottom: 6},
    section: {gap: 0},
    group: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15, paddingHorizontal: 16, gap: 12},
    rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    rowText: {gap: 3, flexShrink: 1, flex: 1},
    rowTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
    rowSub: {color: c.subtext, fontSize: 12},
    rowRight: {flexDirection: 'row', alignItems: 'center', gap: 6},
    // A chevron's glyph sits a few points inside its box; a switch fills its own exactly, so
    // without this it looks nearer the edge than every other row in the group.
    rowSwitch: {marginRight: 10},
    rowValue: {color: c.subtext, fontSize: 14},
    chev: {color: c.subtext, fontSize: 22, fontWeight: '300'},
  });

const makeStyles = makeSettingsStyles;

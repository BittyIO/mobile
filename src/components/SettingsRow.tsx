import React from 'react';
import {Pressable, StyleSheet, Switch, Text, View} from 'react-native';
import {SettingsIcon, type SettingsIconName} from '@/components/SettingsIcon';
import {InfoIcon} from '@/components/TradeMenu';
import {useColors, useStyles, type Colors} from '@/theme';

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
  leading,
  info,
}: {
  icon: SettingsIconName;
  title: string;
  sub?: string;
  value?: string;
  onPress?: () => void;
  chevron?: boolean;
  last?: boolean;
  /** A row that flips a local setting in place, rather than pushing or opening a sheet. */
  toggle?: {value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean};
  /** Where a row's current answer is a set of things rather than a word — icons, marks. */
  right?: React.ReactNode;
  /** In place of the icon square, where the row names something with a mark of its own (a protocol). */
  leading?: React.ReactNode;
  /** An ⓘ after the title, for a row whose name needs explaining; opens whatever this does. */
  info?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const body = (
    <>
      {leading ?? <SettingsIcon name={icon} />}
      <View style={styles.rowText}>
        {info ? (
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowTitleShrink}>{title}</Text>
            <Pressable onPress={info} hitSlop={10} accessibilityRole="button" accessibilityLabel={title}>
              <InfoIcon color={c.subtext} size={17} />
            </Pressable>
          </View>
        ) : (
          <Text style={styles.rowTitle}>{title}</Text>
        )}
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        {toggle ? (
          <Switch value={toggle.value} onValueChange={toggle.onValueChange} disabled={toggle.disabled} style={styles.rowSwitch} />
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

/**
 * One choice in a pick-one list: a title (and optional second line), a check on the chosen one.
 * No icon — the list's subject is the page title, and the rows are its answers.
 */
export function OptionRow({
  title,
  sub,
  checked,
  busy,
  disabled,
  onPress,
  last,
}: {
  title: string;
  sub?: string;
  checked?: boolean;
  /** This choice's write is in flight. */
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  last?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable style={[styles.row, !last && styles.rowDivider]} onPress={onPress} disabled={disabled}>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, disabled && !checked && styles.rowTitleOff]}>{title}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      {/* The mark is always laid out and only shown when chosen: it is a little taller than the
          title, so adding and removing it made the row change height as the choice moved. */}
      {busy ? <Text style={styles.rowValue}>…</Text> : <Text style={[styles.check, !checked && styles.checkHidden]}>✓</Text>}
    </Pressable>
  );
}

/**
 * The rounded card a run of rows sits in, with an optional label above it and an optional
 * description below it — the iOS footer that says what the rows in the card do.
 */
export function SettingsGroup({
  label,
  labelInfo,
  footer,
  footerInfo,
  children,
}: {
  label?: string;
  /** An ⓘ after the label, for a card whose rows need a word of warning; opens whatever this does. */
  labelInfo?: () => void;
  footer?: string;
  /** An ⓘ after the footer, for a footer that needs explaining; opens whatever this does. */
  footerInfo?: () => void;
  children: React.ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={styles.section}>
      {label && labelInfo ? (
        <View style={styles.groupLabelLine}>
          <Text style={[styles.groupLabel, styles.groupLabelInline]}>{label}</Text>
          <Pressable onPress={labelInfo} hitSlop={10} accessibilityRole="button" accessibilityLabel={label}>
            <InfoIcon color={c.subtext} size={16} />
          </Pressable>
        </View>
      ) : label ? (
        <Text style={styles.groupLabel}>{label}</Text>
      ) : null}
      <View style={styles.group}>{children}</View>
      {footer && footerInfo ? (
        <View style={styles.groupFooterLine}>
          <Text style={[styles.groupFooter, styles.groupFooterShrink]}>{footer}</Text>
          <Pressable onPress={footerInfo} hitSlop={10} accessibilityRole="button" accessibilityLabel={footer}>
            <InfoIcon color={c.subtext} size={15} />
          </Pressable>
        </View>
      ) : footer ? (
        <Text style={styles.groupFooter}>{footer}</Text>
      ) : null}
    </View>
  );
}

export const makeSettingsStyles = (c: Colors) =>
  StyleSheet.create({
    groupLabel: {color: c.subtext, fontSize: 15, fontWeight: '600', paddingHorizontal: 16, marginTop: 8, marginBottom: 6},
    groupFooter: {color: c.subtext, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, marginTop: 6},
    groupLabelLine: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, marginTop: 8, marginBottom: 6},
    groupLabelInline: {paddingHorizontal: 0, marginTop: 0, marginBottom: 0},
    groupFooterLine: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, paddingRight: 16},
    groupFooterShrink: {flexShrink: 1, paddingRight: 0, marginTop: 0},
    section: {gap: 0},
    group: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15, paddingHorizontal: 16, gap: 12},
    rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    rowText: {gap: 3, flexShrink: 1, flex: 1},
    rowTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
    rowTitleLine: {flexDirection: 'row', alignItems: 'center', gap: 6},
    rowTitleShrink: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    rowSub: {color: c.subtext, fontSize: 12},
    rowTitleOff: {color: c.subtext},
    check: {color: c.accent, fontSize: 17, fontWeight: '700'},
    checkHidden: {opacity: 0},
    rowRight: {flexDirection: 'row', alignItems: 'center', gap: 6},
    // A chevron's glyph sits a few points inside its box; a switch fills its own exactly, so
    // without this it looks nearer the edge than every other row in the group.
    rowSwitch: {marginRight: 10},
    rowValue: {color: c.subtext, fontSize: 14},
    chev: {color: c.subtext, fontSize: 22, fontWeight: '300'},
  });

const makeStyles = makeSettingsStyles;

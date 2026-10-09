import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {Amount} from '@/components/Amount';
import {displaySymbol, fmtFull} from '@/core/format';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * What there is to spend, above the field that spends it.
 *
 * Both forms that take an amount needed this and neither had it: the trade sheet showed the figure
 * only once the amount had gone OVER it, and the Earn form showed it beside a Max button until that
 * row was rebuilt. Either way the answer to "how much can I move" was either absent or a reward for
 * getting it wrong — and on a sheet where Max is the only other hint, a number you cannot see is a
 * number you have to guess at.
 *
 * Above the input rather than in it. The row itself is already label, figure, Max and token; a
 * fifth thing in there would be read as part of the amount.
 *
 * Tapping it fills the field, because it names exactly what Max fills — the two should not be
 * different gestures for the same number. Which is also why the figure is printed in full: the
 * two-decimal form every other balance uses would have named one number over a field about to
 * hold another.
 */
export function AvailableLine({
  amount,
  symbol,
  onPress,
  label,
}: {
  /** Already capped by whatever the form holds back — a fee reserve, a position's own limit. */
  amount: number;
  symbol: string;
  onPress?: () => void;
  /** Defaults to "Available". */
  label?: string;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  if (!(amount > 0)) return null;
  // One weight, one colour, all the way across: this is the ceiling, not the figure. Picking the
  // number out made it compete with the amount in the field below — which IS the figure, and the
  // only thing on the row that should be reading loud.
  const text = (
    <Text style={styles.line} numberOfLines={1}>
      {label ?? t('vault.available')} <Amount v={fmtFull(amount)} size={12} color={c.subtext} /> {displaySymbol(symbol)}
    </Text>
  );
  if (!onPress) return text;
  return (
    <Pressable onPress={onPress} hitSlop={6}>
      {text}
    </Pressable>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    /**
     * Left-aligned, over the LABEL rather than over the figure.
     *
     * Right-aligned it sat above the amount, which is the arrangement a running total wants — and
     * read as a second figure in the same column rather than as a note about the row. On the left
     * it sits over "Amount", which is what it qualifies, and the eye runs label-then-ceiling,
     * label-then-figure down the form instead of meeting two numbers stacked on each other.
     */
    line: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
  });

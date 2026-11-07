import React from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

export const FUND_STEPS = [0.25, 0.5, 0.75, 1] as const;

/**
 * One place money can come from — the vault's free balance, or a position it would unwind.
 *
 * The collapsed row is deliberately the same object as a row of a plain source list — token icon,
 * name, and a line underneath carrying the balance and, for a position, its rate. The tick is what
 * a multi-source picker adds, because it can draw on several places at once where a plain list
 * picks exactly one.
 *
 * Ticking brings the whole balance in and opens a second line: the quick fractions, and the amount
 * itself edited in place. Nothing of that line exists until the row is ticked.
 *
 * Shared by the market order's funding sheet and the Send composer's source sheet, so the two
 * cannot drift apart.
 */
export function FundRow({
  label,
  sub,
  symbol,
  cap,
  on,
  amount,
  onToggle,
  onAmount,
  onCommit,
  inert,
}: {
  label: string;
  sub: string;
  symbol: string;
  cap: number;
  on: boolean;
  amount: string;
  onToggle: () => void;
  onAmount: (v: string) => void;
  /** Called when the field is done being edited, so an amount left at zero can clear the tick. */
  onCommit: () => void;
  /**
   * A row that is there to be READ, not ticked — the float held back for network fees.
   *
   * It belongs in the sheet because this is where the coin is accounted for: leave it out and the
   * sources add up to more than the form will accept, with a Max that comes up short as the only
   * hint. It can never be a source, so it takes no tap and dims to say so.
   */
  inert?: boolean;
}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const picked = on ? Math.min(Number(amount) || 0, cap) : 0;
  // Nothing to take. Every fraction of zero is zero, so without this each chip matched the picked
  // amount and the whole strip lit up as if all of them were chosen at once.
  const empty = cap <= 0;
  return (
    <View style={styles.fsRow}>
      <Pressable style={styles.fsHead} onPress={onToggle} disabled={empty || inert}>
        <View style={inert ? styles.fsInert : undefined}>
          <TokenIcon symbol={symbol} size={30} />
        </View>
        <View style={styles.fsLabelCol}>
          <Text style={[styles.fsLabel, inert && styles.fsInertText]} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.fsHeld} numberOfLines={1}>
            {sub}
          </Text>
        </View>
        {/* Character for character the mark a plain picker draws on its selected row: same glyph,
            same size, same stroke, same colour, and nothing at all when the row is off. */}
        {on ? (
          <Svg width={18} height={18} viewBox="0 0 24 24">
            <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
        ) : null}
      </Pressable>

      {on ? (
        <View style={styles.fsOpen}>
          <View style={styles.fsSteps}>
            {FUND_STEPS.map((f) => {
              const v = Math.round(cap * f * 1e6) / 1e6;
              const active = !empty && Math.abs(picked - v) < 1e-9;
              return (
                <Pressable
                  key={f}
                  disabled={empty}
                  style={[styles.fsStep, active && styles.fsStepOn, empty && styles.fsStepOff]}
                  onPress={() => onAmount(String(v))}>
                  <Text style={[styles.fsStepText, active && styles.fsStepTextOn]}>
                    {f === 1 ? t('common.max') : `${f * 100}%`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            style={styles.fsInput}
            keyboardType="decimal-pad"
            editable={!empty}
            placeholder="0"
            placeholderTextColor={c.subtext}
            value={amount}
            onChangeText={onAmount}
            // On blur, not on every keystroke: clearing the field to retype a number passes
            // through empty, and unticking there would collapse the row mid-edit.
            onBlur={onCommit}
          />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  fsRow: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  fsHead: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56},
  fsLabelCol: {flex: 1},
  fsLabel: {color: c.text, fontSize: 15, fontWeight: '600'},
  fsHeld: {color: c.subtext, fontSize: 12, marginTop: 1},
  // The inert row, dimmed exactly as a disabled picker row is: it is the one row in the sheet
  // that is not an answer.
  fsInert: {opacity: 0.45},
  fsInertText: {color: c.subtext},
  fsSteps: {flexDirection: 'row', gap: 6, flex: 1},
  fsStep: {paddingVertical: 5, paddingHorizontal: 9, borderRadius: 9, borderWidth: 1, borderColor: c.border},
  // Always the app accent, never buy-green or sell-red: the same strip picks how much a payment
  // draws from each source, where a side has no meaning.
  fsStepOn: {backgroundColor: c.accent, borderColor: c.accent},
  fsStepTextOn: {color: c.onAccent},
  fsStepOff: {opacity: 0.4},
  fsStepText: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  fsOpen: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 42, paddingBottom: 10},
  fsInput: {minWidth: 80, textAlign: 'right', color: c.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'], paddingVertical: 4},
});

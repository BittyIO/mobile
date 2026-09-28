import React from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/** True when `value` is more than `max`. A missing max never flags. */
export function exceedsMax(value: string, max?: string | null): boolean {
  if (max == null || max === '') return false;
  const v = Number(value);
  return v > 0 && v > Number(max);
}

/**
 * A decimal amount field with an optional balance line + MAX shortcut. An amount above `max` turns the
 * field red with "Amount exceeds available balance" underneath, before anything is signed or simulated.
 */
export function AmountInput({
  value,
  onChangeText,
  placeholder,
  max,
  maxLabel,
  inputAccessoryViewID,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  /** When provided, shows a MAX button that fills this exact value. */
  max?: string;
  /** e.g. "Balance: 12.5 USDC" shown above the field. */
  maxLabel?: string;
  /** Links the field to an iOS keyboard accessory (a Done bar) for the number pad. */
  inputAccessoryViewID?: string;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const hasMax = max != null && Number(max) > 0;
  const over = exceedsMax(value, max);
  return (
    <View style={styles.wrap}>
      {maxLabel ? <Text style={styles.balance}>{maxLabel}</Text> : null}
      <View style={[styles.row, over && styles.rowOver]}>
        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={c.subtext}
          keyboardType="decimal-pad"
          inputAccessoryViewID={inputAccessoryViewID}
          value={value}
          onChangeText={onChangeText}
        />
        {hasMax ? (
          <Pressable style={styles.max} onPress={() => onChangeText(max!)}>
            <Text style={styles.maxText}>{t('common.max')}</Text>
          </Pressable>
        ) : null}
      </View>
      {over ? <Text style={styles.over}>{t('vault.exceeds_balance')}</Text> : null}
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  wrap: {gap: 6},
  balance: {color: c.subtext, fontSize: 12},
  over: {color: c.danger, fontSize: 12},
  rowOver: {borderColor: c.danger},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.input,
    paddingRight: 8,
  },
  input: {flex: 1, height: 56, color: c.text, paddingHorizontal: 16, fontSize: 18},
  max: {paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.accentSoft},
  maxText: {color: c.accent, fontSize: 13, fontWeight: '700'},
});

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useColors} from '@/theme';

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const TINY = /^(-?0\.0)([₀-₉]+)(\d*)$/;

/**
 * An amount string from fmtNum, with a tiny value's zero count drawn as a real subscript: smaller and
 * dropped below the baseline, like 0.0<sub>8</sub>12821 in HTML. Anything else renders as plain text.
 * Renders a nested Text, so it can sit inside another Text and inherit its style; the dropped digit
 * lives in an inline view, which is why its size and colour are passed explicitly.
 */
export function Amount({v, size = 14, color, weight}: {v: string; size?: number; color?: string; weight?: '400' | '500' | '600' | '700'}) {
  const c = useColors();
  const m = TINY.exec(v);
  if (!m) return <Text>{v}</Text>;
  const zeros = m[2]
    .split('')
    .map((ch) => String(SUBSCRIPT.indexOf(ch)))
    .join('');
  return (
    <Text>
      {m[1]}
      <View style={[styles.subWrap, {transform: [{translateY: size * 0.28}]}]}>
        <Text style={{fontSize: size * 0.68, color: color ?? c.text, fontWeight: weight}}>{zeros}</Text>
      </View>
      {m[3]}
    </Text>
  );
}

const styles = StyleSheet.create({
  subWrap: {justifyContent: 'flex-end'},
});

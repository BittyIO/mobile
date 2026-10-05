import React from 'react';
import {Pressable, StyleSheet} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * Clear what is typed in an amount field.
 *
 * It stands exactly where the Max badge does and only one of the two is ever on screen: an empty
 * field offers Max, a filled one offers this. One control at the end of the bar, rather than two
 * that both look like they undo something.
 *
 * Drawn rather than typed: the ✕ character renders at whatever weight the system font gives it
 * and sits off its optical centre, which is what made it read as a stray glyph.
 *
 * Shared by the Send rows and the Trade sheet so the two behave alike — it was Send's own, and
 * the Trade field kept offering Max over a number it had already filled in.
 */
export function ClearBtn({onPress}: {onPress: () => void}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable style={styles.clearBtn} onPress={onPress} hitSlop={12} accessibilityRole="button">
      <Svg width={11} height={11} viewBox="0 0 24 24">
        <Path d="M6 6l12 12M18 6 6 18" stroke={c.subtext} strokeWidth={3} strokeLinecap="round" fill="none" />
      </Svg>
    </Pressable>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    clearBtn: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.neutralSoft,
    },
  });

import React, {useEffect, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle} from 'react-native';
import Svg, {Path, Rect} from 'react-native-svg';
import Clipboard from '@react-native-clipboard/clipboard';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * An address with a copy control, as on the web: tap anywhere on it to copy, and the small copy
 * icon after the text turns into a check for a moment. No dialog, nothing to dismiss.
 *
 * `label` overrides what is shown (a shortened form, or a sentence containing the address); the full
 * `address` is what gets copied.
 */
export function CopyAddress({
  address,
  label,
  textStyle,
  iconSize = 14,
  numberOfLines,
}: {
  address: string;
  label?: string;
  textStyle?: StyleProp<TextStyle>;
  iconSize?: number;
  numberOfLines?: number;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    Clipboard.setString(address);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  const stroke = {stroke: copied ? c.success : c.subtext, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Pressable onPress={copy} hitSlop={6} style={styles.row} accessibilityRole="button" accessibilityLabel={address}>
      <Text style={[styles.text, textStyle]} numberOfLines={numberOfLines}>
        {label ?? address}
      </Text>
      <View style={styles.icon}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24">
          {copied ? (
            <Path d="M20 6L9 17l-5-5" {...stroke} />
          ) : (
            <>
              <Rect x={9} y={9} width={11} height={11} rx={2} {...stroke} />
              <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" {...stroke} />
            </>
          )}
        </Svg>
      </View>
    </Pressable>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1},
    text: {color: c.text, fontSize: 14, fontFamily: 'Menlo', flexShrink: 1},
    icon: {flexShrink: 0},
  });

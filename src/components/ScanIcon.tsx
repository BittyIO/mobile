import React from 'react';
import {Keyboard, Pressable, StyleSheet} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useT} from '@/i18n';
import {useColors} from '@/theme';

/** The scan mark (lucide ScanLine): a viewfinder's four corners and the line across it. */
export function ScanIcon({color, size = 22}: {color: string; size?: number}) {
  const st = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" {...st} />
      <Path d="M7 12h10" {...st} />
    </Svg>
  );
}

/**
 * The scan button at the right-hand end of an address field: tap to read the address off a QR code.
 * The keyboard goes first, so the camera sheet is not opened under it.
 */
export function ScanButton({onPress, disabled}: {onPress: () => void; disabled?: boolean}) {
  const {t} = useT();
  const c = useColors();
  return (
    <Pressable
      style={({pressed}) => [styles.btn, (pressed || disabled) && styles.pressed]}
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.scan.scan')}>
      <ScanIcon color={c.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {width: 48, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center'},
  pressed: {opacity: 0.5},
});

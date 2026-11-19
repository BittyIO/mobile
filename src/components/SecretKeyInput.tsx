import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Svg, {Circle, Path} from 'react-native-svg';
import {useRevealGuard} from '@/core/device-security';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors, MONO} from '@/theme';

/**
 * A private key field: tall, since a key is 64 characters, with an eye to show or hide it and Paste
 * while it is empty.
 *
 * Hidden, it is a masked single line (iOS cannot mask a multi-line field). Shown, it wraps onto as
 * many lines as the key needs, so the whole key can be read and checked before it is imported.
 * Never shown while the screen is recorded or mirrored: masked again, and the eye off, until it stops.
 */
export function SecretKeyInput({
  value,
  onChangeText,
  onSubmit,
  error,
  onFocus,
}: {
  value: string;
  onChangeText: (v: string) => void;
  onSubmit?: () => void;
  error?: boolean;
  onFocus?: () => void;
}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const [wantShown, setShown] = useState(false);
  const {captured} = useRevealGuard();
  const shown = wantShown && !captured;

  return (
    <View style={[styles.wrap, error && styles.wrapError]}>
      <TextInput
        // Remounted on show/hide: a field does not switch between masked and multi-line in place.
        key={shown ? 'shown' : 'hidden'}
        style={[styles.input, shown && styles.inputShown]}
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        secureTextEntry={!shown}
        multiline={shown}
        textAlignVertical="center"
        textContentType="none"
        autoComplete="off"
        importantForAutofill="no"
        blurOnSubmit
        returnKeyType="done"
        onSubmitEditing={onSubmit}
      />
      <View style={styles.side}>
        {!value ? (
          <Pressable style={({pressed}) => [styles.pill, pressed && styles.pressed]} onPress={async () => onChangeText((await Clipboard.getString()).trim())} hitSlop={6}>
            <Text style={styles.pillText}>{t('mobile.safe.paste')}</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({pressed}) => [styles.eye, pressed && styles.pressed]}
          onPress={() => setShown((s) => !s)}
          disabled={captured}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={shown ? t('mobile.settings.hide') : t('mobile.phrases.show_key')}>
          <View style={captured ? styles.off : null}>
            <Eye open={!shown} color={c.subtext} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

/** lucide Eye / EyeOff: the eye shows the key; crossed out, it hides it again. */
function Eye({open, color}: {open: boolean; color: string}) {
  const st = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      {open ? (
        <>
          <Path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" {...st} />
          <Circle cx={12} cy={12} r={3} {...st} />
        </>
      ) : (
        <>
          <Path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.97 0 8.5 4.03 9.94 6.65a1 1 0 0 1 0 .7 13.16 13.16 0 0 1-1.67 2.68" {...st} />
          <Path d="M14.08 14.16a3 3 0 0 1-4.24-4.24" {...st} />
          <Path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.45-5.15" {...st} />
          <Path d="m2 2 20 20" {...st} />
        </>
      )}
    </Svg>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.input, borderRadius: 14, paddingLeft: 14, paddingRight: 8, minHeight: 72, borderWidth: 1.5, borderColor: 'transparent'},
    wrapError: {borderColor: c.danger},
    input: {flex: 1, color: c.text, fontSize: 14, fontFamily: MONO, paddingVertical: 14, minHeight: 72},
    // Shown: room for the whole key, wrapped (64 hex characters run to three or four lines).
    inputShown: {minHeight: 96, lineHeight: 20, paddingTop: 14},
    side: {flexDirection: 'row', alignItems: 'center', gap: 6},
    pill: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: c.accentSoft},
    pillText: {color: c.accent, fontSize: 13, fontWeight: '600'},
    eye: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
    pressed: {opacity: 0.6},
    off: {opacity: 0.35},
  });

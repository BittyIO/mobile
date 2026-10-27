import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {useColors, useStyles, type Colors} from '@/theme';
import {FaceIdIcon} from '@/components/FaceIdIcon';
import {NetworkFee} from '@/components/NetworkFee';
import {useT} from '@/i18n';
import {LockedButton, useVaultLocked} from '@/components/LockNotice';

type Props = {
  title: string;
  onPress: () => void;
  /** A leading Face ID mark before the title. */
  faceId?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  /** The lock refuses this operation: drawn as {LockedButton} while the vault is locked. */
  locked?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * A screen that passes `locked` (even `false`) is one inside the navigator: only then is the lock
 * read, since reading it needs navigation, and the lock and onboarding screens draw buttons before
 * there is any. Split into two components so the hooks each one calls never change between renders.
 */
export function Button(props: Props) {
  return props.locked === undefined ? <PlainButton {...props} /> : <LockAwareButton {...props} />;
}

function LockAwareButton({locked, ...props}: Props) {
  const vaultLocked = useVaultLocked();
  if (locked && vaultLocked) return <LockedButton style={props.style} />;
  return <PlainButton {...props} />;
}

function PlainButton({
  title,
  onPress,
  faceId,
  variant = 'primary',
  loading,
  disabled,
  style,
}: Props) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const bg =
    variant === 'primary'
      ? c.accent
      : variant === 'danger'
        ? 'transparent'
        : c.buttonSecondary; // a quiet fill that still reads as a button on a white card
  // Label / spinner colour: a primary fill carries the on-accent colour so it stays legible in light.
  const fg = variant === 'primary' ? c.onAccent : variant === 'danger' ? c.danger : c.text;
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({pressed}) => [
        styles.base,
        {backgroundColor: bg, opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1},
        variant === 'danger' && styles.dangerBorder,
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : faceId ? (
        <View style={styles.confirmRow}>
          <FaceIdIcon size={20} color={fg} />
          <Text style={[styles.label, {color: fg}]}>{title}</Text>
        </View>
      ) : (
        <Text style={[styles.label, {color: fg}]}>{title}</Text>
      )}
    </Pressable>
  );
}

/**
 * The one confirm button for every action that signs with Face ID: the Face ID mark and "Confirm".
 * `color` overrides the fill (Buy / Sell keep their green and red); the label never changes, so the
 * user learns one control for every signature in the app.
 */
export function ConfirmButton(props: ConfirmProps) {
  return props.locked === undefined ? <PlainConfirmButton {...props} /> : <LockAwareConfirmButton {...props} />;
}

function LockAwareConfirmButton({locked, beforeNavigate, ...props}: ConfirmProps) {
  const vaultLocked = useVaultLocked();
  if (locked && vaultLocked) return <LockedButton style={props.style} beforeNavigate={beforeNavigate} />;
  return <PlainConfirmButton {...props} />;
}

type ConfirmProps = {
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
  /** Gas this particular operation is expected to burn; defaults to a typical relayed write. */
  gas?: bigint;
  /** Set false where the fee is UNKNOWN or irrelevant, so no line is shown at all. */
  fee?: boolean;
  /** Set where the fee is known to be nothing: the line says $0 rather than disappearing. */
  free?: boolean;
  /** The lock refuses this operation: drawn as {LockedButton}, with no fee line, while locked. */
  locked?: boolean;
  /** For a button inside a sheet: close it before the locked state opens Lock status. */
  beforeNavigate?: () => void;
};

function PlainConfirmButton({
  onPress,
  loading,
  disabled,
  color,
  style,
  gas,
  fee = true,
  free,
}: ConfirmProps) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const isDisabled = disabled || loading;
  const button = (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={t('vault.confirm')}
      style={({pressed}) => [styles.base, {backgroundColor: color ?? c.accent, opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1}, style]}>
      {loading ? (
        <ActivityIndicator color={c.onAccent} />
      ) : (
        <View style={styles.confirmRow}>
          <FaceIdIcon size={20} color={c.onAccent} />
          <Text style={[styles.label, {color: c.onAccent}]}>{t('vault.confirm')}</Text>
        </View>
      )}
    </Pressable>
  );
  if (!fee && !free) return button;
  // The cost sits with the control that incurs it, so every signing surface answers "what does this
  // cost me" in the same place without each screen having to remember to say it.
  return (
    <View style={styles.confirmWrap}>
      <NetworkFee gas={gas} free={free} />
      {button}
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  confirmRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  confirmWrap: {gap: 8},
  // A full pill, the iOS shape the Buy / Sell buttons already use, so every button in the app matches.
  base: {
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  dangerBorder: {borderWidth: 1, borderColor: c.danger},
  label: {color: c.text, fontSize: 16, fontWeight: '600'},
});

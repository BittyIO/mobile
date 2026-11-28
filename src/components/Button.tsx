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
import {ActivationFees, NetworkFee, useActivationDue} from '@/components/NetworkFee';
import {ACTIVATION_GAS} from '@/core/activation-fee';
import {TYPICAL_RELAY_GAS} from '@/vault/fee-quote';
import {useT} from '@/i18n';
import {isTronNetwork} from '@/core/chain';
import {useNetwork} from '@/core/network-store';
import {LockIcon, useLockLevel} from '@/components/LockNotice';
import {RentalToggle, type RentalToggleProps} from '@/components/EnergyRental';

type Props = {
  title: string;
  onPress: () => void;
  /** A leading Face ID mark before the title. */
  faceId?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  /** The lock refuses this operation: while the vault is locked, disabled behind a {LockIcon}. */
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
  const level = useLockLevel();
  return <PlainButton {...props} lockLevel={locked ? level : 0} />;
}

function PlainButton({
  title,
  onPress,
  faceId,
  variant = 'primary',
  loading,
  disabled,
  style,
  lockLevel = 0,
}: Props & {lockLevel?: 0 | 1 | 2}) {
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
  const isDisabled = disabled || loading || lockLevel > 0;
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
      ) : lockLevel ? (
        <View style={styles.confirmRow}>
          <LockIcon level={lockLevel} />
          <Text style={[styles.label, {color: fg}]}>{title}</Text>
        </View>
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

function LockAwareConfirmButton({locked, ...props}: ConfirmProps) {
  const level = useLockLevel();
  return <PlainConfirmButton {...props} lockLevel={locked ? level : 0} />;
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
  /** The lock refuses this operation: while the vault is locked, disabled behind a {LockIcon}. */
  locked?: boolean;
  /**
   * The network fee of an activation, in dollars, when the caller has priced it. Left out, an
   * activation's network fee is quoted here whenever the vault in front is not activated yet (its
   * first write activates it) and the vault pays.
   */
  activationFee?: number;
  /** The network fee at the top right, in dollars, when the caller has already priced it. */
  networkFeeUsd?: number;
  /**
   * The caller is still pricing this operation and shows its own spinner where the fee goes: no fee
   * line until it is done. Without it an activation sheet first showed a generic estimate (a typical
   * write's gas plus a bare activation's, $16 on Tron) and then swapped in its own quote.
   */
  pricing?: boolean;
  /**
   * Tron: the energy rental, drawn at the top left (components/EnergyRental). It shows the fee both
   * ways itself, so it takes the place of the network fee line.
   */
  rental?: RentalToggleProps;
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
  activationFee,
  networkFeeUsd,
  pricing,
  rental,
  lockLevel = 0,
}: ConfirmProps & {lockLevel?: 0 | 1 | 2}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const isDisabled = disabled || loading || lockLevel > 0;
  const due = useActivationDue();
  const activation = activationFee ?? (due ? undefined : null);
  // Read on every render: a hook behind the `&&` ran only once `due` turned true, and React crashed
  // on the changed hook count (the Guard level page, as its activation check came back).
  const network = useNetwork((st) => st.network);
  const splitActivation = due && activationFee == null && isTronNetwork(network);
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
          {lockLevel ? <LockIcon level={lockLevel} /> : <FaceIdIcon size={20} color={c.onAccent} />}
          <Text style={[styles.label, {color: c.onAccent}]}>{t('vault.confirm')}</Text>
        </View>
      )}
    </Pressable>
  );
  if (rental) {
    return (
      <View style={styles.confirmWrap}>
        {/* The rental and its TRX at the left; the network fee in dollars at the right, as always. */}
        <View style={styles.feeRow}>
          <RentalToggle p={rental} disabled={isDisabled && !disabled} />
          {networkFeeUsd != null ? <NetworkFee usd={networkFeeUsd} /> : null}
        </View>
        {button}
      </View>
    );
  }
  const showFee = fee || free || networkFeeUsd != null;
  if (pricing || (!showFee && activation === null)) return button;
  // The cost sits with the control that incurs it, so every signing surface answers "what does this
  // cost me" in the same place without each screen having to remember to say it. A vault's first
  // write also activates it: then the fee is the activation's network fee — the deployment's gas on
  // top of the operation's — and nothing else.
  return (
    <View style={styles.confirmWrap}>
      {/* Tron, before the smart wallet's first write: the activation's fee at the left, the
          operation's at the right — two figures, since over the per-operation cap they are two
          transactions (vault/relay). Elsewhere the one fee, the activation's included. */}
      {splitActivation ? (
        <ActivationFees gas={gas ?? TYPICAL_RELAY_GAS} label={t('mobile.fees.activation_label')} />
      ) : (
      <View style={styles.feeRow}>
        <View />
        {activation !== null ? <NetworkFee gas={(gas ?? TYPICAL_RELAY_GAS) + ACTIVATION_GAS} usd={activation} /> : showFee ? <NetworkFee gas={gas} free={free} usd={networkFeeUsd} /> : null}
      </View>
      )}
      {button}
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  confirmRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  confirmWrap: {gap: 8},
  feeRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 4},
  // A full pill, the iOS shape the Buy / Sell buttons already use, so every button in the app matches.
  base: {
    minHeight: 52,
    paddingVertical: 8,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  dangerBorder: {borderWidth: 1, borderColor: c.danger},
  label: {color: c.text, fontSize: 16, fontWeight: '600'},
});

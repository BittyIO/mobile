import React from 'react';
import {Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {SettingsIcon} from '@/components/SettingsIcon';
import {LOCK_ICON, LOCK_TITLE} from '@/core/lock-status';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {gateReasonKey, useVaultGate} from '@/vault/gate';
import type {Gate} from '@/vault/capabilities';

// The lock's two colours, as the Lock status rows draw them: orange for the lock the
// owner can undo, red for the one nobody can.
const TEMP = '#FF9500';
const FOREVER = '#FF3B30';

/**
 * At the top of an OPERATION page — a send, an order, a deposit, a setting being changed — when the
 * lock refuses what that page does: the lock, and that this operation is not supported while it
 * holds. On tap, Lock status. Nothing while the vault is unlocked.
 *
 * Only where the operation itself is refused (`blocked`), never on a page that merely lists things
 * (Earn, Settings): a lock still lets the vault withdraw, pay saved recipients and buy stablecoins,
 * and a notice on those pages, or on an operation that still works, says something untrue.
 */
export function LockNotice({
  blocked,
  style,
  beforeNavigate,
}: {
  /** The page's operation is refused right now. */
  blocked: boolean;
  style?: StyleProp<ViewStyle>;
  beforeNavigate?: () => void;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {lockLevel} = useVaultGate();
  if (!blocked || (lockLevel !== 1 && lockLevel !== 2)) return null;
  const tint = lockLevel === 2 ? FOREVER : TEMP;
  return (
    <Pressable
      // Shown inside a sheet, the sheet closes first, or Vault status would open behind it.
      onPress={() => {
        beforeNavigate?.();
        nav.navigate('VaultLock');
      }}
      accessibilityRole="button"
      style={({pressed}) => [styles.box, {borderColor: tint, opacity: pressed ? 0.7 : 1}, style]}>
      <SettingsIcon name={LOCK_ICON[lockLevel]} size={22} round />
      <View style={styles.body}>
        <Text style={[styles.title, {color: tint}]}>{t(LOCK_TITLE[lockLevel])}</Text>
        <Text style={styles.text}>{t('mobile.vault.lock_notice_op')}</Text>
      </View>
    </Pressable>
  );
}

/**
 * An operation's confirm button while the lock refuses that operation: the whole pill in the lock's
 * colour — yellow for the emergency lock, red for the forever one — dimmed like any disabled
 * button, the lock's icon and name where the action was, and under it why.
 *
 * The notice at the top of the page said the same thing a screen away from the control it was
 * about; here it is the control. Screens draw this in place of their button (see {Button}'s and
 * {ConfirmButton}'s `locked`).
 */
export function LockedButton({style}: {style?: StyleProp<ViewStyle>}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {lockLevel} = useVaultGate();
  const level = lockLevel === 2 ? 2 : 1;
  return (
    <View style={[styles.lockedWrap, style]}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityState={{disabled: true}}
        accessibilityLabel={`${t(LOCK_TITLE[level])}. ${t('mobile.vault.lock_notice_op')}`}
        style={[styles.locked, {backgroundColor: level === 2 ? FOREVER : c.warning}]}>
        <SettingsIcon name={LOCK_ICON[level]} size={20} round />
        <Text style={[styles.lockedLabel, {color: level === 2 ? '#fff' : '#000'}]}>{t(LOCK_TITLE[level])}</Text>
      </View>
      <Text style={styles.hint}>{t('mobile.vault.lock_notice_op')}</Text>
    </View>
  );
}

/** Whether the vault is locked right now — what decides that a refused operation shows {LockedButton}. */
export function useVaultLocked(): boolean {
  const {lockLevel} = useVaultGate();
  return lockLevel === 1 || lockLevel === 2;
}

/** The reason a control is disabled, under it. Nothing while it is allowed. */
export function GateHint({gate, style}: {gate: Gate; style?: StyleProp<ViewStyle>}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const key = gateReasonKey(gate);
  if (!key) return null;
  return (
    <View style={style}>
      <Text style={styles.hint}>{t(key)}</Text>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    box: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      padding: 14,
      borderRadius: 14,
      borderWidth: 1,
      backgroundColor: c.card,
    },
    body: {flex: 1, gap: 2},
    title: {fontSize: 15, fontWeight: '600'},
    text: {color: c.subtext, fontSize: 13, lineHeight: 18},
    hint: {color: c.subtext, fontSize: 12, lineHeight: 17, textAlign: 'center'},
    lockedWrap: {gap: 8},
    // The confirm pill's shape, in the card colour with the lock's outline: plainly not the action.
    locked: {
      height: 52,
      borderRadius: 26,
      // The disabled look every Button uses.
      opacity: 0.5,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 20,
    },
    lockedLabel: {fontSize: 17, fontWeight: '600'},
  });

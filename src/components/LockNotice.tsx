import React from 'react';
import {Alert, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {SettingsIcon} from '@/components/SettingsIcon';
import {LOCK_ICON, LOCK_TITLE} from '@/core/lock-status';
import {useStyles, type Colors} from '@/theme';
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
 * The lock's icon, at the front of an operation's confirm button while the lock refuses it — where
 * the Face ID mark would be. The button keeps its own colour and words and is simply disabled; the
 * icon says why, and a tap on it says so in words: the lock's name, and that this operation is not
 * supported while it holds.
 */
export function LockIcon({level, size = 20}: {level: 1 | 2; size?: number}) {
  const {t} = useT();
  return (
    <Pressable
      onPress={() => Alert.alert(t(LOCK_TITLE[level]), t('mobile.vault.lock_notice_op'))}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={t(LOCK_TITLE[level])}>
      <SettingsIcon name={LOCK_ICON[level]} size={size} round />
    </Pressable>
  );
}

/** The vault's lock right now: 0 unlocked, 1 the emergency lock, 2 locked forever. */
export function useLockLevel(): 0 | 1 | 2 {
  const {lockLevel} = useVaultGate();
  return lockLevel === 1 || lockLevel === 2 ? lockLevel : 0;
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
  });

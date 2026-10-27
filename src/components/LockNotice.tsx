import React from 'react';
import {Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {SettingsIcon} from '@/components/SettingsIcon';
import {LOCK_ICON, LOCK_TITLE} from '@/core/lock-status';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {gateReasonKey, useVaultGate} from '@/vault/gate';
import type {Gate} from '@/vault/capabilities';

// The lock's two colours, as LockBadge and the Lock status rows draw them: orange for the lock the
// owner can undo, red for the one nobody can.
const TEMP = '#FF9500';
const FOREVER = '#FF3B30';

/**
 * At the top of a screen whose actions a lock pauses: what is paused, what still works, and — on
 * tap — Lock status. Nothing while the vault is unlocked.
 *
 * Said once here rather than under every control, so a locked Trade screen reads as "locked" before
 * it reads as a page of grey buttons. The controls still carry their own one-line reason
 * ({GateHint}), for the one the user was about to press.
 */
export function LockNotice({style, beforeNavigate}: {style?: StyleProp<ViewStyle>; beforeNavigate?: () => void}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {lockLevel} = useVaultGate();
  if (lockLevel !== 1 && lockLevel !== 2) return null;
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
        <Text style={styles.text}>
          {t(lockLevel === 2 ? 'mobile.vault.lock_notice_forever' : 'mobile.vault.lock_notice_temp')}
        </Text>
      </View>
    </Pressable>
  );
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

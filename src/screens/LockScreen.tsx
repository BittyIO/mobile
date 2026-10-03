import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Alert, AppState, Image, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Button} from '@/components/Button';
import {useWallet} from '@/wallet/store';
import {deviceCompromised, iosVersionRisk} from '@/core/device-security';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/** Lock screen — unlock the on-device wallet with Face ID / passcode. */
export function LockScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const unlock = useWallet((s) => s.unlock);
  const lockedBy = useWallet((s) => s.lockedBy);
  const [busy, setBusy] = useState(false);
  // iOS below the safe floor (missing an actively-exploited fix) — a warning, not a block, so an
  // old-iOS owner is never locked out of their funds.
  const risk = iosVersionRisk();

  const inFlight = useRef(false);
  // A jailbroken/debugged device can lift the in-memory key; refuse by default, but let the owner
  // override (the key is theirs, and a hard block could strand funds). Remembered for the session so
  // the auto-unlock-on-foreground does not re-prompt.
  const compromiseAck = useRef(false);
  const onUnlock = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (!compromiseAck.current && (await deviceCompromised())) {
        const proceed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            'This device looks compromised',
            'Bitty detected a jailbreak or debugger. On such a device your recovery phrase can be stolen when you unlock. Continue only if you trust this device.',
            [
              {text: 'Cancel', style: 'cancel', onPress: () => resolve(false)},
              {text: 'Continue anyway', style: 'destructive', onPress: () => resolve(true)},
            ],
            {cancelable: false},
          );
        });
        if (!proceed) return;
        compromiseAck.current = true;
      }
      await unlock();
    } catch {
      // Cancelled the prompt — stay locked; the button below retries.
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [unlock]);

  // At launch Face ID starts on its own: as soon as this screen shows, and again each time the app
  // returns to the foreground while still locked. After Lock in Settings it waits for the button, so
  // the lock holds until the user asks to unlock.
  useEffect(() => {
    if (lockedBy !== 'launch') return;
    void onUnlock();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void onUnlock();
    });
    return () => sub.remove();
  }, [onUnlock, lockedBy]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        <Image source={require('@/assets/logo.png')} style={styles.logo} resizeMode="contain" />
        <Text style={styles.title}>Bitty</Text>
      </View>
      <View style={styles.actions}>
        {!risk.ok && (
          <Text style={styles.warn}>
            {`iOS ${risk.version} may be missing a security update (fixed in ${risk.floor}). Update in Settings → General → Software Update.`}
          </Text>
        )}
        <Button title={t('mobile.payments.lock_unlock_face_id')} faceId onPress={onUnlock} loading={busy} style={styles.unlockBtn} />
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg, padding: 24, justifyContent: 'space-between'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10},
  logo: {width: 88, height: 88, borderRadius: 20},
  title: {color: c.text, fontSize: 30, fontWeight: '800'},
  actions: {gap: 12, paddingBottom: 12, alignItems: 'center'},
  warn: {color: '#F0B429', fontSize: 12, textAlign: 'center', paddingHorizontal: 16, lineHeight: 17},
  // Sized to its label, not the screen: a compact pill centred at the bottom.
  unlockBtn: {alignSelf: 'center', paddingHorizontal: 32, minWidth: 180},
});

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, Image, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Button} from '@/components/Button';
import {useWallet} from '@/wallet/store';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/** Lock screen — unlock the on-device wallet with Face ID / passcode. */
export function LockScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const unlock = useWallet((s) => s.unlock);
  const lockedBy = useWallet((s) => s.lockedBy);
  const [busy, setBusy] = useState(false);

  const inFlight = useRef(false);
  const onUnlock = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
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
  // Sized to its label, not the screen: a compact pill centred at the bottom.
  unlockBtn: {alignSelf: 'center', paddingHorizontal: 32, minWidth: 180},
});

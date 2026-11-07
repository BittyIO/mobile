import React, {useEffect, useRef} from 'react';
import {Linking, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import {getAddress} from 'viem';
import {useT} from '@/i18n';

/**
 * The address in a scanned QR code, or null when it holds none.
 *
 * Wallets put an address in a code a few ways: bare, as an EIP-681 link (`ethereum:0x…@1`), or with
 * the Safe app's chain prefix (`eth:0x…`, `base:0x…`). Whatever surrounds it, the first 20-byte hex
 * in the text is the address.
 */
export function addressInQr(text: string): `0x${string}` | null {
  const m = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.exec(text);
  if (!m) return null;
  try {
    return getAddress(m[0]);
  } catch {
    return null;
  }
}

/**
 * A full-screen camera that reads one QR code holding an address and hands it back.
 *
 * The camera is asked for the first time it opens. Refused, the screen says so and offers the
 * phone's Settings, where it can be turned back on; a code that holds no address is ignored and
 * scanning carries on.
 */
export function QrScanner<A extends string = `0x${string}`>({
  visible,
  onScan,
  onClose,
  parse,
}: {
  visible: boolean;
  onScan: (address: A) => void;
  onClose: () => void;
  /** What counts as an address in a code; an EVM address unless told otherwise (Tron's wallet passes its own). */
  parse?: (text: string) => A | null;
}) {
  const read = parse ?? (addressInQr as unknown as (text: string) => A | null);
  const {t} = useT();
  const device = useCameraDevice('back');
  const {hasPermission, requestPermission} = useCameraPermission();
  // One code per opening: the scanner fires many times a second while a code is in view.
  const done = useRef(false);

  useEffect(() => {
    if (!visible) return;
    done.current = false;
    if (!hasPermission) void requestPermission();
  }, [visible, hasPermission, requestPermission]);

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      if (done.current) return;
      const address = codes.map((c) => (c.value ? read(c.value) : null)).find(Boolean);
      if (!address) return;
      done.current = true;
      onScan(address);
    },
  });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.root}>
        {hasPermission && device ? (
          <Camera style={StyleSheet.absoluteFill} device={device} isActive={visible} codeScanner={codeScanner} />
        ) : (
          <View style={styles.denied}>
            <Text style={styles.deniedText}>{t('mobile.scan.no_camera')}</Text>
            <Pressable onPress={() => void Linking.openSettings()} hitSlop={8} accessibilityRole="button">
              <Text style={styles.link}>{t('mobile.scan.open_settings')}</Text>
            </Pressable>
          </View>
        )}
        {/* Where to hold the code: a square in the middle of the view. */}
        {hasPermission && device ? <View pointerEvents="none" style={styles.frame} /> : null}
        <Text style={styles.hint}>{t('mobile.scan.hint')}</Text>
        <Pressable style={styles.close} onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <Text style={styles.closeText}>{t('common.close')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

// Over a live camera image, so fixed light-on-dark colours rather than the theme's.
const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center'},
  frame: {width: 240, height: 240, borderRadius: 24, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)'},
  hint: {position: 'absolute', bottom: 140, color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center', paddingHorizontal: 32},
  close: {position: 'absolute', bottom: 60, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.18)'},
  closeText: {color: '#fff', fontSize: 16, fontWeight: '600'},
  denied: {alignItems: 'center', gap: 16, paddingHorizontal: 32},
  deniedText: {color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center'},
  link: {color: '#0E85FF', fontSize: 16, fontWeight: '600'},
});

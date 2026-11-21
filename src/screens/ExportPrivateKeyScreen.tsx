import React, {useEffect, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import type {RootStackParamList} from '@/App';
import {SettingsGroup} from '@/components/SettingsRow';
import {showToast} from '@/components/Toast';
import {useRevealGuard} from '@/core/device-security';
import {exportAccountKey, exportImportedKey} from '@/wallet/keyring';
import {useT} from '@/i18n';
import {useStyles, type Colors, MONO} from '@/theme';

/**
 * Recovery phrases › a key › Show private key: one owner key, to take to another wallet — a vault
 * owner's key from a phrase (`phrase` and `account`), or a key imported on its own (`imported`).
 *
 * Like the recovery phrase: nothing shows until Reveal is tapped and Face ID passes, it lives in
 * this page's state only, it is hidden while the screen is recorded, and a screenshot pulls it with
 * a warning. Copying puts it on the clipboard, which the page warns about first.
 */
export function ExportPrivateKeyScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const params = useRoute<RouteProp<RootStackParamList, 'ExportPrivateKey'>>().params;
  const [key, setKey] = useState<string | null>(null);
  const reveal = useRevealGuard();

  useEffect(() => {
    if (reveal.screenshotCount > 0 && key) {
      setKey(null);
      Alert.alert(t('mobile.settings.phrase_screenshot_title'), t('mobile.phrases.export_screenshot'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.screenshotCount]);

  const onReveal = async () => {
    try {
      const k = params.imported ? await exportImportedKey(params.imported) : await exportAccountKey(params.account ?? 0, params.phrase);
      if (k) setKey(k);
    } catch {
      // cancelled biometric prompt
    }
  };

  const onCopy = () =>
    Alert.alert(t('mobile.phrases.copy_key_title'), t('mobile.phrases.copy_key_body'), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('mobile.phrases.copy_key'),
        onPress: () => {
          if (!key) return;
          Clipboard.setString(key);
          showToast('success', t('mobile.phrases.key_copied'));
        },
      },
    ]);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup>
        <View style={styles.box}>
          <Text style={styles.addrLabel}>{params.address}</Text>
          <Text style={styles.warn}>{t('mobile.phrases.export_warning')}</Text>
        </View>
      </SettingsGroup>
      <SettingsGroup>
        <View style={styles.box}>
          {!key ? (
            <Pressable style={({pressed}) => [styles.revealBtn, pressed && styles.off]} onPress={onReveal}>
              <Text style={styles.revealText}>{t('mobile.settings.reveal_face_id')}</Text>
            </Pressable>
          ) : reveal.captured ? (
            <Text style={styles.warn}>{t('mobile.phrases.export_hidden_capture')}</Text>
          ) : (
            <>
              <Text style={styles.key} selectable={false}>
                {key}
              </Text>
              <View style={styles.btns}>
                <Pressable style={styles.btn} onPress={() => setKey(null)}>
                  <Text style={styles.btnText}>{t('mobile.settings.hide')}</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onCopy}>
                  <Text style={[styles.btnText, styles.btnPrimaryText]}>{t('mobile.phrases.copy_key')}</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 20},
    box: {padding: 16, gap: 12},
    addrLabel: {color: c.subtext, fontSize: 13, fontFamily: MONO, lineHeight: 18},
    warn: {color: c.danger, fontSize: 14, lineHeight: 20, fontWeight: '600'},
    key: {color: c.text, fontSize: 15, fontFamily: MONO, lineHeight: 22, backgroundColor: c.bg, borderRadius: 10, padding: 12},
    revealBtn: {minHeight: 48, paddingVertical: 8, borderRadius: 24, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center'},
    revealText: {color: c.onAccent, fontSize: 15, fontWeight: '700'},
    off: {opacity: 0.5},
    btns: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    btn: {backgroundColor: c.bg, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderColor: c.border},
    btnText: {color: c.text, fontSize: 13, fontWeight: '600'},
    btnPrimary: {backgroundColor: c.accent, borderColor: c.accent},
    btnPrimaryText: {color: c.onAccent},
  });

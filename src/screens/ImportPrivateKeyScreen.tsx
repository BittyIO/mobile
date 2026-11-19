import React, {useState} from 'react';
import {Keyboard, ScrollView, StyleSheet, Text} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {Button} from '@/components/Button';
import {SecretKeyInput} from '@/components/SecretKeyInput';
import {showToast} from '@/components/Toast';
import {alertIfBiometricsRequired} from '@/components/biometrics-alert';
import {useRevealGuard} from '@/core/device-security';
import {parsePrivateKey} from '@/wallet/keyring';
import {useWallet} from '@/wallet/store';
import {useT} from '@/i18n';
import {useStyles, type Colors, MONO} from '@/theme';

/**
 * Vaults › Import a private key: a key from another wallet, kept on this phone behind Face ID like a
 * recovery phrase, and the vault it owns (the one the factory derives from it) put in front, listed
 * under Imported private keys.
 *
 * The key is typed or pasted into a hidden field and lives in this page's state only until it is
 * stored. No phrase restores it, which the page says: the key is the user's to back up.
 */
export function ImportPrivateKeyScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const importKey = useWallet((s) => s.importKey);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Hidden while the screen is recorded or mirrored, as the recovery phrase is.
  const reveal = useRevealGuard();

  const onImport = async () => {
    setError(null);
    const key = parsePrivateKey(draft);
    if (!key) return setError(t('mobile.safe.invalid_key'));
    setBusy(true);
    try {
      await importKey(key);
      Keyboard.dismiss();
      setDraft('');
      showToast('success', t('mobile.phrases.key_added'));
      // Back to the vault now in front, as choosing one on the list does.
      nav.popToTop();
    } catch (e) {
      if (alertIfBiometricsRequired(e, t)) return;
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <Text style={styles.p}>{t('mobile.phrases.import_key_desc')}</Text>
      {reveal.captured ? (
        <Text style={styles.warn}>{t('mobile.settings.phrase_hidden_capture')}</Text>
      ) : (
        <SecretKeyInput
          value={draft}
          onChangeText={(v) => {
            setDraft(v);
            setError(null);
          }}
          onSubmit={onImport}
          error={!!error}
        />
      )}
      {error ? <Text style={styles.warn}>{error}</Text> : null}
      <Button title={t('mobile.phrases.import_key_btn')} onPress={onImport} loading={busy} disabled={busy || !draft || reveal.captured} />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 16},
    p: {color: c.subtext, fontSize: 14, lineHeight: 20},
    warn: {color: c.danger, fontSize: 13, lineHeight: 18},
    inputWrap: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.input, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: 'transparent'},
    inputError: {borderColor: c.danger},
    input: {flex: 1, color: c.text, fontSize: 15, fontFamily: MONO, paddingVertical: 14},
    pill: {backgroundColor: c.card, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12},
    pillText: {color: c.accent, fontSize: 13, fontWeight: '600'},
    pressed: {opacity: 0.6},
  });

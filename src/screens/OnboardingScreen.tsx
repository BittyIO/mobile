import React, {useMemo, useState} from 'react';
import {Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Button} from '@/components/Button';
import {useWallet} from '@/wallet/store';
import {generateNewMnemonic} from '@/wallet/keyring';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

type Step = 'choose' | 'reveal' | 'import';

/**
 * First-run onboarding. Create a new wallet (reveal the 12-word phrase once, confirm it's saved) or
 * import an existing recovery phrase. The mnemonic is only persisted (via the store, which unlocks)
 * after the user proves they wrote it down. Bitty is a self-custodial wallet — the phrase is the only
 * recovery; there is no backend backup.
 */
export function OnboardingScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const createWallet = useWallet((s) => s.createWallet);
  const importWallet = useWallet((s) => s.importWallet);

  const [step, setStep] = useState<Step>('choose');
  const [mnemonic, setMnemonic] = useState('');
  const [phrase, setPhrase] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const words = useMemo(() => (mnemonic ? mnemonic.split(' ') : []), [mnemonic]);

  const onCreate = () => {
    setMnemonic(generateNewMnemonic());
    setSaved(false);
    setStep('reveal');
  };

  const onCommitNew = async () => {
    setBusy(true);
    try {
      // Re-generate through the store so it persists to the Keychain + unlocks.
      await importWallet(mnemonic);
    } catch (e) {
      Alert.alert(t('vault.failed'), String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    setBusy(true);
    try {
      await importWallet(phrase);
    } catch (e) {
      Alert.alert(t('mobile.payments.onboarding_invalid_phrase'), String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.body}>
        {step === 'choose' ? (
          <>
            <View style={styles.hero}>
              <Image source={require('@/assets/logo.png')} style={styles.logo} resizeMode="contain" />
              <Text style={styles.title}>Bitty</Text>
              <Text style={styles.tagline}>{t('mobile.payments.onboarding_tagline')}</Text>
            </View>
            <View style={styles.actions}>
              <Button title={t('mobile.payments.onboarding_create')} onPress={onCreate} />
              <Button title={t('mobile.payments.onboarding_import')} variant="secondary" onPress={() => setStep('import')} />
            </View>
            <Text style={styles.fine}>{t('mobile.payments.onboarding_fine')}</Text>
          </>
        ) : step === 'reveal' ? (
          <>
            <Text style={styles.h}>{t('mobile.payments.onboarding_reveal_title')}</Text>
            <Text style={styles.p}>{t('mobile.payments.onboarding_reveal_desc')}</Text>
            <View style={styles.grid}>
              {words.map((w, i) => (
                <View key={`${w}-${i}`} style={styles.word}>
                  <Text style={styles.wordIdx}>{i + 1}</Text>
                  <Text style={styles.wordText}>{w}</Text>
                </View>
              ))}
            </View>
            <Pressable style={styles.check} onPress={() => setSaved((v) => !v)}>
              <View style={[styles.box, saved && styles.boxOn]}>{saved ? <Text style={styles.tick}>✓</Text> : null}</View>
              <Text style={styles.checkText}>{t('mobile.payments.onboarding_saved_ack')}</Text>
            </Pressable>
            <Button title={busy ? t('mobile.payments.onboarding_creating') : t('mobile.payments.onboarding_continue')} onPress={onCommitNew} loading={busy} disabled={!saved || busy} />
            <Button title={t('common.back')} variant="secondary" onPress={() => setStep('choose')} />
          </>
        ) : (
          <>
            <Text style={styles.h}>{t('mobile.payments.onboarding_import')}</Text>
            <Text style={styles.p}>{t('mobile.payments.onboarding_import_desc')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('mobile.payments.onboarding_import_placeholder')}
              placeholderTextColor={c.subtext}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              value={phrase}
              onChangeText={setPhrase}
            />
            <Button title={busy ? t('mobile.payments.onboarding_importing') : t('mobile.payments.onboarding_import_btn')} onPress={onImport} loading={busy} disabled={busy || phrase.trim().split(/\s+/).length < 12} />
            <Button title={t('common.back')} variant="secondary" onPress={() => setStep('choose')} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  body: {padding: 24, gap: 16, flexGrow: 1, justifyContent: 'center'},
  hero: {alignItems: 'center', gap: 8, marginBottom: 12},
  logo: {width: 88, height: 88, borderRadius: 20, marginBottom: 8},
  title: {color: c.text, fontSize: 32, fontWeight: '800'},
  tagline: {color: c.subtext, fontSize: 15},
  actions: {gap: 12},
  fine: {color: c.subtext, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 8},
  h: {color: c.text, fontSize: 22, fontWeight: '700'},
  p: {color: c.subtext, fontSize: 14, lineHeight: 20},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between'},
  word: {width: '47%', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.card, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12},
  wordIdx: {color: c.subtext, fontSize: 12, width: 18},
  wordText: {color: c.text, fontSize: 14, fontWeight: '600'},
  check: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4},
  box: {width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center'},
  boxOn: {backgroundColor: c.accent, borderColor: c.accent},
  tick: {color: c.onAccent, fontSize: 14, fontWeight: '800'},
  checkText: {color: c.text, fontSize: 14, flex: 1},
  input: {minHeight: 96, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, color: c.text, padding: 16, fontSize: 16, textAlignVertical: 'top'},
});

import React, {useEffect, useMemo, useState} from 'react';
import {Alert, Image, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Button} from '@/components/Button';
import {useWallet} from '@/wallet/store';
import {backupChoices, markPhraseVerified} from '@/wallet/phrase-backup';
import {generateNewMnemonic} from '@/wallet/keyring';
import {useRevealGuard} from '@/core/device-security';
import {PhraseInput} from '@/components/PhraseInput';
import {validateMnemonic} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

type Step = 'choose' | 'reveal' | 'confirm' | 'import';

function randomIndex(max: number): number {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0] % max;
}

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function randomPositions(): number[] {
  return shuffled(Array.from({length: 12}, (_, i) => i + 1)).slice(0, 3).sort((a, b) => a - b);
}

/**
 * First-run onboarding: create a wallet (the generated phrase is stored only after the user confirms
 * three words), or restore one from its recovery phrase.
 *
 * Restore is not optional. The phrase lives in the Keychain, which iOS deletes with the app, so
 * without it a user who reinstalled could never reach their vault again — the phrase they were
 * made to write down had nowhere to go.
 */
export function OnboardingScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const createWallet = useWallet((s) => s.createWallet);

  const [step, setStep] = useState<Step>('choose');
  const [mnemonic, setMnemonic] = useState('');
  const [challengePositions, setChallengePositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  // The phrase being restored, word by word: always 24 slots, the first `importCount` of them used.
  const [importWords, setImportWords] = useState<string[]>(() => Array(24).fill(''));
  const [importCount, setImportCount] = useState<12 | 24>(12);
  const phrase = importWords.slice(0, importCount).join(' ');

  const words = useMemo(() => (mnemonic ? mnemonic.split(' ') : []), [mnemonic]);
  // Three choices per position — the word and two others from the phrase. See {backupChoices}.
  const wordChoices = useMemo(
    () => Object.fromEntries(challengePositions.map((p) => [p, backupChoices(words, p)])) as Record<number, string[]>,
    [words, challengePositions],
  );

  // Hide phrase-derived content while the screen is recorded; warn (can't prevent) on a screenshot.
  const reveal = useRevealGuard();
  useEffect(() => {
    if (reveal.screenshotCount > 0 && (step === 'reveal' || step === 'confirm')) {
      Alert.alert(
        'Screenshot detected',
        'Anything in Photos can sync to the cloud and be stolen. Write your recovery phrase on paper instead, then delete the screenshot.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.screenshotCount]);

  const onCreate = () => {
    const nextMnemonic = generateNewMnemonic();
    setMnemonic(nextMnemonic);
    setChallengePositions(randomPositions());
    setAnswers({});
    setStep('reveal');
  };

  const onCommitNew = async () => {
    const matches = challengePositions.every((position) => answers[position] === words[position - 1]);
    if (!matches) {
      Alert.alert(t('mobile.payments.onboarding_words_mismatch'));
      setChallengePositions(randomPositions());
      setAnswers({});
      return;
    }

    setBusy(true);
    try {
      await createWallet(mnemonic);
      markPhraseVerified();
    } catch (e) {
      Alert.alert(t('vault.failed'), String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    setBusy(true);
    try {
      await createWallet(phrase);
      // Typed in from the backup, so the backup is proven.
      markPhraseVerified();
    } catch (e) {
      Alert.alert(t('mobile.payments.onboarding_invalid_phrase'), String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const allFilled = importWords.slice(0, importCount).every(Boolean);
  const phraseValid = allFilled && validateMnemonic(phrase, wordlist);

  const phraseHidden = reveal.captured && (step === 'reveal' || step === 'confirm' || step === 'import');

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.body}>
        {step === 'choose' ? (
          <>
            <View style={styles.hero}>
              <Image source={require('@/assets/logo.png')} style={styles.logo} resizeMode="contain" />
              <Text style={styles.title}>{t('mobile.app.name')}</Text>
              <Text style={styles.tagline}>{t('mobile.payments.onboarding_tagline')}</Text>
            </View>
            <View style={styles.actions}>
              <Button title={t('mobile.payments.onboarding_create')} onPress={onCreate} />
              <Button title={t('mobile.payments.onboarding_import')} variant="secondary" onPress={() => setStep('import')} />
            </View>
            <Text style={styles.fine}>{t('mobile.payments.onboarding_fine')}</Text>
          </>
        ) : step === 'import' ? (
          <>
            <Text style={styles.h}>{t('mobile.payments.onboarding_import')}</Text>
            <Text style={styles.p}>{t('mobile.payments.onboarding_import_desc')}</Text>
            {phraseHidden ? (
              <View style={styles.grid}>
                <Text style={styles.fine}>
                  Your recovery phrase is hidden while the screen is being recorded or mirrored. Stop
                  the recording to enter it.
                </Text>
              </View>
            ) : (
              <PhraseInput words={importWords} count={importCount} onChange={setImportWords} onCount={setImportCount} />
            )}
            {allFilled && !phraseValid ? <Text style={styles.bad}>{t('mobile.payments.onboarding_phrase_invalid')}</Text> : null}
            <Button
              title={busy ? t('mobile.payments.onboarding_importing') : t('mobile.payments.onboarding_import_btn')}
              onPress={onImport}
              loading={busy}
              disabled={phraseHidden || busy || !phraseValid}
            />
            <Button
              title={t('common.back')}
              variant="secondary"
              onPress={() => {
                setImportWords(Array(24).fill(''));
                setStep('choose');
              }}
              disabled={busy}
            />
          </>
        ) : step === 'reveal' ? (
          <>
            <Text style={styles.h}>{t('mobile.payments.onboarding_reveal_title')}</Text>
            <Text style={styles.p}>{t('mobile.payments.onboarding_reveal_desc')}</Text>
            {phraseHidden ? (
              <View style={styles.grid}>
                <Text style={styles.fine}>
                  Your recovery phrase is hidden while the screen is being recorded or mirrored. Stop
                  the recording to reveal it.
                </Text>
              </View>
            ) : (
              <View style={styles.grid}>
                {words.map((w, i) => (
                  <View key={`${i}-${w}`} style={styles.word}>
                    <Text style={styles.wordIdx}>{i + 1}</Text>
                    <Text style={styles.wordText}>{w}</Text>
                  </View>
                ))}
              </View>
            )}
            <Button title={t('mobile.payments.onboarding_verify_phrase')} onPress={() => setStep('confirm')} disabled={phraseHidden} />
            <Button
              title={t('common.back')}
              variant="secondary"
              onPress={() => {
                setMnemonic('');
                setStep('choose');
              }}
            />
          </>
        ) : (
          <>
            <Text style={styles.h}>{t('mobile.payments.onboarding_confirm_title')}</Text>
            <Text style={styles.p}>
              {t('mobile.payments.onboarding_confirm_desc', {
                first: challengePositions[0],
                second: challengePositions[1],
                third: challengePositions[2],
              })}
            </Text>
            {phraseHidden ? (
              <View style={styles.grid}>
                <Text style={styles.fine}>
                  Your recovery phrase is hidden while the screen is being recorded or mirrored. Stop
                  the recording to confirm it.
                </Text>
              </View>
            ) : (
              <View style={styles.questions}>
                {challengePositions.map((position) => (
                  <View key={position} style={styles.question}>
                    <Text style={styles.questionTitle}>
                      {t('mobile.payments.onboarding_word_position', {position})}
                      {answers[position] ? ` · ${answers[position]}` : ''}
                    </Text>
                    <View style={styles.choices}>
                      {(wordChoices[position] ?? []).map((word) => {
                        const selected = answers[position] === word;
                        return (
                          <Pressable
                            key={word}
                            accessibilityRole="button"
                            accessibilityState={{selected}}
                            style={[styles.choice, selected && styles.choiceSelected]}
                            onPress={() => setAnswers((current) => ({...current, [position]: word}))}
                          >
                            <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{word}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            )}
            <Button
              title={busy ? t('mobile.payments.onboarding_creating') : t('mobile.payments.onboarding_confirm_button')}
              onPress={onCommitNew}
              loading={busy}
              disabled={phraseHidden || busy || challengePositions.some((position) => !answers[position])}
            />
            <Button title={t('mobile.payments.onboarding_back_to_phrase')} variant="secondary" onPress={() => setStep('reveal')} disabled={busy} />
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
  questions: {gap: 16},
  question: {gap: 8},
  questionTitle: {color: c.text, fontSize: 15, fontWeight: '700'},
  choices: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  choice: {backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12},
  choiceSelected: {backgroundColor: c.accent, borderColor: c.accent},
  choiceText: {color: c.text, fontSize: 14, fontWeight: '600'},
  choiceTextSelected: {color: c.onAccent},
  bad: {color: c.danger, fontSize: 13, lineHeight: 18},
  input: {minHeight: 96, borderRadius: 12, backgroundColor: c.input, color: c.text, padding: 16, fontSize: 17, textAlignVertical: 'top'},
});

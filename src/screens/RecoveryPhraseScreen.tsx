import React, {useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {SettingsGroup} from '@/components/SettingsRow';
import {revealMnemonic} from '@/wallet/keyring';
import {useRevealGuard} from '@/core/device-security';
import {useWallet} from '@/wallet/store';
import {isPhraseVerified, markPhraseVerified} from '@/wallet/phrase-backup';

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

/** Three of the phrase's positions, 1-based, in order. */
const randomPositions = (n: number): number[] =>
  shuffled(Array.from({length: n}, (_, i) => i + 1)).slice(0, 3).sort((a, b) => a - b);

/**
 * Recovery phrase (Security › Recovery phrase) — the words behind the key, shown here and nowhere
 * else. Nothing shows until the Reveal button is tapped and Face ID passes — opening the page alone
 * never prompts. The phrase lives only in this page's state, so leaving the page forgets it.
 *
 * Hidden while the screen is recorded or mirrored, and pulled (with a warning) if a screenshot is
 * taken while it shows.
 *
 * Under the words, "I saved my phrase — verify it" hides them and asks for three of them back,
 * picked from the twelve shuffled, as onboarding does. Passing marks the backup verified, which the
 * Security row shows; a wallet made before that check existed reads "Not verified" until it does.
 */
export function RecoveryPhraseScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const [phrase, setPhrase] = useState<string | null>(null);
  const reveal = useRevealGuard();
  const signer = useWallet((s) => s.account?.address);
  const [verified, setVerified] = useState(() => isPhraseVerified(signer));
  // Positions being asked for, or null while the words show (or nothing does).
  const [ask, setAsk] = useState<number[] | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const words = useMemo(() => (phrase ? phrase.split(' ') : []), [phrase]);
  const choices = useMemo(() => shuffled(Array.from(new Set(words))), [words]);

  const startVerify = () => {
    setAnswers({});
    setAsk(randomPositions(words.length));
  };
  const onVerify = () => {
    if (!ask) return;
    if (ask.every((p) => answers[p] === words[p - 1])) {
      markPhraseVerified(signer);
      setVerified(true);
      setAsk(null);
      setPhrase(null);
      return;
    }
    Alert.alert(t('mobile.payments.onboarding_words_mismatch'));
    startVerify();
  };
  const hide = () => {
    setAsk(null);
    setPhrase(null);
  };

  const onReveal = async () => {
    try {
      const m = await revealMnemonic();
      if (m) setPhrase(m);
    } catch {
      // cancelled biometric prompt
    }
  };
  useEffect(() => {
    if (reveal.screenshotCount > 0 && phrase) {
      setPhrase(null);
      setAsk(null);
      Alert.alert(
        'Screenshot detected',
        'Your recovery phrase was hidden. Never keep it in Photos or anywhere synced to the cloud — write it on paper.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.screenshotCount]);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup>
        <View style={styles.box}>
          {!phrase ? null : reveal.captured ? (
            <Text style={styles.warn}>
              Hidden while your screen is being recorded or mirrored. Stop the recording to view your
              recovery phrase.
            </Text>
          ) : ask ? (
            <View style={styles.questions}>
              <Text style={styles.p}>
                {t('mobile.payments.onboarding_confirm_desc', {first: ask[0], second: ask[1], third: ask[2]})}
              </Text>
              {ask.map((position) => (
                <View key={position} style={styles.question}>
                  <Text style={styles.questionTitle}>
                    {t('mobile.payments.onboarding_word_position', {position})}
                    {answers[position] ? ` · ${answers[position]}` : ''}
                  </Text>
                  <View style={styles.choices}>
                    {choices.map((word) => {
                      const selected = answers[position] === word;
                      return (
                        <Pressable
                          key={word}
                          accessibilityRole="button"
                          accessibilityState={{selected}}
                          style={[styles.choice, selected && styles.choiceSelected]}
                          onPress={() => setAnswers((a) => ({...a, [position]: word}))}>
                          <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{word}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <View style={styles.grid}>
              {words.map((w, i) => (
                <View key={`${w}-${i}`} style={styles.word}>
                  <Text style={styles.wordIdx}>{i + 1}</Text>
                  <Text style={styles.wordText}>{w}</Text>
                </View>
              ))}
            </View>
          )}
          {!phrase && verified ? <Text style={styles.ok}>✓ {t('mobile.settings.phrase_verified')}</Text> : null}
          <Text style={styles.warn}>{t('mobile.settings.never_share')}</Text>
          <View style={styles.btns}>
            <Pressable style={styles.btn} onPress={phrase ? hide : onReveal}>
              <Text style={styles.btnText}>{t(phrase ? 'mobile.settings.hide' : 'mobile.settings.reveal_face_id')}</Text>
            </Pressable>
            {phrase && !reveal.captured ? (
              ask ? (
                <Pressable
                  style={[styles.btn, styles.btnPrimary, ask.some((p) => !answers[p]) && styles.btnOff]}
                  disabled={ask.some((p) => !answers[p])}
                  onPress={onVerify}>
                  <Text style={[styles.btnText, styles.btnPrimaryText]}>{t('mobile.settings.phrase_verify')}</Text>
                </Pressable>
              ) : (
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={startVerify}>
                  <Text style={[styles.btnText, styles.btnPrimaryText]}>{t('mobile.payments.onboarding_verify_phrase')}</Text>
                </Pressable>
              )
            ) : null}
          </View>
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
    btn: {backgroundColor: c.bg, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderColor: c.border, alignSelf: 'flex-start'},
    btnText: {color: c.text, fontSize: 13, fontWeight: '600'},
    grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between'},
    word: {width: '47%', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.bg, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12},
    wordIdx: {color: c.subtext, fontSize: 12, width: 18},
    wordText: {color: c.text, fontSize: 14, fontWeight: '600'},
    warn: {color: c.danger, fontSize: 12, lineHeight: 17},
    ok: {color: c.success, fontSize: 14, fontWeight: '600'},
    btns: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    btnPrimary: {backgroundColor: c.accent, borderColor: c.accent},
    btnPrimaryText: {color: c.onAccent},
    btnOff: {opacity: 0.5},
    p: {color: c.subtext, fontSize: 14, lineHeight: 20},
    questions: {gap: 16},
    question: {gap: 8},
    questionTitle: {color: c.text, fontSize: 15, fontWeight: '700'},
    choices: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    choice: {backgroundColor: c.bg, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12},
    choiceSelected: {backgroundColor: c.accent, borderColor: c.accent},
    choiceText: {color: c.text, fontSize: 14, fontWeight: '600'},
    choiceTextSelected: {color: c.onAccent},
  });

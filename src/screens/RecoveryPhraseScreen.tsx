import React, {useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import Svg, {Path, Rect} from 'react-native-svg';
import {SettingsGroup} from '@/components/SettingsRow';
import {revealMnemonic} from '@/wallet/keyring';
import {useRevealGuard} from '@/core/device-security';
import {useWallet} from '@/wallet/store';
import {backupChoices, isPhraseVerified, markPhraseVerified} from '@/wallet/phrase-backup';

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

type Tip = 'paper' | 'camera' | 'watch' | 'type' | 'ask';
const TIPS: Tip[] = ['paper', 'camera', 'watch', 'type', 'ask'];

/** One line-drawn mark per safety tip (lucide FilePen, CameraOff, EyeOff, a struck keyboard, ShieldAlert). */
function TipIcon({name, color}: {name: Tip; color: string}) {
  const st = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      {name === 'paper' ? (
        <>
          <Path d="M12 22h6a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v10" {...st} />
          <Path d="M14 2v4a2 2 0 0 0 2 2h4" {...st} />
          <Path d="M10.4 12.6a2 2 0 1 1 3 3L8 21l-4 1 1-4Z" {...st} />
        </>
      ) : name === 'camera' ? (
        <>
          <Path d="M2 2l20 20" {...st} />
          <Path d="M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16" {...st} />
          <Path d="M9.5 4h5L17 7h3a2 2 0 0 1 2 2v7.5" {...st} />
          <Path d="M14.1 15.1A3 3 0 1 1 9.9 10.9" {...st} />
        </>
      ) : name === 'watch' ? (
        <>
          <Path d="M9.9 9.9a3 3 0 1 0 4.2 4.2" {...st} />
          <Path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7" {...st} />
          <Path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6" {...st} />
          <Path d="M2 2l20 20" {...st} />
        </>
      ) : name === 'type' ? (
        <>
          <Rect x={2} y={5} width={20} height={14} rx={2} {...st} />
          <Path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10" {...st} />
          <Path d="M3 3l18 18" {...st} />
        </>
      ) : (
        <>
          <Path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z" {...st} />
          <Path d="M12 8v4M12 16h.01" {...st} />
        </>
      )}
    </Svg>
  );
}

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
 * Security row then shows; until then the row shows nothing rather than a standing "Not verified".
 *
 * Above it all, how to keep the words safe — paper, no cameras, nobody watching, never typed in,
 * and that Bitty never asks.
 */
export function RecoveryPhraseScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const [phrase, setPhrase] = useState<string | null>(null);
  const reveal = useRevealGuard();
  const signer = useWallet((s) => s.account?.address);
  const [verified, setVerified] = useState(() => isPhraseVerified(signer));
  // Positions being asked for, or null while the words show (or nothing does).
  const [ask, setAsk] = useState<number[] | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const words = useMemo(() => (phrase ? phrase.split(' ') : []), [phrase]);
  // Three choices per position — the word and two others from the phrase. See {backupChoices}.
  const choices = useMemo(
    () => (ask ? (Object.fromEntries(ask.map((p) => [p, backupChoices(words, p)])) as Record<number, string[]>) : {}),
    [words, ask],
  );

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
      Alert.alert(t('mobile.settings.phrase_screenshot_title'), t('mobile.settings.phrase_screenshot_body'));
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
      {/* How to keep the words safe, before and while they show: the page is the one place they
          appear, so it is the one place to say so. Each line is a way phrases are actually lost. */}
      <SettingsGroup>
        <View style={styles.tips}>
          {TIPS.map((tip) => (
            <View key={tip} style={styles.tip}>
              <TipIcon name={tip} color={tip === 'ask' ? c.danger : c.accent} />
              <Text style={[styles.tipText, tip === 'ask' && styles.tipWarn]}>{t(`mobile.settings.phrase_tip_${tip}`)}</Text>
            </View>
          ))}
        </View>
      </SettingsGroup>

      <SettingsGroup>
        <View style={styles.box}>
          {!phrase ? null : reveal.captured ? (
            <Text style={styles.warn}>{t('mobile.settings.phrase_hidden_capture')}</Text>
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
                    {(choices[position] ?? []).map((word) => {
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
          {/* Hidden: one wide button to reveal. Showing: Hide beside the check. */}
          {!phrase ? (
            <Pressable style={({pressed}) => [styles.revealBtn, pressed && styles.btnOff]} onPress={onReveal}>
              <Text style={styles.revealText}>{t('mobile.settings.reveal_face_id')}</Text>
            </Pressable>
          ) : null}
          <View style={styles.btns}>
            {phrase ? (
              <Pressable style={styles.btn} onPress={hide}>
                <Text style={styles.btnText}>{t('mobile.settings.hide')}</Text>
              </Pressable>
            ) : null}
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
    tips: {padding: 16, gap: 14},
    tip: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
    tipText: {flex: 1, color: c.text, fontSize: 14, lineHeight: 20},
    tipWarn: {color: c.danger, fontWeight: '600'},
    revealBtn: {height: 48, borderRadius: 24, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center'},
    revealText: {color: c.onAccent, fontSize: 15, fontWeight: '700'},
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

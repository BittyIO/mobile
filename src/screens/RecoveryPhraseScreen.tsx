import React, {useEffect, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {SettingsGroup} from '@/components/SettingsRow';
import {revealMnemonic} from '@/wallet/keyring';
import {useRevealGuard} from '@/core/device-security';

/**
 * Recovery phrase (Security › Recovery phrase) — the words behind the key, shown here and nowhere
 * else. Nothing shows until the Reveal button is tapped and Face ID passes — opening the page alone
 * never prompts. The phrase lives only in this page's state, so leaving the page forgets it.
 *
 * Hidden while the screen is recorded or mirrored, and pulled (with a warning) if a screenshot is
 * taken while it shows.
 */
export function RecoveryPhraseScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const [phrase, setPhrase] = useState<string | null>(null);
  const reveal = useRevealGuard();

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
          ) : (
            <View style={styles.grid}>
              {phrase.split(' ').map((w, i) => (
                <View key={`${w}-${i}`} style={styles.word}>
                  <Text style={styles.wordIdx}>{i + 1}</Text>
                  <Text style={styles.wordText}>{w}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={styles.warn}>{t('mobile.settings.never_share')}</Text>
          <Pressable style={styles.btn} onPress={phrase ? () => setPhrase(null) : onReveal}>
            <Text style={styles.btnText}>{t(phrase ? 'mobile.settings.hide' : 'mobile.settings.reveal_face_id')}</Text>
          </Pressable>
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
    btn: {backgroundColor: c.bg, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderColor: c.border, alignSelf: 'flex-start'},
    btnText: {color: c.text, fontSize: 13, fontWeight: '600'},
    grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between'},
    word: {width: '47%', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.bg, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12},
    wordIdx: {color: c.subtext, fontSize: 12, width: 18},
    wordText: {color: c.text, fontSize: 14, fontWeight: '600'},
    warn: {color: c.danger, fontSize: 12, lineHeight: 17},
  });

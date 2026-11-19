import React, {useCallback, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {listPhrases, phraseLabel} from '@/wallet/keyring';
import {isPhraseVerified} from '@/wallet/phrase-backup';
import {phraseOf, useVaults} from '@/core/vault-store';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * Security › Recovery phrases: every phrase on this phone, each with how many vaults it holds and
 * whether its backup has been checked. Tapping one opens it (reveal, verify, rename, delete — see
 * RecoveryPhraseScreen). Below, a new phrase can be created or one imported; each one added comes
 * with its first vault, which goes in front.
 *
 * Read again on focus: the phrase pages and the add flow change the list.
 */
export function RecoveryPhrasesScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const vaults = useVaults((s) => s.vaults);
  const [phrases, setPhrases] = useState(() => listPhrases());
  useFocusEffect(useCallback(() => setPhrases(listPhrases()), []));
  const name = (n: number) => t('mobile.phrases.phrase_n', {n});

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup>
        {phrases.map((p, i) => {
          const count = vaults.filter((v) => !v.imported && phraseOf(v) === p.id).length;
          return (
            <Pressable
              key={p.id}
              style={({pressed}) => [styles.row, i < phrases.length - 1 && styles.rowDivider, pressed && styles.pressed]}
              onPress={() => nav.navigate('VaultRecoveryPhrase', {phrase: p.id})}>
              <View style={styles.text}>
                <Text style={styles.name} numberOfLines={1}>
                  {phraseLabel(p, name)}
                </Text>
                <Text style={styles.sub}>
                  {t('mobile.phrases.vaults_count', {count})}
                  {isPhraseVerified(p.id) ? ` · ✓ ${t('mobile.settings.phrase_verified')}` : ''}
                </Text>
              </View>
              <Text style={styles.chev}>›</Text>
            </Pressable>
          );
        })}
      </SettingsGroup>

      <SettingsGroup footer={t('mobile.phrases.footer')}>
        <Pressable style={[styles.row, styles.rowDivider]} onPress={() => nav.navigate('AddRecoveryPhrase', {mode: 'create'})}>
          <Text style={styles.link}>{`＋ ${t('mobile.phrases.create')}`}</Text>
        </Pressable>
        <Pressable style={[styles.row, styles.rowDivider]} onPress={() => nav.navigate('AddRecoveryPhrase', {mode: 'import'})}>
          <Text style={styles.link}>{t('mobile.phrases.import')}</Text>
        </Pressable>
        <Pressable style={styles.row} onPress={() => nav.navigate('ImportPrivateKey')}>
          <Text style={styles.link}>{t('mobile.phrases.import_key')}</Text>
        </Pressable>
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 20, paddingBottom: 32},
    text: {flex: 1, gap: 3},
    name: {color: c.text, fontSize: 15, fontWeight: '600'},
    sub: {color: c.subtext, fontSize: 13},
    pressed: {opacity: 0.6},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
  });

import React, {useCallback, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {importedKeys, listPhrases, phraseLabel, unlockImported} from '@/wallet/keyring';
import {useWallet} from '@/wallet/store';
import {showToast} from '@/components/Toast';
import {asShown} from '@/core/format';
import {isPhraseVerified} from '@/wallet/phrase-backup';
import {IMPORTED_SECTION, phraseOf, useVaults, vaultLabel} from '@/core/vault-store';
import {deviceKeys} from '@/vault/owned-vaults';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {useStyles, type Colors, MONO} from '@/theme';

/** An address shortened to its first and last six: 0x111111…000000. */
const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/**
 * Security › Recovery phrases: every phrase on this phone, each with how many vaults it holds and
 * whether its backup has been checked. Tapping one opens it (reveal, verify, rename, delete — see
 * RecoveryPhraseScreen). Below, a new phrase can be created or one imported; each one added comes
 * with its first vault, which goes in front.
 *
 * Under them, the private keys imported on their own, each with how many vaults it signs for. Tapping
 * one offers to copy its address or delete it from the phone — after a warning and Face ID, since
 * only the key itself brings its vaults back.
 *
 * Read again on focus: the phrase pages and the add flow change the list.
 */
export function RecoveryPhrasesScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const vaults = useVaults((s) => s.vaults);
  const removeKey = useWallet((s) => s.removeKey);
  const [phrases, setPhrases] = useState(() => listPhrases());
  const [keys, setKeys] = useState(() => importedKeys());
  useFocusEffect(
    useCallback(() => {
      setPhrases(listPhrases());
      setKeys(importedKeys());
    }, []),
  );
  const signsFor = (key: string) => vaults.filter((v) => v.imported && (v.signer ?? v.owner)?.toLowerCase() === key.toLowerCase()).length;

  // The key behind each vault owner on a phrase, named by the vault it created (or its address).
  const ownerKeys = deviceKeys(vaults).filter((k) => k.phrase !== IMPORTED_SECTION);
  const ownerName = (address: string) => {
    const v = vaults.find((x) => !x.safe && !x.vault && !x.imported && x.owner?.toLowerCase() === address.toLowerCase());
    return v ? vaultLabel(v, (n) => t('mobile.app.vault_n', {n}), vaults) : shortAddr(address);
  };
  const phraseName = (id: string) => {
    const p = phrases.find((x) => x.id === id);
    return p ? phraseLabel(p, name) : '';
  };

  const onKey = (key: `0x${string}`) =>
    Alert.alert(shortAddr(key), key, [
      {text: t('mobile.phrases.show_key'), onPress: () => nav.navigate('ExportPrivateKey', {address: key, imported: key})},
      {
        text: t('mobile.safemode.copy'),
        onPress: () => {
          // The menu closing is the sign it ran: no toast.
          Clipboard.setString(asShown(key));
        },
      },
      {
        text: t('mobile.phrases.key_delete'),
        style: 'destructive',
        onPress: () => {
          // Nothing else on the phone holds a vault: the wallet goes with it.
          const last = !vaults.some((v) => !(v.imported && (v.signer ?? v.owner)?.toLowerCase() === key.toLowerCase()));
          Alert.alert(
            t('mobile.phrases.key_delete_title'),
            last ? t('mobile.phrases.key_delete_last_body') : t('mobile.phrases.key_delete_body', {count: signsFor(key)}),
            [
              {text: t('common.cancel'), style: 'cancel'},
              {
                text: t('mobile.phrases.delete_confirm'),
                style: 'destructive',
                onPress: async () => {
                  if (!(await unlockImported(key).catch(() => null))) return;
                  await removeKey(key);
                  showToast('success', t('mobile.phrases.key_deleted'));
                  setKeys(importedKeys());
                },
              },
            ],
          );
        },
      },
      {text: t('common.cancel'), style: 'cancel'},
    ]);
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

      {/* Each vault owner's own key, to take to another wallet. */}
      {ownerKeys.length > 0 ? (
        <SettingsGroup label={t('mobile.phrases.owner_keys')}>
          {ownerKeys.map((k, i) => (
            <Pressable
              key={k.address}
              style={({pressed}) => [styles.row, i < ownerKeys.length - 1 && styles.rowDivider, pressed && styles.pressed]}
              onPress={() => nav.navigate('ExportPrivateKey', {address: k.address, phrase: k.phrase, account: k.index})}>
              <View style={styles.text}>
                <Text style={styles.name} numberOfLines={1}>
                  {ownerName(k.address)}
                </Text>
                <Text style={[styles.sub, styles.mono]} numberOfLines={1}>
                  {phrases.length > 1 ? `${phraseName(k.phrase)} · ${shortAddr(k.address)}` : shortAddr(k.address)}
                </Text>
              </View>
              <Text style={styles.chev}>›</Text>
            </Pressable>
          ))}
        </SettingsGroup>
      ) : null}

      {keys.length > 0 ? (
        <SettingsGroup label={t('mobile.phrases.imported_keys')}>
          {keys.map((k, i) => (
            <Pressable
              key={k}
              style={({pressed}) => [styles.row, i < keys.length - 1 && styles.rowDivider, pressed && styles.pressed]}
              onPress={() => onKey(k)}>
              <View style={styles.text}>
                <Text style={[styles.name, styles.mono]} numberOfLines={1}>
                  {shortAddr(k)}
                </Text>
                <Text style={styles.sub}>{t('mobile.phrases.vaults_count', {count: signsFor(k)})}</Text>
              </View>
              <Text style={styles.chev}>›</Text>
            </Pressable>
          ))}
        </SettingsGroup>
      ) : null}

      <SettingsGroup>
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
    mono: {fontFamily: MONO},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
  });

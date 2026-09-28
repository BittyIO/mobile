import {useHeaderHeight} from '@react-navigation/elements';
import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useWallet} from '@/wallet/store';
import {revealMnemonic} from '@/wallet/keyring';
import {useLanguage, LANGUAGES, languageLabel} from '@/core/language-store';
import {useAppearance, APPEARANCES, useStyles, type Colors} from '@/theme';
import {SettingsIcon, type SettingsIconName} from '@/components/SettingsIcon';
import {useAssetManagerRow} from '@/components/useAssetManagerRow';
import {useVaultVersionRow} from '@/components/useVaultVersionRow';
import {PickerSheet} from '@/components/AssetPicker';
import {useT} from '@/i18n';

// One row of a settings group: title, an optional current value on the right, and a chevron when
// it pushes a page. Rows inside a group are separated by a hairline.
function Row({
  icon,
  title,
  sub,
  value,
  onPress,
  chevron = true,
  last,
}: {
  icon: SettingsIconName;
  title: string;
  sub?: string;
  value?: string;
  onPress: () => void;
  chevron?: boolean;
  last?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable style={[styles.row, !last && styles.rowDivider]} onPress={onPress}>
      <SettingsIcon name={icon} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
        {chevron ? <Text style={styles.chev}>›</Text> : null}
      </View>
    </Pressable>
  );
}

/**
 * Settings tab. Three groups, in this order:
 *   System — the app itself: language, appearance. The network is switched from the header.
 *   Vault  — this vault's configuration; each row pushes its page (Assets, Services, Security).
 *   Wallet — the key on this device: recovery phrase, lock, removal.
 */
export function SettingsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {language, setLanguage} = useLanguage();
  const manager = useAssetManagerRow();
  const version = useVaultVersionRow();
  const headerHeight = useHeaderHeight();
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {appearance, setAppearance} = useAppearance();
  const lock = useWallet((s) => s.lock);
  const [phrase, setPhrase] = useState<string | null>(null);

  // Language and Theme Mode use the app's own picker sheet, the one the asset and network selectors
  // use: it is part of the React tree, so it opens on the next frame, where the native action sheet
  // waits on a round trip to UIKit and a presentation animation of its own.
  const [picker, setPicker] = useState<'language' | 'appearance' | null>(null);
  const pickLanguage = () => setPicker('language');

  const pickAppearance = () => setPicker('appearance');

  const onReveal = async () => {
    try {
      const m = await revealMnemonic();
      if (m) setPhrase(m);
    } catch {
      // cancelled biometric prompt
    }
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical style={styles.flex} contentContainerStyle={[styles.body, {paddingTop: headerHeight + 8}]}>
      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('mobile.settings.system')}</Text>
        <View style={styles.group}>
          <Row icon="language" title={t('mobile.settings.language')} value={languageLabel(language)} onPress={pickLanguage} />
          <Row icon="appearance" title={t('mobile.settings.appearance')} value={t(`mobile.settings.appearance_${appearance}`)} onPress={pickAppearance} last />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('mobile.settings.vault')}</Text>
        <View style={styles.group}>
          <Row icon="gasless" title={t('mobile.settings.gas_token')} onPress={() => nav.navigate('Gasless')} />
          <Row icon="allowlist" title={t('mobile.settings.allow_list')} onPress={() => nav.navigate('VaultAssets')} />
          <Row icon="security" title={t('mobile.settings.security')} sub={t('mobile.settings.security_sub')} onPress={() => nav.navigate('VaultSecurity')} />
          <Row icon="version" title={t('mobile.settings.current_version')} value={version.value} sub={version.sub} onPress={version.onPress} chevron={version.upgradeable} last />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('mobile.settings.team')}</Text>
        <View style={styles.group}>
          <Row icon="delegation" title={t('vault.asset_manager')} value={manager.value} sub={manager.sub} onPress={manager.onPress} />
          <Row icon="payout" title={t('vault.payout_operators')} onPress={() => nav.navigate('Delegation')} last />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('mobile.settings.wallet')}</Text>
        <View style={styles.group}>
          {phrase ? (
            <View style={[styles.phraseBox, styles.rowDivider]}>
              <View style={styles.grid}>
                {phrase.split(' ').map((w, i) => (
                  <View key={`${w}-${i}`} style={styles.word}>
                    <Text style={styles.wordIdx}>{i + 1}</Text>
                    <Text style={styles.wordText}>{w}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.warn}>{t('mobile.settings.never_share')}</Text>
              <Pressable style={styles.smBtn} onPress={() => setPhrase(null)}>
                <Text style={styles.smBtnText}>{t('mobile.settings.hide')}</Text>
              </Pressable>
            </View>
          ) : (
            <Row icon="recovery" title={t('mobile.settings.recovery_phrase')} sub={t('mobile.settings.reveal_face_id')} onPress={onReveal} />
          )}
          <Row icon="lock" title={t('mobile.settings.lock')} onPress={lock} chevron={false} last />
        </View>
      </View>
      <PickerSheet
        visible={picker === 'language'}
        title={t('mobile.settings.language')}
        items={LANGUAGES.map((l) => ({key: l.code, label: l.label}))}
        selected={language}
        onSelect={(code) => setLanguage(code as (typeof LANGUAGES)[number]['code'])}
        onClose={() => setPicker(null)}
      />
      <PickerSheet
        visible={picker === 'appearance'}
        title={t('mobile.settings.appearance')}
        items={APPEARANCES.map((a) => ({key: a, label: t(`mobile.settings.appearance_${a}`)}))}
        selected={appearance}
        onSelect={(a) => setAppearance(a as (typeof APPEARANCES)[number])}
        onClose={() => setPicker(null)}
      />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  flex: {flex: 1, backgroundColor: c.bg},
  body: {flexGrow: 1, padding: 16, gap: 20, paddingBottom: 32},
  groupLabel: {color: c.subtext, fontSize: 15, fontWeight: '600', paddingHorizontal: 16, marginTop: 8, marginBottom: 6},
  section: {gap: 0},
  group: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15, paddingHorizontal: 16, gap: 12},
  rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
  rowText: {gap: 3, flexShrink: 1, flex: 1},
  rowTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
  rowSub: {color: c.subtext, fontSize: 12},
  rowRight: {flexDirection: 'row', alignItems: 'center', gap: 6},
  rowValue: {color: c.subtext, fontSize: 14},
  chev: {color: c.subtext, fontSize: 22, fontWeight: '300'},
  phraseBox: {padding: 16, gap: 10},
  smBtn: {backgroundColor: c.bg, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderColor: c.border, alignSelf: 'flex-start'},
  smBtnText: {color: c.text, fontSize: 13, fontWeight: '600'},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between'},
  word: {width: '47%', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.bg, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12},
  wordIdx: {color: c.subtext, fontSize: 12, width: 18},
  wordText: {color: c.text, fontSize: 14, fontWeight: '600'},
  warn: {color: c.danger, fontSize: 12, lineHeight: 17},
});

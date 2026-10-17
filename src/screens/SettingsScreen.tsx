import {useHeaderHeight} from '@react-navigation/elements';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import React, {useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';

import {useNetwork} from '@/core/network-store';

import {useLanguage, LANGUAGES, languageLabel} from '@/core/language-store';
import {useCurrency, useDisplayCurrency, CURRENCIES, currencyLabel, type Currency} from '@/core/currency-store';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {useAppearance, APPEARANCES, useColors, useStyles, type Colors} from '@/theme';
import {API_BASE} from '@/core/chain';
import {SettingsRow as Row, makeSettingsStyles} from '@/components/SettingsRow';
import {useVaultPicker} from '@/components/useVaultPicker';
import {useVaultVersionRow} from '@/components/useVaultVersionRow';
import {PickerSheet} from '@/components/AssetPicker';
import {GENERATIONS, VAULT_GENERATIONS, useVaultGeneration, type VaultGeneration} from '@/core/vault-generation';

import {useT} from '@/i18n';

import {openLink} from '@/core/open-link';

/**
 * Sun, moon, phone — one per appearance option, so the sheet is readable at a glance instead of
 * three lines of near-identical text. Bare strokes rather than the tinted boxes the settings rows
 * wear: those mark a destination, and these are three states of one setting.
 */
function AppearanceIcon({name, color}: {name: string; color: string}) {
  const c = {stroke: color, strokeWidth: 1.9, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={26} height={26} viewBox="0 0 24 24">
      {name === 'light' ? (
        <>
          <Circle cx={12} cy={12} r={4.2} {...c} />
          <Path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" {...c} />
        </>
      ) : name === 'dark' ? (
        <Path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" {...c} />
      ) : (
        // "System" is whatever the device says, so the device is the mark.
        <>
          <Rect x={7} y={2.5} width={10} height={19} rx={2.4} {...c} />
          <Path d="M10.8 18.6h2.4" {...c} />
        </>
      )}
    </Svg>
  );
}

/**
 * Settings tab. Three cards, in this order: the vault's own configuration (each row pushes its
 * page), then the app itself — language and appearance — then the links.
 *
 * The cards carry no headings. Three words over three obvious lists named what the rows below
 * already said, and the first one sat directly under a header that said "Me" — so the page opened
 * with two labels and no content. The gap between cards is the grouping.
 */
export function SettingsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {language, setLanguage} = useLanguage();
  const vaultPicker = useVaultPicker();
  const version = useVaultVersionRow();
  const headerHeight = useHeaderHeight();
  const tabBarHeight = useBottomTabBarHeight();
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {appearance, setAppearance} = useAppearance();
  const c = useColors();

  // Language and Theme Mode use the app's own picker sheet, the one the asset and network selectors
  // use: it is part of the React tree, so it opens on the next frame, where the native action sheet
  // waits on a round trip to UIKit and a presentation animation of its own.
  const [picker, setPicker] = useState<'language' | 'currency' | 'appearance' | 'generation' | null>(null);
  const generation = useVaultGeneration((s) => s.generation);
  const setGeneration = useVaultGeneration((s) => s.setGeneration);
  // The currency in force (explicit choice, else the language's default) and the setter. Choosing
  // a language keeps currency in step automatically until the user picks one by hand.
  const currency = useDisplayCurrency();
  const setCurrency = useCurrency((s) => s.setCurrency);
  // Which coins may pay the relay fee is one short list of switches, so it is a sheet rather than a
  // page of its own: nothing on it leads anywhere, and pushing a screen for it made a two-tap trip
  // out of a one-tap decision.
  /**
   * No pull to refresh.
   *
   * It was here for the version row, which goes stale in a way the user notices: an upgrade's own
   * re-read fires when the relayer ACCEPTS the transaction, before it is mined, so the row keeps
   * showing the version just left behind. But a settings page is a list of choices, not a feed —
   * a pull on it offers to reload a page that only ever changes when the user changes it, and the
   * one row with a lag has a spinner of its own while the upgrade is in flight.
   */
  const pickLanguage = () => setPicker('language');

  const pickAppearance = () => setPicker('appearance');

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      style={styles.flex}
      // The header's height as a content INSET, not as top padding — the same as Overview and
      // Earn. The bar is translucent and the list runs under it, so the inset is what keeps the
      // first row clear of it while still letting the content show through on a scroll.
      contentContainerStyle={[styles.body, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
      contentInset={{top: headerHeight}}
      contentOffset={{x: 0, y: -headerHeight}}
      scrollIndicatorInsets={{top: headerHeight}}
      automaticallyAdjustContentInsets={false}>
      <View style={styles.group}>
        {/* First, because which vault you are looking at decides what every row below means. It
            lived in the header for a while, where it was permanently on screen for a control
            almost nobody touches; this is where someone goes LOOKING for it. */}
        <Row icon="vault" title={t('mobile.settings.choose_vault')} value={vaultPicker.value} onPress={vaultPicker.open} />
        {/* One row for the whole subject: which coins a fee may be billed to, and the float
            that is never spent. They were two rows opening two sheets, and each left the
            other's question hanging. */}
        <Row icon="stableCoinAsGas" title={t('mobile.settings.network_fee')} onPress={() => nav.navigate('NetworkFee')} />
        {/* The vault's guardrails — how long a loosening has to wait, and how much may leave —
            behind one row. They were two, which was two ways of saying "open the security page":
            both already pushed the same screen, and splitting it only asked the user to decide
            which half they wanted before they could see either. The row now carries the page's
            own title, so the label they tap is the heading they land on. */}
        <Row icon="security" title={t('mobile.app.security')} onPress={() => nav.navigate('VaultSecurity')} />
        {/* Last, and in THIS section rather than under About: the version it shows is the
            vault's contract generation, not the app's, and tapping it upgrades the vault. That
            is a vault setting that happens to read like a credit, and it sat among the links to
            the website where nobody looking to upgrade would think to open it. */}
        {/* While the upgrade is being mined the row is inert and says so: a spinner beside
            "Confirming", no chevron, and `onPress` already refuses. Tapping again would submit
            a second upgrade to the same implementation and pay for it. */}
        {/* Which contract generation the app talks to. The two share nothing but the owner key:
            each has its own factory, so the same owner has a different vault on each. Kept beside
            the version row because it decides what that row is a version OF. */}
        <Row
          icon="settings"
          title={t('mobile.settings.vault_generation')}
          value={GENERATIONS[generation].label}
          onPress={() => setPicker('generation')}
        />
        <Row
          icon="settings"
          title={t('mobile.settings.vault_version')}
          value={version.value}
          sub={version.sub}
          right={version.confirming ? <ActivityIndicator color={c.subtext} size="small" /> : undefined}
          onPress={version.confirming ? undefined : version.onPress}
          chevron={version.upgradeable}
          last
        />
      </View>

      <View style={styles.group}>
        <Row icon="language" title={t('mobile.settings.language')} value={languageLabel(language)} onPress={pickLanguage} />
        <Row icon="currency" title={t('mobile.settings.currency')} value={currency} onPress={() => setPicker('currency')} />
        <Row icon="appearance" title={t('mobile.settings.appearance')} value={t(`mobile.settings.appearance_${appearance}`)} onPress={pickAppearance} last />
      </View>

      <View style={styles.group}>
        <Row icon="follow" title={t('mobile.settings.follow_us')} onPress={() => openLink('https://x.com/bitty_io', 'X')} />
        <Row icon="terms" title={t('mobile.settings.terms_of_use')} onPress={() => openLink(`${API_BASE}/content/terms-of-use`, t('mobile.settings.terms_of_use'))} />
        <Row icon="privacy" title={t('mobile.settings.privacy_policy')} onPress={() => openLink(`${API_BASE}/content/privacy-policy`, t('mobile.settings.privacy_policy'))} last />
      </View>

      {vaultPicker.sheet}
      <PickerSheet
        visible={picker === 'language'}
        title={t('mobile.settings.language')}
        items={LANGUAGES.map((l) => ({key: l.code, label: l.label}))}
        selected={language}
        onSelect={(code) => setLanguage(code as (typeof LANGUAGES)[number]['code'])}
        onClose={() => setPicker(null)}
      />
      <PickerSheet
        visible={picker === 'currency'}
        title={t('mobile.settings.currency')}
        items={CURRENCIES.map((x) => ({key: x.code, label: currencyLabel(x.code)}))}
        selected={currency}
        onSelect={(code) => setCurrency(code as Currency)}
        onClose={() => setPicker(null)}
      />
      <PickerSheet
        visible={picker === 'generation'}
        title={t('mobile.settings.vault_generation')}
        items={VAULT_GENERATIONS.map((g) => ({
          key: g,
          label: GENERATIONS[g].label,
          sub: t(g === 'v1.0.3' ? 'mobile.settings.vault_generation_legacy' : 'mobile.settings.vault_generation_new'),
        }))}
        selected={generation}
        onSelect={(g) => setGeneration(g as VaultGeneration)}
        onClose={() => setPicker(null)}
      />
      {/* The confirmations for the two rows that write on their own (asset manager, upgrade). */}
      {version.sheet}
      <PickerSheet
        visible={picker === 'appearance'}
        title={t('mobile.settings.appearance')}
        items={APPEARANCES.map((a) => ({
          key: a,
          label: t(`mobile.settings.appearance_${a}`),
          icon: <AppearanceIcon name={a} color={c.text} />,
        }))}
        selected={appearance}
        onSelect={(a) => setAppearance(a as (typeof APPEARANCES)[number])}
        onClose={() => setPicker(null)}
      />
    </ScrollView>
  );
}

// The row and group styles live with the row itself; these are what only this page uses.
const makeStyles = (c: Colors) => StyleSheet.create({
  ...makeSettingsStyles(c),
  flex: {flex: 1, backgroundColor: c.bg},
  // paddingBottom is set inline from the tab bar's height; see the ScrollView.
  body: {flexGrow: 1, padding: 16, gap: 20},
});

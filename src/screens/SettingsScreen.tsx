import {useTransparentHeaderInset} from '@/components/header-inset';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import React, {useState} from 'react';
import {Alert, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';

import {SAFE_ENABLED} from '@/core/features';
import {useNetwork} from '@/core/network-store';

import {useLanguage, LANGUAGES, languageLabel} from '@/core/language-store';
import {useCurrency, useDisplayCurrency, CURRENCIES, currencyLabel, type Currency} from '@/core/currency-store';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {useAppearance, APPEARANCES, useColors, useStyles, type Colors} from '@/theme';
import {SettingsRow as Row, makeSettingsStyles} from '@/components/SettingsRow';
import {useVaults} from '@/core/vault-store';
import {APP_VERSION} from '@/core/app-version';
import {fetchUpdateInfo, isNewer, promptUpdate} from '@/core/app-update';
import {LegalSheet} from '@/components/LegalSheet';
import {PickerSheet} from '@/components/AssetPicker';

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
  const {t} = useT();
  const {language, setLanguage} = useLanguage();
  const isSafeVault = useVaults((st) => !!st.vaults.find((v) => v.index === st.activeIndex)?.safe);
  const tron = useNetwork((s) => s.tron);
  const network = useNetwork((s) => s.network);
  const headerHeight = useTransparentHeaderInset();
  const tabBarHeight = useBottomTabBarHeight();
  const styles = useStyles(makeStyles);
  const {appearance, setAppearance} = useAppearance();
  const c = useColors();

  // Language and Theme Mode use the app's own picker sheet, the one the asset and network selectors
  // use: it is part of the React tree, so it opens on the next frame, where the native action sheet
  // waits on a round trip to UIKit and a presentation animation of its own.
  const [picker, setPicker] = useState<'language' | 'currency' | 'appearance' | null>(null);
  const [legal, setLegal] = useState<'terms' | 'privacy' | null>(null);
  // The currency in force (explicit choice, else US dollars) and the setter. Independent of the
  // language: changing one never changes the other.
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

  const checkForUpdate = async () => {
    const info = await fetchUpdateInfo();
    if (!info) Alert.alert(t('mobile.settings.app_version'), t('mobile.settings.update_check_failed'));
    else if (isNewer(info)) promptUpdate(info, t);
    else Alert.alert(t('mobile.settings.app_version'), t('mobile.settings.up_to_date', {version: APP_VERSION}));
  };

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
      {/* The vault's own settings. Tron has no vault — only the phrase's wallet — so nothing here applies. */}
      {tron ? null : (
      <View style={styles.group}>
        {/* Only for a vault owned by a Safe: where its owners co-sign what one of them started. */}
        {SAFE_ENABLED && isSafeVault ? (
          <Row icon="security" title={t('mobile.safe.approvals')} sub={t('mobile.safe.approvals_sub')} onPress={() => nav.navigate('SafeApprovals')} />
        ) : null}
        {/* One row for the whole subject: which coins a fee may be billed to, and the float
            that is never spent. They were two rows opening two sheets, and each left the
            other's question hanging. */}
        <Row icon="stableCoinAsGas" title={t('mobile.settings.network_fee')} onPress={() => nav.navigate('NetworkFee')} />
        {/* The vault's guardrails — how long a loosening has to wait, and how much may leave —
            behind one row. They were two, which was two ways of saying "open the security page":
            both already pushed the same screen, and splitting it only asked the user to decide
            which half they wanted before they could see either. The row now carries the page's
            own title, so the label they tap is the heading they land on. */}
        {/* The vault's version lives under Security › Upgrade now, beside the switches that keep it
            current. */}
        <Row icon="security" title={t('mobile.app.security')} onPress={() => nav.navigate('VaultSecurity')} last />
      </View>
      )}

      <View style={styles.group}>
        <Row icon="language" title={t('mobile.settings.language')} value={languageLabel(language)} onPress={pickLanguage} />
        <Row icon="currency" title={t('mobile.settings.currency')} value={currency} onPress={() => setPicker('currency')} />
        <Row icon="appearance" title={t('mobile.settings.appearance')} value={t(`mobile.settings.appearance_${appearance}`)} onPress={pickAppearance} />
        {/* Which nodes this phone reads the chain from. With the app's settings, not the vault's:
            it is this phone's, the same for every vault, and needs no signature. */}
        <Row icon="network" title={t('mobile.rpc.title')} onPress={() => nav.navigate('RpcNetwork', {network: tron ?? network})} />
        {/* Which build this is — the first thing asked when something looks wrong — and a tap to ask
            whether a newer one is out (see {fetchUpdateInfo}). */}
        <Row icon="settings" title={t('mobile.settings.app_version')} value={APP_VERSION} onPress={checkForUpdate} last />
      </View>

      <View style={styles.group}>
        <Row icon="follow" title={t('mobile.settings.follow_us')} onPress={() => openLink('https://x.com/bitty_io', 'X')} />
        {/* Both ship with the app and open in a sheet, offline, in this build's version. */}
        <Row icon="terms" title={t('mobile.settings.terms_of_use')} onPress={() => setLegal('terms')} />
        <Row icon="privacy" title={t('mobile.settings.privacy_policy')} onPress={() => setLegal('privacy')} last />
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
        visible={picker === 'currency'}
        title={t('mobile.settings.currency')}
        items={CURRENCIES.map((x) => ({key: x.code, label: currencyLabel(x.code)}))}
        selected={currency}
        onSelect={(code) => setCurrency(code as Currency)}
        onClose={() => setPicker(null)}
      />
      {/* The confirmations for the two rows that write on their own (asset manager, upgrade). */}
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
      <LegalSheet doc={legal} onClose={() => setLegal(null)} />
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

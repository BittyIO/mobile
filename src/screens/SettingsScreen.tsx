import {useHeaderHeight} from '@react-navigation/elements';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Linking, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {getGaslessConfig, type GaslessConfig} from '@/vault/gasless';
import {isActivated} from '@/vault/activate';

import {TokenIcon} from '@/components/TokenIcon';
import {useLanguage, LANGUAGES, languageLabel} from '@/core/language-store';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {useAppearance, APPEARANCES, useColors, useStyles, type Colors} from '@/theme';
import {API_BASE} from '@/core/chain';
import {SettingsRow as Row, makeSettingsStyles} from '@/components/SettingsRow';
import {useVaultPicker} from '@/components/useVaultPicker';
import {useVaultVersionRow} from '@/components/useVaultVersionRow';
import {PickerSheet} from '@/components/AssetPicker';
import {Sheet} from '@/components/Sheet';
import {GaslessCoins} from '@/components/GaslessCoins';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';

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
 * The coins that may currently pay the relay fee, as their own marks.
 *
 * The row said "Network fee token" and nothing else, so the only way to learn which coins were on
 * was to open the sheet. The answer is two or three logos wide, which is exactly the kind of thing
 * a settings row's right-hand side is for.
 *
 * An empty allowlist means ANY coin, which is the default — so that case shows them all rather
 * than nothing, because that is what it means. Nothing is shown until the config is read: a row
 * that guessed and then corrected itself would be worse than one that waits a moment.
 *
 * A vault that has not been activated yet has no config to read, and `getGaslessConfig` returns
 * null for it exactly as it does for a failed read. That is NOT "no fee coin": the vault opens on
 * the system defaults — any stablecoin — and one of these coins is what PAYS for the activation,
 * so this is the moment the row most needs to name them. Hence the bytecode check: no code at the
 * address means the defaults, and only an unreadable config on a vault that does exist stays
 * blank.
 */
function FeeCoinMarks({nonce}: {nonce: number}) {
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const catalog = useAssetCatalog(network);
  const stablecoins = useMemo(() => catalog.filter((a) => a.kind === 'stable'), [catalog]);
  const [cfg, setCfg] = useState<GaslessConfig | null>(null);
  const [deployed, setDeployed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!vault) return;
    let live = true;
    setCfg(null);
    setDeployed(null);
    getGaslessConfig(vault, network)
      .then((c) => live && setCfg(c))
      .catch(() => live && setCfg(null));
    isActivated(vault, network)
      .then((d) => live && setDeployed(d))
      .catch(() => live && setDeployed(true));
    return () => {
      live = false;
    };
  }, [vault, network, nonce]);

  // Before activation the allowlist is empty by definition, which already means "all of them".
  const preActivation = !cfg && deployed === false;
  if (!cfg && !preActivation) return null;
  const on =
    cfg && cfg.stableCoins.length
      ? stablecoins.filter((a) => cfg.stableCoins.some((coin) => coin.toLowerCase() === a.address.toLowerCase()))
      : stablecoins;
  if (on.length === 0) return null;
  return (
    <View style={styles.feeCoins}>
      {on.map((a) => (
        <TokenIcon key={a.address} symbol={a.symbol} size={20} />
      ))}
    </View>
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
  const [picker, setPicker] = useState<'language' | 'appearance' | null>(null);
  // Which coins may pay the relay fee is one short list of switches, so it is a sheet rather than a
  // page of its own: nothing on it leads anywhere, and pushing a screen for it made a two-tap trip
  // out of a one-tap decision.
  const [feeCoins, setFeeCoins] = useState(false);
  // Closing the sheet is the only moment the answer can have changed, so that is when it is re-read.
  const [feeCoinsNonce, setFeeCoinsNonce] = useState(0);
  /**
   * Pull to refresh.
   *
   * Everything on this page is a chain read, and the one that goes stale in a way the user
   * notices is the version: an upgrade's own re-read fires when the relayer ACCEPTS the
   * transaction, which is before it is mined, so the row keeps showing the version just left
   * behind. The fee-coin marks have the same shape of problem after the sheet writes a new
   * allowlist, so the pull re-runs both.
   */
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    version.reload();
    setFeeCoinsNonce((n) => n + 1);
    // The reads are fired, not awaited — each row swaps itself in when its own answer lands.
    // Holding the spinner for a beat is what makes the gesture feel like it did something.
    setTimeout(() => setRefreshing(false), 600);
  };
  const pickLanguage = () => setPicker('language');

  const pickAppearance = () => setPicker('appearance');

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      style={styles.flex}
      // The header's height as a content INSET, not as top padding — the same as Overview and
      // Earn. The spinner is positioned from `contentInset.top` on iOS, so with the header's
      // height baked into the padding instead it appeared at the very top of the scroll view,
      // underneath the translucent bar, and the pull looked like it did nothing.
      // `progressViewOffset` does not help: RefreshControl only honours it on Android.
      contentContainerStyle={[styles.body, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
      contentInset={{top: headerHeight}}
      contentOffset={{x: 0, y: -headerHeight}}
      scrollIndicatorInsets={{top: headerHeight}}
      automaticallyAdjustContentInsets={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text} colors={[c.accent]} />
      }>
      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('mobile.settings.vault')}</Text>
        <View style={styles.group}>
          {/* First, because which vault you are looking at decides what every row below means. It
              lived in the header for a while, where it was permanently on screen for a control
              almost nobody touches; this is where someone goes LOOKING for it. */}
          <Row icon="vault" title={t('mobile.settings.choose_vault')} value={vaultPicker.value} onPress={vaultPicker.open} />
          <Row
            icon="gasless"
            title={t('mobile.settings.gas_token')}
            onPress={() => setFeeCoins(true)}
            chevron={false}
            right={<FeeCoinMarks nonce={feeCoinsNonce} />}
          />
          <Row icon="allowlist" title={t('mobile.settings.allow_list')} onPress={() => nav.navigate('VaultAssets')} />
          {/* The vault's guardrails — how long a loosening has to wait, and how much may leave —
              behind one row. They were two, which was two ways of saying "open the security page":
              both already pushed the same screen, and splitting it only asked the user to decide
              which half they wanted before they could see either. The row now carries the page's
              own title, so the label they tap is the heading they land on. */}
          <Row icon="security" title={t('mobile.app.security')} onPress={() => nav.navigate('VaultSecurity')} />
          {/* Who else may act for the vault. A section of its own for two rows read as a leftover
              beside the group that now holds everything else about the vault.
              
              It wears the asset manager's own mark — lucide Users, the plural of the single
              figure on Choose vault above it. The card glyph it had belongs to payouts, which is
              the SECOND row on the page; the row should look like what the page leads with. */}
          <Row icon="delegation" title={t('mobile.settings.team')} onPress={() => nav.navigate('VaultTeam')} />
          {/* Last, and in THIS section rather than under About: the version it shows is the
              vault's contract generation, not the app's, and tapping it upgrades the vault. That
              is a vault setting that happens to read like a credit, and it sat among the links to
              the website where nobody looking to upgrade would think to open it. */}
          {/* While the upgrade is being mined the row is inert and says so: a spinner beside
              "Confirming", no chevron, and `onPress` already refuses. Tapping again would submit
              a second upgrade to the same implementation and pay for it. */}
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
      </View>

      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('mobile.settings.system')}</Text>
        <View style={styles.group}>
          <Row icon="language" title={t('mobile.settings.language')} value={languageLabel(language)} onPress={pickLanguage} />
          <Row icon="appearance" title={t('mobile.settings.appearance')} value={t(`mobile.settings.appearance_${appearance}`)} onPress={pickAppearance} last />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('mobile.settings.about_us')}</Text>
        <View style={styles.group}>
          <Row icon="follow" title={t('mobile.settings.follow_us')} onPress={() => Linking.openURL('https://x.com/bitty_io')} />
          <Row icon="terms" title={t('mobile.settings.terms_of_use')} onPress={() => Linking.openURL(`${API_BASE}/content/terms-of-use`)} />
          <Row icon="privacy" title={t('mobile.settings.privacy_policy')} onPress={() => Linking.openURL(`${API_BASE}/content/privacy-policy`)} last />
        </View>
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
      {/* The confirmations for the two rows that write on their own (asset manager, upgrade). */}
      {version.sheet}
      <Sheet visible={feeCoins} title={t('mobile.settings.gas_token')} onClose={() => setFeeCoins(false)}>
        <GaslessCoins />
      </Sheet>
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
  feeCoins: {flexDirection: 'row', alignItems: 'center', gap: 4},
});

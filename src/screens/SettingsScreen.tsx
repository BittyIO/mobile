import {useHeaderHeight} from '@react-navigation/elements';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import React, {useEffect, useMemo, useState} from 'react';
import {Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {getGaslessConfig, type GaslessConfig} from '@/vault/gasless';
import {isActivated} from '@/vault/activate';
import {ASSETS} from '@/core/assets';
import {TokenIcon} from '@/components/TokenIcon';
import {revealMnemonic} from '@/wallet/keyring';
import {useRevealGuard} from '@/core/device-security';
import {useLanguage, LANGUAGES, languageLabel} from '@/core/language-store';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {useAppearance, APPEARANCES, useColors, useStyles, type Colors} from '@/theme';
import {useDefiDetails} from '@/core/defi-details';
import {API_BASE} from '@/core/chain';
import {SettingsIcon, type SettingsIconName} from '@/components/SettingsIcon';
import {useAssetManagerRow} from '@/components/useAssetManagerRow';
import {useVaultPicker} from '@/components/useVaultPicker';
import {useVaultVersionRow} from '@/components/useVaultVersionRow';
import {PickerSheet} from '@/components/AssetPicker';
import {Sheet} from '@/components/Sheet';
import {GaslessCoins} from '@/components/GaslessCoins';
import {useT} from '@/i18n';

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
  toggle,
  right,
}: {
  icon: SettingsIconName;
  title: string;
  sub?: string;
  value?: string;
  onPress?: () => void;
  chevron?: boolean;
  last?: boolean;
  /** A row that flips a local setting in place, rather than pushing or opening a sheet. */
  toggle?: {value: boolean; onValueChange: (v: boolean) => void};
  /** Where a row's current answer is a set of things rather than a word — icons, marks. */
  right?: React.ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const body = (
    <>
      <SettingsIcon name={icon} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        {toggle ? (
          <Switch value={toggle.value} onValueChange={toggle.onValueChange} style={styles.rowSwitch} />
        ) : (
          <>
            {right ?? null}
            {value ? <Text style={styles.rowValue}>{value}</Text> : null}
            {chevron ? <Text style={styles.chev}>›</Text> : null}
          </>
        )}
      </View>
    </>
  );
  // A switch row has nothing to press: the control is the whole interaction, and a Pressable
  // wrapping it would fight the gesture.
  if (toggle) return <View style={[styles.row, !last && styles.rowDivider]}>{body}</View>;
  return (
    <Pressable style={[styles.row, !last && styles.rowDivider]} onPress={onPress}>
      {body}
    </Pressable>
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
  const stablecoins = useMemo(() => ASSETS[network].filter((a) => a.kind === 'stable'), [network]);
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
  const manager = useAssetManagerRow();
  const vaultPicker = useVaultPicker();
  const version = useVaultVersionRow();
  const headerHeight = useHeaderHeight();
  const tabBarHeight = useBottomTabBarHeight();
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {appearance, setAppearance} = useAppearance();
  const {show: defiDetails, setShow: setDefiDetails} = useDefiDetails();
  const c = useColors();
  const lock = useWallet((s) => s.lock);
  const [phrase, setPhrase] = useState<string | null>(null);
  // Hide the phrase while the screen is recorded, and pull it + warn if a screenshot is taken.
  const reveal = useRevealGuard();
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
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical style={styles.flex} contentContainerStyle={[styles.body, {paddingTop: headerHeight + 8, paddingBottom: tabBarHeight + 16}]}>
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
          {/* First, because which vault you are looking at decides what every row below means. It
              lived in the header for a while, where it was permanently on screen for a control
              almost nobody touches; this is where someone goes LOOKING for it. */}
          <Row icon="user" title={t('mobile.settings.choose_vault')} value={vaultPicker.value} onPress={vaultPicker.open} />
          <Row
            icon="gasless"
            title={t('mobile.settings.gas_token')}
            onPress={() => setFeeCoins(true)}
            chevron={false}
            right={<FeeCoinMarks nonce={feeCoinsNonce} />}
          />
          <Row icon="allowlist" title={t('mobile.settings.allow_list')} onPress={() => nav.navigate('VaultAssets')} />
          {/* The two halves of the vault's guardrails, each its own row: how long a loosening has
              to wait, and how much may leave. Both open the same page — it holds both — but the
              row that got you there says which one you came for. */}
          <Row icon="timelock" title={t('mobile.settings.timelock')} onPress={() => nav.navigate('VaultSecurity')} />
          <Row icon="limits" title={t('mobile.settings.limits')} onPress={() => nav.navigate('VaultSecurity')} />
          {/* Whether the vault names the protocols it routes through, on Earn and in history. */}
          <Row
            icon="protocols"
            title={t('mobile.settings.defi_details')}
            toggle={{value: defiDetails, onValueChange: setDefiDetails}}
            last
          />
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
        <Text style={styles.groupLabel}>{t('mobile.settings.about_us')}</Text>
        <View style={styles.group}>
          <Row icon="version" title={t('mobile.settings.current_version')} value={version.value} sub={version.sub} onPress={version.onPress} chevron={version.upgradeable} />
          <Row icon="follow" title={t('mobile.settings.follow_us')} onPress={() => Linking.openURL('https://x.com/bitty_io')} />
          <Row icon="terms" title={t('mobile.settings.terms_of_use')} onPress={() => Linking.openURL(`${API_BASE}/content/terms-of-use`)} />
          <Row icon="privacy" title={t('mobile.settings.privacy_policy')} onPress={() => Linking.openURL(`${API_BASE}/content/privacy-policy`)} last />
        </View>
      </View>

      <View style={styles.section}>
        {/* Recovery phrase and Lock Vault — what the section holds is the key, not the wallet. */}
        <Text style={styles.groupLabel}>{t('mobile.settings.security')}</Text>
        <View style={styles.group}>
          {phrase ? (
            <View style={[styles.phraseBox, styles.rowDivider]}>
              {reveal.captured ? (
                <Text style={styles.warn}>
                  Hidden while your screen is being recorded or mirrored. Stop the recording to view
                  your recovery phrase.
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
      {manager.sheet}
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

const makeStyles = (c: Colors) => StyleSheet.create({
  flex: {flex: 1, backgroundColor: c.bg},
  // paddingBottom is set inline from the tab bar's height; see the ScrollView.
  body: {flexGrow: 1, padding: 16, gap: 20},
  groupLabel: {color: c.subtext, fontSize: 15, fontWeight: '600', paddingHorizontal: 16, marginTop: 8, marginBottom: 6},
  section: {gap: 0},
  group: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15, paddingHorizontal: 16, gap: 12},
  rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
  // A chevron's glyph sits a few points inside its box; a switch fills its own exactly, so
  // without this it looks nearer the edge than every other row in the group.
  feeCoins: {flexDirection: 'row', alignItems: 'center', gap: 4},
  rowSwitch: {marginRight: 10},
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

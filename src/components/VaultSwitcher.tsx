import React, {useEffect, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useNavigationState, type NavigationState, type PartialState} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Clipboard from '@react-native-clipboard/clipboard';
import Svg, {Path} from 'react-native-svg';
import type {RootStackParamList} from '@/App';
import {useVaults, vaultLabel} from '@/core/vault-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useNetwork} from '@/core/network-store';
import {asShown} from '@/core/format';
import {useT} from '@/i18n';
import {MONO, useColors} from '@/theme';
import {CHROME_SCALE} from '@/core/text-scale';

/** 0x123456...123456: the prefix and six characters, then the last six (T1234567...123456 on Tron). */
const shortAddress = (a: string) => (a.length > 16 ? `${a.slice(0, a.startsWith('0x') ? 8 : 7)}...${a.slice(-6)}` : a);

type NavState = NavigationState | PartialState<NavigationState>;

/** The route in front, through any nested navigators (Main › its tabs on iOS's native bar). */
function focusedRoute(state: NavState | undefined): string | undefined {
  if (!state?.routes?.length) return undefined;
  const route = state.routes[state.index ?? 0];
  if (route.name === 'Main') return route.state ? focusedRoute(route.state as NavState) : 'Overview';
  return route.name;
}

/**
 * The vault in front, in every tab's left-hand corner: its name, opening the Vaults page, and
 * beside it its address on this network (T… on Tron), shortened, which copies the whole of it.
 * The copy says so in place: its icon turns into a check for a moment, as {CopyAddress} does, rather
 * than a toast over the page.
 *
 * Opposite the chain in the right-hand corner ({NetworkSwitcher}), because the two together say
 * whose money the page is showing: which vault, on which chain.
 *
 * Two separate controls, not one: a tap on the name chooses a vault, a tap on the address copies
 * it. The name gives way first when the bar is short — it is cut at its end, and the address,
 * the part a user checks character by character, stays whole.
 */
export function VaultSwitcher({stack = false}: {stack?: boolean} = {}) {
  const {t} = useT();
  const c = useColors();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  // The Overview shows the address under its total, so the bar leaves it out there.
  const onOverview = useNavigationState((s) => focusedRoute(s as NavState) === 'Overview');
  const current = useVaults((s) => s.vaults.find((v) => v.index === s.activeIndex) ?? s.vaults[0]);
  if (!current) return null;
  const label = vaultLabel(current, (n) => t('mobile.app.vault_n', {n}));
  const copy = () => {
    if (!vault) return;
    Clipboard.setString(asShown(vault));
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <View style={[styles.row, stack ? styles.stack : styles.pill]}>
      <Pressable
        onPress={() => nav.navigate('VaultList')}
        style={styles.nameBtn}
        hitSlop={{top: 12, bottom: 12, left: 12, right: 4}}
        accessibilityRole="button"
        accessibilityLabel={`${t('mobile.settings.choose_vault')}: ${label}`}>
        <Text style={[styles.name, {color: c.text}]} numberOfLines={1} maxFontSizeMultiplier={CHROME_SCALE}>
          {label}
        </Text>
      </Pressable>
      {vault && !onOverview ? (
        <Pressable
          onPress={copy}
          style={styles.addrBtn}
          hitSlop={{top: 12, bottom: 12, left: 4, right: 8}}
          accessibilityRole="button"
          accessibilityLabel={copied ? t('common.copied') : t('common.copy')}>
          <Text style={[styles.addr, {color: c.subtext}]} numberOfLines={1} maxFontSizeMultiplier={CHROME_SCALE}>
            {shortAddress(asShown(vault))}
          </Text>
          <Svg width={12} height={12} viewBox="0 0 24 24">
            {copied ? (
              <Path d="M20 6 9 17l-5-5" fill="none" stroke={c.success} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <>
                <Path d="M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z" fill="none" stroke={c.subtext} strokeWidth={2} />
                <Path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" fill="none" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" />
              </>
            )}
          </Svg>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', gap: 8},
  // The bar's own inset, on the side the control sits — the mirror of NetworkSwitcher's.
  pill: {marginLeft: 16, maxWidth: 300},
  // In the native bar (iOS, see App.tsx): the bar keeps its own inset, so none is added here.
  stack: {maxWidth: 300},
  nameBtn: {flexShrink: 1},
  name: {fontSize: 17, fontWeight: '700'},
  addrBtn: {flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0},
  addr: {fontSize: 12, fontFamily: MONO},
});

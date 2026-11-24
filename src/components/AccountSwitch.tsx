import React from 'react';
import {Alert, Pressable, StyleSheet, Text} from 'react-native';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {NATIVE, type Network} from '@/core/chain';
import {toggleAccount, useActiveAccount} from '@/core/account-mode';
import {getFlag, setFlag} from '@/core/prefs';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/** Shown once per phone, the first time the wallet is put in front: what it is, and what it is not. */
const INTRO_SEEN = 'account.wallet_intro_seen';

/** lucide "wallet". */
export function WalletIcon({color, size = 16}: {color: string; size?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <Path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </Svg>
  );
}

/** lucide "vault": a safe door with its dial. */
export function VaultIcon({color, size = 16}: {color: string; size?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={3} y={3} width={18} height={18} rx={2} />
      <Circle cx={12} cy={12} r={3} />
      <Path d="M7.5 7.5h.01M16.5 7.5h.01M7.5 16.5h.01M16.5 16.5h.01M12 9V7.5M12 16.5V15" />
    </Svg>
  );
}

/** lucide "shield-check": the smart wallet (the vault), whose guards check every move. */
export function SmartWalletIcon({color, size = 16}: {color: string; size?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <Path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

/**
 * The vault / wallet switch, at the end of the Overview's address line.
 *
 * It names the account a tap switches TO, with its icon: the general wallet while the smart one (the
 * vault) is in front, the smart one while the general wallet is. Entries with no wallet of their own (a Safe's
 * vault, a vault received by transfer) get no switch at all.
 */
export function AccountSwitch({network}: {network: Network}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const account = useActiveAccount(network);
  if (!account.canSwitch) return null;
  const wallet = account.kind === 'wallet';
  const onPress = () => {
    const next = toggleAccount(network);
    if (next === 'wallet' && !getFlag(INTRO_SEEN)) {
      setFlag(INTRO_SEEN, true);
      Alert.alert(t('mobile.account.intro_title'), t('mobile.account.intro_body', {coin: NATIVE[network].symbol}), [{text: t('mobile.account.intro_ok')}]);
    }
  };
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={styles.pill}
      accessibilityRole="button"
      accessibilityLabel={t(wallet ? 'mobile.account.to_vault' : 'mobile.account.to_wallet')}>
      {wallet ? <SmartWalletIcon color={c.accent} size={15} /> : <WalletIcon color={c.accent} size={15} />}
      <Text style={styles.label} numberOfLines={1}>
        {t(wallet ? 'mobile.account.vault' : 'mobile.account.wallet')}
      </Text>
    </Pressable>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    pill: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, backgroundColor: c.accentSoft, flexShrink: 0},
    label: {color: c.accent, fontSize: 13, fontWeight: '700'},
  });

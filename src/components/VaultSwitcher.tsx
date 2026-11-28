import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useVaults, vaultLabel} from '@/core/vault-store';
import {useNetwork} from '@/core/network-store';
import {useWalletMode, walletNumber} from '@/core/account-mode';
import {useT} from '@/i18n';
import {useColors} from '@/theme';
import {CHROME_SCALE} from '@/core/text-scale';
import {SmartWalletIcon, WalletIcon} from './AccountSwitch';
import {GuardShield} from './GuardShield';
import {vaultAddressOf} from '@/core/active-vault';
import {useGuardLevel} from '@/vault/guard';

/**
 * The vault in front, in every tab's left-hand corner: its name, opening the Vaults page. In wallet
 * mode, the wallet's: "Wallet 1", "Wallet 2" (core/account-mode `walletNumber`).
 *
 * Opposite the chain in the right-hand corner ({NetworkSwitcher}), because the two together say
 * whose money the page is showing: which vault, on which chain. The address is not here: it sits
 * under the total on the Overview, beside the vault / wallet switch, and is copied from there.
 */
export function VaultSwitcher({stack = false}: {stack?: boolean} = {}) {
  const {t} = useT();
  const c = useColors();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const wallet = useWalletMode(network);
  const current = useVaults((s) => s.vaults.find((v) => v.index === s.activeIndex) ?? s.vaults[0]);
  // The guard wallet's mark is its Guard level's shield; the plain shield until that is read.
  const level = useGuardLevel(wallet ? null : vaultAddressOf(current, network), network);
  if (!current) return null;
  // Both kinds are named "Wallet N" here, the name alone: the switch on Overview says which kind is in front.
  const label = wallet ? t('mobile.account.wallet_n', {n: walletNumber(current)}) : vaultLabel(current, (n) => t('mobile.account.wallet_n', {n}));
  return (
    <View style={[styles.row, stack ? styles.stack : styles.pill]}>
      <Pressable
        onPress={() => nav.navigate(wallet ? 'WalletList' : 'VaultList')}
        style={[styles.row, styles.nameBtn]}
        hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}
        accessibilityRole="button"
        accessibilityLabel={`${t(wallet ? 'mobile.account.choose_wallet' : 'mobile.settings.choose_vault')}: ${label}`}>
        {/* The mark says which kind is in front; it is part of the name's button (the list), not a
            way to Guard — Overview's Guard is that. */}
        {wallet ? (
          <WalletIcon color={c.accent} size={26} />
        ) : level != null ? (
          <GuardShield level={level} size={28} />
        ) : (
          <SmartWalletIcon color={c.accent} size={26} />
        )}
        <Text style={[styles.name, {color: c.text}]} numberOfLines={1} maxFontSizeMultiplier={CHROME_SCALE}>
          {label}
        </Text>
      </Pressable>
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
});

import React, {useState} from 'react';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import Svg, {Path} from 'react-native-svg';
import Clipboard from '@react-native-clipboard/clipboard';
import {unlockRoot} from '@/wallet/keyring';
import {addTronWallet, renameTronWallet, selectTronWallet, tronWalletLabel, useTronWallet, type TronWalletRef} from '@/tron/store';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {showToast} from '@/components/Toast';
import {useT} from '@/i18n';
import {asShown, wrappableAddress} from '@/core/format';
import {useColors, useStyles, type Colors, MONO} from '@/theme';

/**
 * The Tron wallets on this phone, opened from the top-left corner with Tron in front — the Vaults
 * page's list for the Tron side. Each is an account of the phrase (see tron/store), so adding one
 * writes nothing new down: Face ID reads the phrase, the next account is derived, and it is put in
 * front.
 *
 * Choosing one puts it in front and goes back. The pencil renames it on this phone; a long press
 * copies its address, as every address in the app does.
 */
export function TronWalletListScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const wallets = useTronWallet((s) => s.wallets);
  const activeIndex = useTronWallet((s) => s.activeIndex);
  const [busy, setBusy] = useState(false);
  const label = (w: TronWalletRef) => tronWalletLabel(w, (n) => t('mobile.tron.wallet_n', {n}));

  const choose = (w: TronWalletRef) => {
    selectTronWallet(w.index);
    nav.goBack();
  };

  const copy = (address: string) => {
    Clipboard.setString(asShown(address));
    showToast('success', t('common.copied'), asShown(address), 1500);
  };

  const rename = (w: TronWalletRef) =>
    Alert.prompt(
      t('mobile.payments.edit_name'),
      w.address,
      [
        {text: t('common.cancel'), style: 'cancel'},
        {text: t('vault.save'), onPress: (name?: string) => renameTronWallet(w.index, name ?? '')},
      ],
      'plain-text',
      w.name,
    );

  const onAdd = async () => {
    setBusy(true);
    try {
      const root = await unlockRoot();
      if (!root) return;
      addTronWallet(root);
      nav.goBack();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <View style={styles.group}>
        {wallets.map((w, i) => (
          <Pressable
            key={w.index}
            style={({pressed}) => [styles.walletRow, i < wallets.length - 1 && styles.rowDivider, pressed && styles.pressed]}
            onPress={() => choose(w)}
            onLongPress={() => copy(w.address)}>
            <View style={styles.walletText}>
              <View style={styles.nameLine}>
                <Text style={styles.name} numberOfLines={1}>
                  {label(w)}
                </Text>
                <Pressable hitSlop={10} onPress={() => rename(w)} accessibilityRole="button" accessibilityLabel={t('vault.edit')}>
                  <Svg width={14} height={14} viewBox="0 0 24 24">
                    <Path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </Svg>
                </Pressable>
                {w.index === activeIndex ? <Text style={[styles.check, styles.checkEnd]}>✓</Text> : null}
              </View>
              {/* Full, wrapping rather than cut: wallets are told apart by their address. */}
              <Text style={styles.addr} numberOfLines={2}>
                {wrappableAddress(w.address)}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>

      <SettingsGroup>
        <Pressable style={styles.row} onPress={onAdd} disabled={busy}>
          <Text style={styles.link}>{`＋ ${t('mobile.tron.add_wallet')}`}</Text>
          {busy ? <ActivityIndicator color={c.subtext} /> : null}
        </Pressable>
      </SettingsGroup>
    </ScrollView>
  );
}

// The Vaults page's rows (VaultListScreen), for the parts this page draws.
const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 20, paddingBottom: 32},
    walletRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 56},
    walletText: {flex: 1, gap: 3},
    nameLine: {flexDirection: 'row', alignItems: 'center', gap: 6},
    name: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    addr: {color: c.subtext, fontSize: 13, fontFamily: MONO, fontWeight: '700', lineHeight: 18},
    checkEnd: {marginLeft: 'auto'},
    pressed: {opacity: 0.6},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
  });

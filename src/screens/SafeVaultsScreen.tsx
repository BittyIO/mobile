import React from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Clipboard from '@react-native-clipboard/clipboard';
import type {RootStackParamList} from '@/App';
import {useVaults, vaultLabel, type VaultRef} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';
import {useNetwork} from '@/core/network-store';
import {useWallet} from '@/wallet/store';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {asShown, wrappableAddress} from '@/core/format';
import {useT} from '@/i18n';
import {useStyles, type Colors, MONO} from '@/theme';
import {CopyButton} from '@/components/CopyButton';

/** An address shortened to its first and last six: 0x111111…000000. */
const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/**
 * Choose vault › ⋯ › Safe multi-sig: the Safe vaults on this phone, kept apart from the vaults its
 * own keys hold.
 *
 * Each Safe is listed as the owner it is, under its address, with its vault and the key on this
 * phone that signs for it (one of the Safe's owners). Tapping one puts it in front, as choosing a
 * vault does; a long press copies its address or takes it off the phone. Adding one — importing the
 * owner's private key, then entering the Safe's address — is the Add a Safe vault page. While a Safe
 * vault is in front, what is waiting for its other owners to sign is a row away.
 */
export function SafeVaultsScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const vaults = useVaults((s) => s.vaults);
  const activeIndex = useVaults((s) => s.activeIndex);
  // Restorable, as on the choose-vault page: back from its Removed vaults page.
  const remove = useVaults((s) => s.hide);
  const selectVault = useWallet((s) => s.selectVault);
  const safes = vaults.filter((v) => v.safe && !v.hidden);
  const label = (n: number) => t('mobile.app.vault_n', {n});

  // The menu's Copy: the menu closing is the sign it ran, so no toast.
  const copy = (address: string) => Clipboard.setString(asShown(address));

  const choose = (v: VaultRef) => {
    // Never changes the network; any vault can be chosen on any network.
    selectVault(v.index);
    nav.popToTop();
  };

  const manage = (v: VaultRef) => {
    const address = vaultAddressOf(v, network) ?? v.vault ?? v.safe!;
    Alert.alert(vaultLabel(v, label, vaults), address, [
      {text: t('mobile.safemode.owners_row'), onPress: () => nav.navigate('ManageMultisig', {safe: v.safe!, payer: v.signer})},
      {text: t('mobile.safemode.copy'), onPress: () => copy(address)},
      {
        text: t('mobile.safemode.remove'),
        style: 'destructive',
        onPress: () =>
          Alert.alert(t('mobile.safemode.remove_title'), t('mobile.safemode.remove_body'), [
            {text: t('common.cancel'), style: 'cancel'},
            {text: t('mobile.phrases.delete_confirm'), style: 'destructive', onPress: () => remove(v.index)},
          ]),
      },
      {text: t('common.cancel'), style: 'cancel'},
    ]);
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      {safes.length === 0 ? <Text style={styles.empty}>{t('mobile.safemode.empty')}</Text> : null}
      {safes.map((v) => {
        const address = vaultAddressOf(v, network) ?? v.vault ?? null;
        const on = v.index === activeIndex;
        return (
          <View key={v.index} style={styles.section}>
            {/* The Safe is the vault's owner: its address heads the group, with its copy button. */}
            <View style={styles.groupLabelLine}>
              <Text style={[styles.groupLabel, styles.groupLabelInline, styles.mono]}>{t('mobile.safemode.safe_header', {address: shortAddr(v.safe!)})}</Text>
              <CopyButton address={v.safe!} size={13} />
            </View>
            <View style={styles.group}>
              <Pressable style={({pressed}) => [styles.vaultRow, pressed && styles.pressed]} onPress={() => choose(v)} onLongPress={() => manage(v)}>
                <View style={styles.vaultText}>
                  <View style={styles.nameLine}>
                    <Text style={styles.name} numberOfLines={1}>
                      {vaultLabel(v, label, vaults)}
                    </Text>
                    {on ? <Text style={[styles.check, styles.checkEnd]}>✓</Text> : null}
                  </View>
                  {address ? (
                    <Text style={styles.addr} numberOfLines={2}>
                      {wrappableAddress(address)}
                    </Text>
                  ) : null}
                  {v.signer ? <Text style={styles.sub}>{t('mobile.safemode.signed_with', {address: shortAddr(v.signer)})}</Text> : null}
                </View>
              </Pressable>
              {/* Its owners and threshold: add, remove, change — signed on this phone. */}
              <Pressable
                style={({pressed}) => [styles.row, styles.ownersRow, pressed && styles.pressed]}
                onPress={() => nav.navigate('ManageMultisig', {safe: v.safe!, payer: v.signer})}>
                <Text style={styles.link}>{t('mobile.safemode.owners_row')}</Text>
                <Text style={styles.chev}>›</Text>
              </Pressable>
            </View>
          </View>
        );
      })}

      {/* Importing the Safe owner's key and entering the Safe's address: one page, two steps. */}
      <SettingsGroup footer={t('mobile.safe.add_safe_footer')}>
        <Pressable style={styles.row} onPress={() => nav.navigate('AddSafeVault')}>
          <Text style={styles.link}>{`＋ ${t('mobile.safe.add_safe_vault')}`}</Text>
          <Text style={styles.chev}>›</Text>
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
    ownersRow: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    empty: {color: c.subtext, fontSize: 14, textAlign: 'center', marginTop: 8},
    mono: {fontSize: 13, fontFamily: MONO, fontWeight: '400'},
    vaultRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 56},
    vaultText: {flex: 1, gap: 3},
    nameLine: {flexDirection: 'row', alignItems: 'center', gap: 6},
    name: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    checkEnd: {marginLeft: 'auto'},
    addr: {color: c.subtext, fontSize: 13, fontFamily: MONO, fontWeight: '700', lineHeight: 18},
    sub: {color: c.subtext, fontSize: 12},
    rowText: {color: c.text, fontSize: 15, fontWeight: '600'},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
    pressed: {opacity: 0.6},
  });

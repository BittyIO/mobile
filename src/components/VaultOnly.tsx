import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNetwork} from '@/core/network-store';
import {toggleAccount, useWalletMode} from '@/core/account-mode';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {VaultIcon} from './AccountSwitch';

/**
 * A screen that acts on the vault, opened with the wallet in front: it says so and offers the
 * switch, rather than showing the wallet's address in the header while it acts on the vault.
 *
 * Wrapped around each such screen until it has a wallet path of its own.
 */
export function VaultOnly({children, padTop = 0, padBottom = 0}: {children: React.ReactNode; padTop?: number; padBottom?: number}) {
  const network = useNetwork((s) => s.network);
  const wallet = useWalletMode(network);
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  if (!wallet) return <>{children}</>;
  return (
    <View style={[styles.container, {paddingTop: padTop, paddingBottom: padBottom}]}>
      <VaultIcon color={c.accent} size={44} />
      <Text style={styles.title}>{t('mobile.account.vault_only')}</Text>
      <Pressable style={styles.button} onPress={() => toggleAccount(network)} accessibilityRole="button">
        <Text style={styles.buttonText}>{t('mobile.account.to_vault')}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 14},
    title: {color: c.text, fontSize: 17, fontWeight: '700', textAlign: 'center'},
    button: {backgroundColor: c.accent, borderRadius: 14, paddingHorizontal: 22, paddingVertical: 12},
    buttonText: {color: c.onAccent, fontSize: 15, fontWeight: '700'},
  });

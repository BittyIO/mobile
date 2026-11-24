import React, {useEffect, useMemo} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useVaults} from '@/core/vault-store';
import {useHiddenWallets} from '@/core/account-mode';
import {asShown} from '@/core/format';
import {CopyButton} from '@/components/CopyButton';
import {useT} from '@/i18n';
import {MONO, useStyles, type Colors} from '@/theme';
import {walletRows} from './WalletListScreen';

/**
 * Choose wallet › ⋯ › Hidden wallets: what was swiped off the list, each with Restore — as Removed
 * vaults is for Choose vault. Closes itself once there is nothing left on it.
 */
export function HiddenWalletsScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const vaults = useVaults((s) => s.vaults);
  const hidden = useHiddenWallets((s) => s.hidden);
  const restore = useHiddenWallets((s) => s.restore);
  const rows = useMemo(() => walletRows(vaults, hidden, 'hidden'), [vaults, hidden]);

  useEffect(() => {
    if (rows.length === 0) nav.goBack();
  }, [rows.length, nav]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <Text style={styles.note}>{t('mobile.account.hidden_note')}</Text>
      <View style={styles.group}>
        {rows.map((r, i) => {
          const label = t('mobile.account.wallet_n', {n: r.number});
          return (
            <View key={r.address} style={[styles.row, i < rows.length - 1 && styles.rowDivider]}>
              <View style={styles.text}>
                <View style={styles.nameLine}>
                  <Text style={styles.name} numberOfLines={1}>
                    {label}
                  </Text>
                  <CopyButton address={asShown(r.address)} />
                </View>
                <Text style={styles.addr}>{asShown(r.address)}</Text>
              </View>
              <Pressable
                onPress={() => restore(r.address)}
                hitSlop={8}
                style={({pressed}) => [styles.restore, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`${t('mobile.vaults.restore')}: ${label}`}>
                <Text style={styles.restoreText}>{t('mobile.vaults.restore')}</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 12, paddingBottom: 32},
    note: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    group: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 56},
    rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    text: {flex: 1, gap: 3},
    nameLine: {flexDirection: 'row', alignItems: 'center', gap: 8},
    name: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    addr: {color: c.subtext, fontSize: 13, fontFamily: MONO, fontWeight: '700', lineHeight: 18},
    restore: {backgroundColor: c.accentSoft, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7},
    restoreText: {color: c.accent, fontSize: 14, fontWeight: '700'},
    pressed: {opacity: 0.6},
  });

import React, {useEffect} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useVaults, vaultLabel} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';
import {networkLabel, useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {asShown} from '@/core/format';
import {CopyButton} from '@/components/CopyButton';
import {useT} from '@/i18n';
import {useStyles, type Colors, MONO} from '@/theme';

/**
 * Choose vault › ⋯ › Removed vaults: what was swiped off the list, each with Restore.
 *
 * Removing only ever hid an entry (see {VaultRef.hidden}), so a restore brings it back exactly as it
 * was — its name, its number, the key that signs for it — under the owner it was listed under. The
 * page closes itself once there is nothing left on it.
 */
export function RemovedVaultsScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const network = useNetwork((s) => s.network);
  const all = useVaults((s) => s.vaults);
  const restore = useVaults((s) => s.restore);
  const removed = all.filter((v) => v.hidden);
  const label = (n: number) => t('mobile.app.vault_n', {n});

  useEffect(() => {
    if (removed.length === 0) nav.goBack();
  }, [removed.length, nav]);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <Text style={styles.note}>{t('mobile.vaults.removed_note')}</Text>
      <View style={styles.group}>
        {removed.map((v, i) => {
          // A received vault exists on its own chain only: its address there, named by that chain.
          const here = vaultAddressOf(v, network);
          const elsewhere = !!v.vault && !here;
          const address = elsewhere ? v.vault! : here;
          return (
            <View key={v.index} style={[styles.row, i < removed.length - 1 && styles.rowDivider]}>
              <View style={styles.text}>
                <View style={styles.nameLine}>
                  <Text style={styles.name} numberOfLines={1}>
                    {vaultLabel(v, label, all)}
                  </Text>
                  {address ? <CopyButton address={address} /> : null}
                </View>
                {address ? <Text style={styles.addr}>{asShown(address)}</Text> : null}
                {elsewhere && v.network ? <Text style={styles.sub}>{networkLabel(v.network as Network, t)}</Text> : null}
              </View>
              <Pressable
                onPress={() => restore(v.index)}
                hitSlop={8}
                style={({pressed}) => [styles.restore, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`${t('mobile.vaults.restore')}: ${vaultLabel(v, label, all)}`}>
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
    sub: {color: c.subtext, fontSize: 12},
    restore: {backgroundColor: c.accentSoft, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7},
    restoreText: {color: c.accent, fontSize: 14, fontWeight: '700'},
    pressed: {opacity: 0.6},
  });

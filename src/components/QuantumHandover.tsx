import React, {useEffect, useState} from 'react';
import {Linking, Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import type {Address} from 'viem';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {explorerAddressUrl} from '@/core/chain';
import {vaultOwnerOf} from '@/vault/owned-vaults';
import {Sheet} from '@/components/Sheet';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * What a quantum-safe key change is, for a pending row (see wallet/rotation): the two keys, each
 * with what is public about it — the one in charge has signed, so its public key is out; the one
 * the vault moves to has never signed, so only its address is — and an ⓘ that says why that is the
 * point. The key in charge is read from the chain: it is the vault's owner until the handover lands.
 */
export function QuantumKeys({to}: {to: Address}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const [from, setFrom] = useState<Address | null>(null);
  useEffect(() => {
    let live = true;
    if (vault) vaultOwnerOf(network, vault).then((o) => live && setFrom(o));
    return () => {
      live = false;
    };
  }, [network, vault]);

  // In full, as an address is checked; a tap opens it on the explorer, where its history shows
  // whether it has signed anything.
  const line = (address: Address | null, signed: boolean) => (
    <View style={styles.key}>
      <Pressable
        style={({pressed}) => [styles.addrLine, pressed && styles.pressed]}
        onPress={() => address && void Linking.openURL(explorerAddressUrl(network, address)).catch(() => {})}
        disabled={!address}
        hitSlop={6}
        accessibilityRole="link">
        <Text style={styles.addr} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {address ?? '—'}
        </Text>
        {address ? <Text style={styles.open}>↗</Text> : null}
      </Pressable>
      <Text style={[styles.tag, signed ? styles.tagSigned : styles.tagFresh]}>
        {t(signed ? 'mobile.quantum.key_signed' : 'mobile.quantum.key_unsigned')}
      </Text>
    </View>
  );

  return (
    <View style={styles.keys}>
      {line(from, true)}
      <Text style={styles.arrow}>↓</Text>
      {line(to, false)}
    </View>
  );
}

/** The ⓘ beside a quantum-safe key change's title, opening why the change keeps the vault safe. */
export function QuantumInfoButton() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('mobile.quantum.info_title')}>
        <Svg width={17} height={17} viewBox="0 0 24 24">
          <Circle cx={12} cy={12} r={10} stroke={c.subtext} strokeWidth={2} fill="none" />
          <Path d="M12 16v-4M12 8h.01" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      </Pressable>
      <Sheet visible={open} title={t('mobile.quantum.info_title')} onClose={() => setOpen(false)}>
        <View style={styles.info}>
          {(['info_hash', 'info_signed', 'info_move', 'info_phrase'] as const).map((k, i) => (
            <View key={k} style={styles.point}>
              <View style={styles.num}>
                <Text style={styles.numText}>{i + 1}</Text>
              </View>
              <Text style={styles.pointText}>{t(`mobile.quantum.${k}`)}</Text>
            </View>
          ))}
        </View>
      </Sheet>
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    keys: {gap: 4, marginTop: 4},
    key: {gap: 4, alignItems: 'flex-start'},
    addrLine: {flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'stretch'},
    addr: {flexShrink: 1, color: c.accent, fontSize: 12, fontFamily: 'Menlo'},
    open: {color: c.accent, fontSize: 12, fontWeight: '700'},
    pressed: {opacity: 0.6},
    arrow: {color: c.subtext, fontSize: 12, marginLeft: 4},
    tag: {fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, overflow: 'hidden'},
    tagSigned: {color: c.warning, backgroundColor: c.warningSoft},
    tagFresh: {color: c.success, backgroundColor: c.successSoft},
    info: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 14},
    point: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
    num: {width: 22, height: 22, borderRadius: 11, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center', marginTop: 1},
    numText: {color: c.accent, fontSize: 12, fontWeight: '700'},
    pointText: {flex: 1, color: c.text, fontSize: 14, lineHeight: 20},
  });

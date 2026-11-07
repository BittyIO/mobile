import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {ReceiveDialog} from '@/components/ReceiveDialog';
import {Amount} from '@/components/Amount';
import {networkLabel, useNetwork} from '@/core/network-store';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {formatEth, ownerEthBalance} from '@/vault/direct';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors, MONO} from '@/theme';
import {wrappableAddress} from '@/core/format';

/** How often the owner balance is re-read while the page is open — long enough to see ETH arrive. */
const BALANCE_POLL_MS = 15_000;

/**
 * The owner wallet that pays, when the owner pays: a row with its address — tap for the QR, with
 * copy and share — and a row with what is in it.
 *
 * Nothing here moves ETH: the owner tops the address up however they like — a send from the vault,
 * another wallet, an exchange withdrawal — which is why the address is the whole of it.
 */
export function OwnerWalletCard() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const network = useNetwork((s) => s.network);
  const {owner} = useActiveFeePayer(network);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [qr, setQr] = useState(false);

  useEffect(() => {
    if (!owner) return;
    let live = true;
    const read = () =>
      ownerEthBalance(network, owner)
        .then((b) => live && setBalance(b))
        .catch(() => {});
    read();
    const timer = setInterval(read, BALANCE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
      setBalance(null);
    };
  }, [owner, network]);

  if (!owner) return null;
  const label = networkLabel(network, t);
  return (
    <>
      <SettingsGroup>
        {/* The whole 42 characters: this is the address someone checks against the other side of a
            transfer. Two even halves where one line is too narrow (see {wrappableAddress}). */}
        <Pressable style={[styles.row, styles.rowDivider]} onPress={() => setQr(true)} accessibilityRole="button">
          <Text style={styles.addr} numberOfLines={2}>
            {wrappableAddress(owner)}
          </Text>
        </Pressable>
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{t('mobile.fees.balance')}</Text>
          <Text style={styles.rowValue}>
            {balance == null ? '…' : <><Amount v={formatEth(balance)} color={c.subtext} /> ETH</>}
          </Text>
        </View>
      </SettingsGroup>
      <ReceiveDialog
        visible={qr}
        onClose={() => setQr(false)}
        vault={owner}
        networkLabel={label}
        title={t('mobile.fees.owner_wallet')}
        sub={t('mobile.fees.qr_sub', {network: label})}
      />
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    addr: {flex: 1, color: c.text, fontSize: 13, fontFamily: MONO},
  });

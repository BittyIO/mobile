import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {OptionRow, SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {ReceiveDialog} from '@/components/ReceiveDialog';
import {Amount} from '@/components/Amount';
import {networkLabel, useNetwork} from '@/core/network-store';
import {setFeePayer, type FeePayer} from '@/core/fee-payer-store';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {formatEth, ownerEthBalance} from '@/vault/direct';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/** How often the owner balance is re-read while the page is open — long enough to see ETH arrive. */
const BALANCE_POLL_MS = 15_000;

/**
 * The first card of each Network fee page: whether THIS way is the one that pays. Choosing it is a
 * local setting — no write, no prompt — and the way that is not chosen keeps its own settings.
 */
export function UseForFeesRow({payer}: {payer: FeePayer}) {
  const {t} = useT();
  const network = useNetwork((s) => s.network);
  const {vault, payer: current} = useActiveFeePayer(network);
  if (!vault) return null;
  return (
    <SettingsGroup>
      <OptionRow
        title={t('mobile.fees.use_for_fees')}
        checked={current === payer}
        onPress={() => setFeePayer(network, vault, payer)}
        last
      />
    </SettingsGroup>
  );
}

/**
 * The owner wallet that pays, when the owner pays: its address across the row — tap for the QR,
 * with copy and share — and under it what is in it.
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
        {/* The whole 42 characters, shrunk to fit: this is the address someone checks against the
            other side of a transfer. */}
        <Pressable style={[styles.row, styles.ownerRow]} onPress={() => setQr(true)} accessibilityRole="button">
          <Text style={styles.addr} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {owner}
          </Text>
          <View style={styles.balance}>
            <Text style={styles.rowSub}>{t('mobile.fees.balance')}</Text>
            <Text style={styles.rowValue}>
              {balance == null ? '…' : <><Amount v={formatEth(balance)} color={c.subtext} /> ETH</>}
            </Text>
          </View>
        </Pressable>
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
    // Stacked rather than side by side: the address gets the full width, the balance its own line.
    ownerRow: {flexDirection: 'column', alignItems: 'stretch', gap: 8},
    addr: {color: c.text, fontSize: 13, fontFamily: 'Menlo'},
    balance: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  });

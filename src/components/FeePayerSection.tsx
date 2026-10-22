import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {OptionRow, SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {ReceiveDialog} from '@/components/ReceiveDialog';
import {Amount} from '@/components/Amount';
import {networkLabel, useNetwork} from '@/core/network-store';
import {setFeePayer} from '@/core/fee-payer-store';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {formatEth, ownerEthBalance} from '@/vault/direct';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/** How often the owner balance is re-read while the page is open — long enough to see ETH arrive. */
const BALANCE_POLL_MS = 15_000;

/**
 * Network fee › who pays: the vault (relayed, billed in a fee coin) or the owner wallet (sent from
 * this phone, gas in the owner's own ETH).
 *
 * With the owner paying, the page shows the owner address to fund and what is in it. Nothing here
 * moves ETH: the owner tops the address up however they like — a send from the vault, another
 * wallet, an exchange withdrawal — which is why the address is the whole of it. Tapping it opens
 * the QR, with copy and share, for whatever is on the other side of the transfer.
 *
 * Absent for a Safe-owned vault, which cannot send its own transactions and always pays through the
 * relayer.
 */
export function FeePayerSection() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const network = useNetwork((s) => s.network);
  const {owner, vault, payer, canChoose} = useActiveFeePayer(network);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [qr, setQr] = useState(false);

  useEffect(() => {
    if (payer !== 'owner' || !owner) return;
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
  }, [payer, owner, network]);

  if (!canChoose || !owner || !vault) return null;
  const label = networkLabel(network, t);

  return (
    <View style={styles.wrap}>
      {/* One card: the two choices, and with the owner paying, the address to fund and what is in
          it right under the choice that needs them. */}
      <SettingsGroup>
        <OptionRow
          title={t('mobile.fees.payer_vault')}
          checked={payer === 'vault'}
          onPress={() => setFeePayer(network, vault, 'vault')}
        />
        <OptionRow
          title={t('mobile.fees.payer_owner')}
          checked={payer === 'owner'}
          onPress={() => setFeePayer(network, vault, 'owner')}
          last={payer !== 'owner'}
        />
        {payer === 'owner' ? (
          <>
            <Pressable style={[styles.row, styles.rowDivider]} onPress={() => setQr(true)} accessibilityRole="button">
              {/* The whole 42 characters, shrunk to one line: this is the address someone checks
                  against the other side of a transfer. */}
              <Text style={styles.addr} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                {owner}
              </Text>
            </Pressable>
            <View style={styles.row}>
              <Text style={styles.rowTitle}>{t('mobile.fees.balance')}</Text>
              <Text style={styles.rowValue}>
                {balance == null ? '…' : <><Amount v={formatEth(balance)} color={c.subtext} /> ETH</>}
              </Text>
            </View>
          </>
        ) : null}
      </SettingsGroup>

      <ReceiveDialog
        visible={qr}
        onClose={() => setQr(false)}
        vault={owner}
        networkLabel={label}
        title={t('mobile.fees.owner_wallet')}
        sub={t('mobile.fees.qr_sub', {network: label})}
      />
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    wrap: {gap: 20, marginBottom: 20},
    addr: {flex: 1, color: c.text, fontSize: 13, fontFamily: 'Menlo'},
  });

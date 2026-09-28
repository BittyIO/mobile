import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {CopyAddress} from '@/components/CopyAddress';
import {shortAddress} from '@/core/format';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/** Receive dialog — the vault address as a QR + copyable text, like the web deposit dialog. */
export function ReceiveDialog({
  visible,
  onClose,
  vault,
  networkLabel,
}: {
  visible: boolean;
  onClose: () => void;
  vault: string | null;
  networkLabel: string;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{t('vault.receive')}</Text>
          <Text style={styles.sub}>{t('mobile.home.your_vault_on', {network: networkLabel})}</Text>
          {vault ? (
            <View style={styles.qrWrap}>
              <QRCode value={vault} size={200} backgroundColor="white" />
            </View>
          ) : null}
          {vault ? <CopyAddress address={vault} label={shortAddress(vault)} textStyle={styles.addr} iconSize={16} /> : <Text style={styles.addr}>—</Text>}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: c.overlay, alignItems: 'center', justifyContent: 'center', padding: 24},
  card: {width: '100%', maxWidth: 360, backgroundColor: c.card, borderRadius: 20, padding: 20, alignItems: 'center', gap: 14},
  title: {color: c.text, fontSize: 20, fontWeight: '800'},
  sub: {color: c.subtext, fontSize: 13, marginTop: -8},
  qrWrap: {backgroundColor: 'white', padding: 14, borderRadius: 16},
  addr: {color: c.text, fontSize: 13, fontFamily: 'Menlo', textAlign: 'center'},
});

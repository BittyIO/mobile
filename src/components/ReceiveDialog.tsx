import React, {useEffect, useRef, useState} from 'react';
import {Modal, Pressable, Share, StyleSheet, Text, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Receive dialog — the vault address as a QR + copyable text, like the web deposit dialog.
 *
 * `title` and `sub` say whose address it is when it is not the vault's — the owner wallet that pays
 * network fees (Network fee page) uses the same dialog under its own name.
 */
export function ReceiveDialog({
  visible,
  onClose,
  vault,
  networkLabel,
  title,
  sub,
}: {
  visible: boolean;
  onClose: () => void;
  vault: string | null;
  networkLabel: string;
  title?: string;
  sub?: string;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = () => {
    if (!vault) return;
    Clipboard.setString(vault);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  // The system sheet, so the address can go to any app the phone has — the common way it leaves
  // this screen is into a message to whoever is sending the funds.
  const share = () => vault && Share.share({message: vault}).catch(() => {});

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title ?? t('vault.receive')}</Text>
          <Text style={styles.sub}>{sub ?? t('mobile.home.your_vault_on', {network: networkLabel})}</Text>
          {vault ? (
            <View style={styles.qrWrap}>
              <QRCode value={vault} size={200} backgroundColor="white" />
            </View>
          ) : null}
          {/* One line, shrinking to fit rather than wrapping: the whole address is here to be
              read in one sweep, and two ragged lines of hex are harder to check than one. */}
          <Text style={styles.addr} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {vault ?? '—'}
          </Text>
          {vault ? (
            <View style={styles.actions}>
              {/* Green while "Copied" shows, so it reads as done at a glance, not only by its word. */}
              <Pressable style={[styles.btn, copied && styles.btnCopied]} onPress={copy}>
                <Text style={[styles.btnText, copied && styles.btnTextCopied]}>{copied ? t('common.copied') : t('common.copy')}</Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={share}>
                <Text style={styles.btnText}>{t('mobile.home.share_address')}</Text>
              </Pressable>
            </View>
          ) : null}
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
  // The full 42 characters. Shortened it could be compared but not transcribed, and this is the
  // one place someone reads an address off the screen to check it.
  addr: {color: c.text, fontSize: 13, fontFamily: 'Menlo', textAlign: 'center', alignSelf: 'stretch'},
  // Copy and Share on their own line, so neither crowds the address above them.
  actions: {flexDirection: 'row', alignSelf: 'stretch', gap: 10},
  btn: {flex: 1, height: 44, borderRadius: 22, backgroundColor: c.buttonSecondary, alignItems: 'center', justifyContent: 'center'},
  btnText: {color: c.text, fontSize: 15, fontWeight: '600'},
  btnCopied: {backgroundColor: c.success},
  btnTextCopied: {color: c.onAccent},
});

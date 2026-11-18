import React, {useCallback, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {erc20Abi} from 'viem';
import {isTronNetwork, NATIVE, publicClientFor} from '@/core/chain';
import {useWallet} from '@/wallet/store';
import {isActivated, priceActivation} from '@/vault/activate';
import {activateVaultOnly} from '@/vault/relay';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {showTx} from '@/components/Toast';
import {confirmWithFee, type FeeQuote} from '@/components/FeeConfirm';
import {ACTIVATION_FEE_USD} from '@/core/activation-fee';
import Clipboard from '@react-native-clipboard/clipboard';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * Activate the vault and nothing else, from the top of the Overview — on Tron, where the vault is
 * otherwise only created alongside the owner's first operation.
 *
 * That first operation used to be the only way in, and its own calls were priced into the
 * activation: adding a payee came to $14, over the $10 a vault may pay for one operation, so it
 * could not be done at all. Alone, an activation costs only the deployment. Activate opens the
 * confirm sheet with that fee and the Face ID button; a fee over the cap is refused with the reason.
 */
export function ActivateBanner({onActivated}: {onActivated?: () => void}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const [activated, setActivated] = useState<boolean | null>(null);
  // Pricing the fee and waiting on the confirm sheet: the button is off, with no spinner.
  const [activating, setActivating] = useState(false);
  // Confirmed and on its way: the spinner, from Confirm until the transaction is in.
  const [sending, setSending] = useState(false);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);

  const recheck = useCallback((vault: string | null, network: Parameters<typeof isActivated>[1]) => {
    if (!vault) return;
    isActivated(vault as `0x${string}`, network)
      .then(setActivated)
      .catch(() => setActivated(null));
  }, []);

  const {vault, network, stable, busy, ready} = useVaultWrite();
  const {payer} = useActiveFeePayer(network);

  useFocusEffect(
    useCallback(() => {
      setActivated(null);
      recheck(vault, network);
    }, [vault, network, recheck]),
  );

  if (!isTronNetwork(network) || activated !== false || !vault) return null;

  /**
   * The activation itself. Its own toast, and on failure the WHOLE error in an alert that can be
   * copied: a refused activation's reason comes after a blank line, and the toast shows only the
   * first, which left "your vault needs to be activated first" with nothing to say why.
   */
  const activate = async () => {
    if (!vault || !stable || !owner) return;
    setActivating(true);
    // The fee, priced the way the activation will be signed, while the sheet is already open (see
    // confirmWithFee). Over the cap it cannot be paid, and says so here. Paid from the vault, the fee
    // has to be there already: an empty vault cannot activate, so the sheet says what to send and
    // Confirm stays off. From the owner key the gas is the owner's.
    const quote = async (): Promise<FeeQuote> => {
      const price = await priceActivation({owner: owner as `0x${string}`, network, stableCoin: stable.address, allowlistEnabled: false});
      const networkFeeUsd = price.feeNative * price.nativeUsd;
      let blocked: string | null = null;
      if (payer !== 'owner') {
        const client = publicClientFor(network);
        const [held, native] = await Promise.all([
          client.readContract({address: price.coin, abi: erc20Abi, functionName: 'balanceOf', args: [vault]}),
          price.weth ? client.getBalance({address: vault}) : Promise.resolve(BigInt(0)),
        ]);
        if (held + native < price.feeAmount) {
          // What to send: the activation's network fee plus the $1, in either coin it can be paid
          // with. Rounded up, so sending the figure shown is always enough.
          const up = (x: number) => (Math.ceil(x * 100) / 100).toFixed(2);
          const usd = ACTIVATION_FEE_USD + networkFeeUsd;
          const amount = `${up(usd)} ${stable.symbol} / ${up(price.nativeUsd > 0 ? usd / price.nativeUsd : 0)} ${NATIVE[network].symbol}`;
          blocked = t('mobile.home.activate_fund', {amount});
        }
      }
      return {feeUsd: price.feeUsd, blocked, networkFeeUsd};
    };
    let ok: boolean;
    try {
      ok = await confirmWithFee(t('mobile.home.activate'), quote());
    } catch (e) {
      setActivating(false);
      const msg = String((e as Error)?.message ?? e);
      Alert.alert(t('mobile.home.activate_title'), msg, [
        {text: t('mobile.home.copy_error'), onPress: () => Clipboard.setString(msg)},
        {text: t('common.ok')},
      ]);
      return;
    }
    if (!ok) {
      setActivating(false);
      return;
    }
    setSending(true);
    const tx = showTx(t('mobile.home.activate_title'), network);
    try {
      const account = await getSigner();
      const {hash} = await activateVaultOnly({account, vault, network, stableCoin: stable.address});
      tx.success(hash);
      recheck(vault, network);
      onActivated?.();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      tx.error(msg);
      Alert.alert(t('mobile.home.activate_title'), msg, [
        {text: t('mobile.home.copy_error'), onPress: () => Clipboard.setString(msg)},
        {text: t('common.ok')},
      ]);
    } finally {
      setSending(false);
      setActivating(false);
    }
  };

  const spinning = sending || busy !== null;
  const off = activating || spinning || !ready;
  return (
    <View style={styles.card}>
      <View style={styles.text}>
        <Text style={styles.title}>{t('mobile.home.activate_title')}</Text>
        <Text style={styles.body}>{t('mobile.home.activate_body')}</Text>
      </View>
      <Pressable
        onPress={() => void activate()}
        disabled={off}
        style={[styles.button, off && styles.buttonOff]}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.home.activate')}>
        {spinning ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{t('mobile.home.activate')}</Text>}
      </Pressable>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 12},
    text: {gap: 4},
    title: {color: c.text, fontSize: 17, fontWeight: '700'},
    body: {color: c.subtext, fontSize: 14, lineHeight: 20},
    button: {height: 44, borderRadius: 22, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center'},
    buttonOff: {opacity: 0.5},
    buttonText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  });

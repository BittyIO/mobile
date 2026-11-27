import React, {useCallback, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {erc20Abi, formatUnits, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {knownAssets} from '@/core/assets';
import {useWallet} from '@/wallet/store';
import {activateAccount, AccountRelayError, isAccountActive, quoteActivation, type AccountQuote} from '@/account/relay';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {fmtNum} from '@/core/format';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * Activate the Tron smart wallet (a BittyAccount, core/tron-account), at the top of the Overview,
 * before anything else can be done with it: its address takes USDT before it exists, and activating
 * creates it there, paid once by the relayer's fee out of that USDT (account/relay). Activate opens
 * a sheet with the fee and the Face ID Confirm; an account short of the fee says what to send.
 */
export function AccountActivateBanner({network, account, onActivated}: {network: Network; account: Address; onActivated?: () => void}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const [active, setActive] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<AccountQuote | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [state, setState] = useState<'idle' | 'quoting' | 'failed' | 'sending'>('idle');
  const usdt = knownAssets(network).find((a) => a.symbol === 'USDT');

  const recheck = useCallback(() => {
    isAccountActive(network, account)
      .then(setActive)
      .catch(() => setActive(null));
  }, [network, account]);
  useFocusEffect(
    useCallback(() => {
      setActive(null);
      recheck();
    }, [recheck]),
  );

  if (active !== false || !usdt) return null;
  const fmt = (v: bigint) => `${fmtNum(Number(formatUnits(v, usdt.decimals)))} ${usdt.symbol}`;

  // The fee, quoted while the sheet is already up, and what the account holds to pay it with.
  const start = async () => {
    setOpen(true);
    setQuote(null);
    setState('quoting');
    const owner = useWallet.getState().address as Address | null;
    if (!owner) return setState('failed');
    try {
      const [q, h] = await Promise.all([
        quoteActivation({network, owner}),
        publicClientFor(network).readContract({address: usdt.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [account]}),
      ]);
      setQuote(q);
      setHeld(h);
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  const short = !!quote && held !== null && held < quote.fee;

  const confirm = async () => {
    if (!quote || short) return;
    // As the vault's did: the sheet closes on Confirm and the banner's button spins until it is in.
    setOpen(false);
    setState('sending');
    const tx = showTx(t('mobile.actions.activate'), network);
    try {
      const signer = await useWallet.getState().walletSigner();
      const {hash} = await activateAccount({network, signer, quote});
      tx.success(hash);
      // The account appears a block or two later: check then, and once more.
      setTimeout(recheck, 4000);
      setTimeout(recheck, 10000);
      onActivated?.();
    } catch (e) {
      const msg = e instanceof AccountRelayError ? e.message : String((e as Error)?.message ?? e);
      if (/cancel/i.test(msg)) tx.done();
      else {
        tx.error(msg);
        Alert.alert(t('mobile.home.account_activate_title'), msg, [
          {text: t('mobile.home.copy_error'), onPress: () => Clipboard.setString(msg)},
          {text: t('common.ok')},
        ]);
      }
    } finally {
      setState('idle');
    }
  };

  return (
    <>
      <View style={styles.card}>
        <View style={styles.text}>
          <Text style={styles.title}>{t('mobile.home.account_activate_title')}</Text>
          <Text style={styles.body}>{t('mobile.home.account_activate_body', {token: usdt.symbol})}</Text>
        </View>
        {/* Off while its sheet is up, a spinner while the activation is on its way, as the vault's was. */}
        <Pressable
          onPress={() => void start()}
          disabled={open || state === 'sending'}
          style={[styles.button, (open || state === 'sending') && styles.buttonOff]}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.home.activate')}>
          {state === 'sending' ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{t('mobile.home.activate')}</Text>}
        </Pressable>
      </View>

      {/* As the vault's activation was (FeeConfirm): the title, what to send if it is short, a spinner
          while pricing, and the fee at the Confirm button's top right. */}
      <Sheet visible={open} title={t('mobile.home.activate')} onClose={() => setOpen(false)}>
        <View style={styles.sheetBody}>
          {short && quote && held !== null ? <Text style={styles.blocked}>{t('mobile.home.account_activate_fund', {amount: fmt(quote.fee - held)})}</Text> : null}
          {state === 'failed' ? <Text style={styles.blocked}>{t('mobile.account.fee_failed')}</Text> : null}
          {state === 'quoting' ? (
            <View style={styles.pricing}>
              <ActivityIndicator size="small" color={c.subtext} />
            </View>
          ) : null}
          <ConfirmButton
            onPress={() => void confirm()}
            loading={state === 'sending'}
            disabled={!quote || short || state !== 'idle'}
            fee={false}
            activationFee={quote ? Number(formatUnits(quote.fee, usdt.decimals)) : undefined}
            pricing={state === 'quoting'}
          />
        </View>
      </Sheet>
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 12},
    text: {gap: 4},
    title: {color: c.text, fontSize: 17, fontWeight: '700'},
    body: {color: c.subtext, fontSize: 14, lineHeight: 20},
    button: {minHeight: 44, paddingVertical: 6, borderRadius: 22, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center'},
    buttonOff: {opacity: 0.5},
    buttonText: {color: '#fff', fontSize: 16, fontWeight: '700'},
    sheetBody: {gap: 8},
    blocked: {color: c.subtext, fontSize: 14, lineHeight: 20, marginBottom: 12},
    pricing: {minHeight: 16, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 4},
  });

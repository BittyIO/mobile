import React, {useCallback, useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {formatUnits, type Address} from 'viem';
import {knownAssets} from '@/core/assets';
import {useNetwork} from '@/core/network-store';
import {useActiveAccount} from '@/core/account-mode';
import {useWallet} from '@/wallet/store';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {useAccountWrites} from './writes';
import {AccountRelayError, feeCall, quoteAccount, relayAccount, type AccountCall, type AccountQuote} from './relay';

type Calls = AccountCall[] | (() => AccountCall[] | Promise<AccountCall[]>);

/**
 * The Tron smart wallet's {useVaultWrite}: one owner change behind the same confirm sheet (its title,
 * a line of warning, Face ID Confirm with the fee at its top right), a toast that follows it, and
 * `onDone` once it is sent so the page re-reads. Each change is a batch the owner key signs and Bitty's
 * relayer sends, its fee paid in USDT from the account in the same batch (account/relay).
 *
 * `busy` is the key of the change in flight, as the vault's hook has it, so the same pages can show
 * which button is working.
 */
export function useAccountWrite(onDone?: () => void) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const unlocked = useWallet((s) => s.unlocked);
  const network = useNetwork((s) => s.network);
  const active = useActiveAccount(network);
  const account = active.kind === 'account' ? active.account : null;
  const owner = active.wallet;
  const usdt = knownAssets(network).find((a) => a.symbol === 'USDT');
  const [busy, setBusy] = useState<string | null>(null);
  const [req, setReq] = useState<{key: string; title: string; message?: string; calls: AccountCall[]; onSent?: () => void} | null>(null);
  const [quote, setQuote] = useState<AccountQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  /** Ask for `calls` behind the confirm sheet, its fee quoted while the sheet is already up. */
  const run = useCallback(
    async (key: string, title: string, calls: Calls, message?: string, onSent?: () => void) => {
      if (!account || !owner) return;
      setQuote(null);
      setQuoteError(null);
      let list: AccountCall[];
      try {
        list = typeof calls === 'function' ? await calls() : calls;
      } catch (e) {
        showTx(title, network).error(String((e as Error)?.message ?? e));
        return;
      }
      if (!list.length) return;
      setReq({key, title, message, calls: list, onSent});
      try {
        setQuote(await quoteAccount({network, owner: owner as Address, calls: list}));
      } catch (e) {
        setQuoteError(e instanceof AccountRelayError && e.code ? `${t('mobile.account.fee_failed')} (${e.code})` : t('mobile.account.fee_failed'));
      }
    },
    [account, owner, network, t],
  );

  /** Send `calls` priced at `q` and signed with Face ID, the toast reporting the rest. */
  const sendNow = (r: {key: string; title: string; calls: AccountCall[]; onSent?: () => void}, q: AccountQuote) => {
    setBusy(r.key);
    const tx = showTx(r.title, network);
    void (async () => {
      try {
        const signer = await useWallet.getState().walletSigner();
        const {hash} = await relayAccount({network, signer, quote: q, calls: [...r.calls, feeCall(q)]});
        r.onSent?.();
        tx.success(hash);
        // The relayer returns once it is sent; the chain shows it a block or so later.
        setTimeout(() => {
          onDone?.();
          useAccountWrites.getState().bump();
        }, 3500);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/cancel/i.test(msg)) tx.done();
        else tx.error(e instanceof AccountRelayError && e.code ? `${msg} (${e.code})` : msg);
      } finally {
        setBusy(null);
      }
    })();
  };

  // Confirmed, so the sheet goes; the toast reports the rest (as ConfirmAction's does).
  const confirm = () => {
    if (!req || !quote) return;
    const r = req;
    setReq(null);
    sendNow(r, quote);
  };

  /**
   * For a page whose own Confirm carries the fee (ConfirmButton, priced by {useAccountQuote}): the
   * batch sent with no sheet in front of it. Face ID is still asked, by the signer.
   */
  const runQuoted = (key: string, title: string, calls: AccountCall[], q: AccountQuote, onSent?: () => void) => sendNow({key, title, calls, onSent}, q);

  const sheet = (
    <Sheet visible={req != null} title={req?.title ?? ''} onClose={() => setReq(null)}>
      <View style={styles.body}>
        {req?.message ? <Text style={styles.message}>{req.message}</Text> : null}
        {quoteError ? <Text style={styles.message}>{quoteError}</Text> : null}
        <ConfirmButton
          onPress={confirm}
          disabled={!quote}
          fee={false}
          networkFeeUsd={quote && usdt ? Number(formatUnits(quote.fee, usdt.decimals)) : undefined}
          pricing={!quote && !quoteError}
          style={styles.submit}
        />
      </View>
    </Sheet>
  );

  const ready = unlocked && !!account && !!owner && busy === null;
  return {account, owner, network, busy, ready, run, runQuoted, sheet};
}

/**
 * The relayer's price for `calls` (null: nothing to price), re-asked whenever they change: what a
 * page's own ConfirmButton shows at its top right, before {useAccountWrite}'s `runQuoted` sends it.
 */
export function useAccountQuote(calls: AccountCall[] | null) {
  const network = useNetwork((s) => s.network);
  const owner = useActiveAccount(network).wallet;
  const [quote, setQuote] = useState<AccountQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = calls ? calls.map((c) => `${c.to}:${c.value}:${c.data}`).join('|') : '';
  useEffect(() => {
    setQuote(null);
    setError(null);
    if (!calls?.length || !owner) return;
    let live = true;
    const id = setTimeout(() => {
      quoteAccount({network, owner: owner as Address, calls})
        .then((q) => live && setQuote(q))
        .catch((e) => live && setError(e instanceof AccountRelayError ? (e.code ?? e.reason ?? 'failed') : 'failed'));
    }, 300);
    return () => {
      live = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, network, owner]);
  return {quote, error, pricing: !!calls?.length && !quote && !error};
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    body: {flex: 1},
    message: {color: c.subtext, fontSize: 15, lineHeight: 21},
    submit: {marginTop: 14},
  });

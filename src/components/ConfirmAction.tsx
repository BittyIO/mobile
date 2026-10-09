import React, {useCallback, useState} from 'react';
import {Alert, StyleSheet, Text, View} from 'react-native';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {showToast} from '@/components/Toast';
import {useT} from '@/i18n';
import {TYPICAL_RELAY_GAS} from '@/vault/fee-quote';
import {useStyles, type Colors} from '@/theme';

export type ConfirmRequest = {
  /** What is about to happen, in the user's words: "Cancel limit order". */
  title: string;
  /** One line of detail underneath — the order, the address, the amount. */
  message?: string;
  /** Gas this operation is expected to burn; drives the fee line. */
  gas?: bigint;
  /** Tints the button red for something destructive. */
  danger?: boolean;
  run: () => Promise<void> | void;
};

/**
 * A confirmation step for anything that touches the chain.
 *
 * Every on-chain action in the app costs the vault a relay fee and is irreversible once mined, so
 * none of them should be one tap away — a mis-tap on a row's Cancel link used to send a
 * transaction with nothing in between. This puts the same Face ID button and the same estimated
 * fee in front of all of them, so the cost is always visible before the signature.
 *
 *   const {ask, sheet} = useConfirmAction();
 *   …<Pressable onPress={() => ask({title, message, gas, run: doIt})} />
 *   …{sheet}
 */
export function useConfirmAction(): {ask: (r: ConfirmRequest) => void; sheet: React.ReactNode} {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const styles = useStyles(makeStyles);

  const ask = useCallback((r: ConfirmRequest) => setReq(r), []);
  const close = useCallback(() => setReq(null), []);

  /**
   * Confirmed, so the sheet goes — it does not wait for the operation.
   *
   * It used to hold a spinner on its own button until the relay came back, which meant a sheet
   * sitting over the page for as long as a signature, a relay and a receipt take, with nothing on
   * it but a turning button. The toast reports all three now, with the hash and a link, so the
   * sheet has nothing left to say the moment the user says yes.
   *
   * Not awaited, and not caught either: every caller already wraps its work in `showTx`, which is
   * what turns a failure into a toast. The `catch` here only stops an unhandled rejection from a
   * caller that forgets — it deliberately shows nothing, because a second report of the same
   * failure is worse than none.
   */
  const confirm = useCallback(() => {
    if (!req) return;
    const {run} = req;
    setReq(null);
    void (async () => {
      try {
        await run();
      } catch {
        /* reported by the caller's own showTx */
      }
    })();
  }, [req]);

  const sheet = (
    <Sheet
      visible={req != null}
      title={req?.title ?? ''}
      onClose={close}
      // No height of its own: the shared 61.8% every other popup in the app stops at. It held a
      // third of the screen on the grounds that a yes/no needs no more, which was true of the
      // sheet in isolation and wrong beside the ones it alternates with.
      >
      {/* Title, what is being confirmed, then the button — the order the trade sheet uses. The
          button was pushed to the floor by a flexing spacer, which put the whole height of the
          sheet between the sentence and the control that acts on it. The space below it is left
          empty instead. */}
      <View style={styles.body}>
        {req?.message ? <Text style={styles.message}>{req.message}</Text> : null}
        <ConfirmButton onPress={confirm} gas={req?.gas ?? TYPICAL_RELAY_GAS} style={styles.submit} />
      </View>
    </Sheet>
  );

  return {ask, sheet};
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    body: {flex: 1},
    message: {color: c.subtext, fontSize: 15, lineHeight: 21},
    submit: {marginTop: 14},
  });


export type LocalRequest = {
  /** What is about to happen: "Delete list". */
  title: string;
  /** One line of detail underneath — what will be lost, and what will not. */
  message?: string;
  /** Label on the acting button; defaults to Confirm. */
  action?: string;
  /** Marks the button destructive — red, and on the right, as iOS does it. */
  danger?: boolean;
  run: () => Promise<void> | void;
};

/**
 * A confirmation step for something the app does BY ITSELF.
 *
 * The hook above is for the chain: a sheet with an estimated fee and a Face ID button, because an
 * on-chain action costs the vault money and cannot be taken back. Deleting a watch list costs
 * nothing, signs nothing and touches no contract — putting it behind that control says the
 * opposite of what is true, and asks for a fingerprint to tidy up a list of favourites.
 *
 * So this is the SYSTEM alert: the centred box iOS puts over the screen for exactly this
 * question, with Cancel and the action side by side. Not a sheet — a sheet is the app's surface
 * for choosing something, and it slides up from the same place the fee sheet does, which was the
 * whole confusion. The alert is also the one piece of UI the user has already learned from every
 * other app on the phone, and it needs no node rendered anywhere, so a screen gains a
 * confirmation by calling one function.
 *
 *   const confirm = useConfirmLocal();
 *   …<Pressable onPress={() => confirm({title, message, danger: true, run: doIt})} />
 */
export function useConfirmLocal(): (r: LocalRequest) => void {
  const {t} = useT();
  return useCallback(
    ({title, message, action, danger, run}: LocalRequest) =>
      Alert.alert(title, message, [
        // Cancel first, so iOS lays it out on the left and gives it the Escape role.
        {text: t('common.cancel'), style: 'cancel'},
        {
          text: action ?? t('vault.confirm'),
          style: danger ? 'destructive' : 'default',
          onPress: () => {
            // Local work, so a failure is nearly impossible — but an unhandled rejection here
            // would be a red box in dev and silence in release, and neither says what happened.
            void Promise.resolve()
              .then(run)
              .catch((e) => showToast('error', title, String((e as Error)?.message ?? e)));
          },
        },
      ]),
    [t],
  );
}

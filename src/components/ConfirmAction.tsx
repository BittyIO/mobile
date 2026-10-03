import React, {useCallback, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
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
  const [busy, setBusy] = useState(false);
  const styles = useStyles(makeStyles);

  const ask = useCallback((r: ConfirmRequest) => {
    setReq(r);
    setBusy(false);
  }, []);

  const close = useCallback(() => {
    if (!busy) setReq(null);
  }, [busy]);

  const confirm = useCallback(async () => {
    if (!req) return;
    setBusy(true);
    try {
      await req.run();
    } finally {
      setBusy(false);
      setReq(null);
    }
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
        <ConfirmButton onPress={confirm} loading={busy} gas={req?.gas ?? TYPICAL_RELAY_GAS} style={styles.submit} />
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

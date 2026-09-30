import React, {useCallback, useState} from 'react';
import {StyleSheet, Text, useWindowDimensions, View} from 'react-native';
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
  const {height} = useWindowDimensions();

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
      // Short: a line of text and a button. A full-height sheet for a yes/no reads as a page.
      height={Math.round(height * 0.34)}>
      <View style={styles.body}>
        {req?.message ? <Text style={styles.message}>{req.message}</Text> : null}
        <View style={styles.spacer} />
        <ConfirmButton onPress={confirm} loading={busy} gas={req?.gas ?? TYPICAL_RELAY_GAS} />
      </View>
    </Sheet>
  );

  return {ask, sheet};
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    body: {flex: 1},
    message: {color: c.subtext, fontSize: 15, lineHeight: 21},
    spacer: {flex: 1},
  });

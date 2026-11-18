import React, {useCallback} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {create} from 'zustand';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * A confirm sheet for an on-chain step started outside a screen's own confirm sheet (Tron's
 * activation, components/ActivateBanner): a title, the network fee, and the same Face ID Confirm
 * button as every other on-chain action.
 *
 * Asked for with a promise, so the request lives in a store and the sheet is mounted once at the
 * app's root ({FeeConfirmHost}).
 */
/** What the sheet shows once priced: see {confirmWithFee}. */
export type FeeQuote = {feeUsd: number | null; blocked: string | null; networkFeeUsd: number | null};

type Request = {title: string; quote: FeeQuote | null; resolve: (ok: boolean) => void};

const useFeeConfirm = create<{req: Request | null}>(() => ({req: null}));

/**
 * Show the sheet: a title, the fees, and Confirm. Resolves true on Confirm, false when dismissed.
 * For an on-chain step started outside a screen's own confirm sheet.
 *
 * The sheet opens at once, with a spinner where the fees go and Confirm off, while `quote` works
 * them out: pricing reads the chain and takes a few seconds, and a tap that seemed to do nothing for
 * that long read as broken. If pricing fails the sheet closes and the promise rejects with its error.
 *
 * In the quote, `blocked` is why the step cannot be done now (the vault cannot pay the fee), said
 * above a disabled Confirm, and `networkFeeUsd`, when known, is its network fee, at the top right.
 */
export function confirmWithFee(title: string, quote: Promise<FeeQuote>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // A request still open (it should not be) is declined, never left hanging.
    useFeeConfirm.getState().req?.resolve(false);
    const req: Request = {title, quote: null, resolve};
    useFeeConfirm.setState({req});
    quote.then(
      (q) => {
        // Dismissed while pricing: nothing to fill in.
        if (useFeeConfirm.getState().req !== req) return;
        useFeeConfirm.setState({req: {...req, quote: q}});
      },
      (e) => {
        if (useFeeConfirm.getState().req === req) useFeeConfirm.setState({req: null});
        reject(e);
      },
    );
  });
}

export function FeeConfirmHost() {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const req = useFeeConfirm((s) => s.req);
  const answer = useCallback((ok: boolean) => {
    const r = useFeeConfirm.getState().req;
    useFeeConfirm.setState({req: null});
    r?.resolve(ok);
  }, []);
  const q = req?.quote;
  return (
    <Sheet visible={req != null} title={req?.title ?? ''} onClose={() => answer(false)}>
      <View style={styles.body}>
        {q?.blocked ? <Text style={styles.blocked}>{q.blocked}</Text> : null}
        {/* Still pricing: a spinner where the fees go, and Confirm off until they are in. */}
        {req && !q ? (
          <View style={styles.pricing}>
            <ActivityIndicator size="small" color={c.subtext} />
          </View>
        ) : null}
        {/* The activation's fee at the button's top left, its network fee at the top right. */}
        <ConfirmButton
          onPress={() => answer(true)}
          fee={false}
          activationFee={q?.feeUsd ?? undefined}
          networkFeeUsd={q?.networkFeeUsd ?? undefined}
          disabled={!q || !!q.blocked}
        />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    body: {flex: 1, gap: 8},
    // Clear of the fee line and Confirm below it, so the ask reads as its own sentence.
    blocked: {color: c.subtext, fontSize: 14, lineHeight: 20, marginBottom: 12},
    // The height of the fee line it stands in for, so the button does not jump when the fees land.
    pricing: {height: 16, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 4},
  });

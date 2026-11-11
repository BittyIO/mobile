import React, {useCallback} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {create} from 'zustand';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {useStyles, type Colors} from '@/theme';

/**
 * A confirm sheet for an on-chain step started outside a screen's own confirm sheet (Tron's
 * activation, components/ActivateBanner): a title, the network fee, and the same Face ID Confirm
 * button as every other on-chain action.
 *
 * Asked for with a promise, so the request lives in a store and the sheet is mounted once at the
 * app's root ({FeeConfirmHost}).
 */
type Request = {title: string; feeUsd: number | null; blocked: string | null; resolve: (ok: boolean) => void};

const useFeeConfirm = create<{req: Request | null}>(() => ({req: null}));

/**
 * Show the sheet: a title, the fee in dollars, and Confirm. Resolves true on Confirm, false when
 * dismissed. For an on-chain step started outside a screen's own confirm sheet. `blocked` is why it
 * cannot be done now (the vault cannot pay the fee): said above a disabled Confirm.
 */
export function confirmWithFee(title: string, feeUsd: number | null, blocked: string | null = null): Promise<boolean> {
  return new Promise((resolve) => {
    // A request still open (it should not be) is declined, never left hanging.
    useFeeConfirm.getState().req?.resolve(false);
    useFeeConfirm.setState({req: {title, feeUsd, blocked, resolve}});
  });
}

export function FeeConfirmHost() {
  const styles = useStyles(makeStyles);
  const req = useFeeConfirm((s) => s.req);
  const answer = useCallback((ok: boolean) => {
    const r = useFeeConfirm.getState().req;
    useFeeConfirm.setState({req: null});
    r?.resolve(ok);
  }, []);
  const fee = req?.feeUsd;
  return (
    <Sheet visible={req != null} title={req?.title ?? ''} onClose={() => answer(false)}>
      <View style={styles.body}>
        {/* The activation's fee at the button's top left, as on every confirm surface. */}
        {req?.blocked ? <Text style={styles.blocked}>{req.blocked}</Text> : null}
        <ConfirmButton onPress={() => answer(true)} fee={false} activationFee={fee ?? undefined} disabled={!!req?.blocked} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    body: {flex: 1, gap: 8},
    blocked: {color: c.subtext, fontSize: 14, lineHeight: 20},
  });

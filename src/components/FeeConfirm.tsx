import React, {useCallback} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {create} from 'zustand';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {GasIcon} from '@/components/GasIcon';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * A confirm sheet for an on-chain step started outside a screen's own confirm sheet (Tron's
 * activation, components/ActivateBanner): a title, the network fee, and the same Face ID Confirm
 * button as every other on-chain action.
 *
 * Asked for with a promise, so the request lives in a store and the sheet is mounted once at the
 * app's root ({FeeConfirmHost}).
 */
type Request = {title: string; feeUsd: number | null; resolve: (ok: boolean) => void};

const useFeeConfirm = create<{req: Request | null}>(() => ({req: null}));

/**
 * Show the sheet: a title, the fee in dollars, and Confirm. Resolves true on Confirm, false when
 * dismissed. For an on-chain step started outside a screen's own confirm sheet.
 */
export function confirmWithFee(title: string, feeUsd: number | null): Promise<boolean> {
  return new Promise((resolve) => {
    // A request still open (it should not be) is declined, never left hanging.
    useFeeConfirm.getState().req?.resolve(false);
    useFeeConfirm.setState({req: {title, feeUsd, resolve}});
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
  const fee = req?.feeUsd;
  return (
    <Sheet visible={req != null} title={req?.title ?? ''} onClose={() => answer(false)}>
      <View style={styles.body}>
        {fee != null ? (
          <View style={styles.feeRow}>
            <GasIcon color={c.subtext} />
            <Text style={styles.fee}>${fee.toFixed(2)}</Text>
          </View>
        ) : null}
        <ConfirmButton onPress={() => answer(true)} fee={false} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    body: {flex: 1, gap: 8},
    feeRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5, paddingRight: 4},
    fee: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
  });

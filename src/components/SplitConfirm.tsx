import React, {useCallback} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {create} from 'zustand';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {GasIcon} from '@/components/GasIcon';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * The confirm sheet for each transaction of a write that is sent in parts (Tron, over the vault's
 * per-transaction fee limit — see vault/relay `splitOverCap`). The same sheet and Face ID button as
 * every other on-chain action, one per transaction: "Transaction 1 of 2", its fee, Confirm.
 *
 * Asked for from the relay, which is not a component, so the request lives in a store and the
 * sheet is mounted once at the app's root ({SplitConfirmHost}).
 */
type Request = {title: string; feeUsd: number | null; resolve: (ok: boolean) => void};

const useSplitConfirm = create<{req: Request | null}>(() => ({req: null}));

/**
 * Show the sheet: a title, the fee in dollars, and Confirm. Resolves true on Confirm, false when
 * dismissed. For an on-chain step started outside a screen's own confirm sheet.
 */
export function confirmWithFee(title: string, feeUsd: number | null): Promise<boolean> {
  return new Promise((resolve) => {
    // A request still open (it should not be) is declined, never left hanging.
    useSplitConfirm.getState().req?.resolve(false);
    useSplitConfirm.setState({req: {title, feeUsd, resolve}});
  });
}

/** The sheet for transaction `n` of `total` of a write sent in parts. */
export function confirmSplitPart(n: number, total: number, feeUsd: number | null): Promise<boolean> {
  return confirmWithFee(translate(useLanguage.getState().language, 'mobile.fees.split_title', {n, total}), feeUsd);
}

export function SplitConfirmHost() {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const req = useSplitConfirm((s) => s.req);
  const answer = useCallback((ok: boolean) => {
    const r = useSplitConfirm.getState().req;
    useSplitConfirm.setState({req: null});
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

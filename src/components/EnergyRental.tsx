import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {formatUnits, type Address} from 'viem';
import {NATIVE, type Network} from '@/core/chain';
import {formatNative} from '@/vault/direct';
import {quoteUsdtGas, usdtGasOffered, type UsdtGasQuote} from '@/tron/usdt-gas';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/** What ConfirmButton needs to draw the fee choice at its top left (see {RentalToggle}). */
export type RentalToggleProps = {
  /** On: the fee is paid in USDT (tron/usdt-gas). Off: in TRX, from the wallet. */
  on: boolean;
  onChange: (on: boolean) => void;
  /** The fee each way, as "1.20 USDT" and "6.5 TRX"; null while it is being worked out. */
  rent: string | null;
  burn: string | null;
  busy: boolean;
  error: string | null;
};

/**
 * USDT as gas (tron/usdt-gas) for a Tron wallet's USDT transfer: the fee quoted in USDT by Bitty's
 * server, which rents the energy and pays the rest, against the fee in TRX the wallet would burn.
 * On by default where offered — it is the cheaper of the two and needs no TRX at all. Not offered
 * with a note: Tron burns its memo fee in TRX from the sender.
 */
export function useUsdtGas(o: {network: Network; from?: Address | null; to?: Address | null; token?: Address | 'native'; amount?: bigint | null; memo?: string; burnSun: bigint | null}) {
  const {t} = useT();
  const offered = !!o.from && !!o.to && !!o.token && !!o.amount && o.amount > BigInt(0) && !o.memo && usdtGasOffered(o.network, o.token);
  const [choice, setChoice] = useState<boolean | null>(null);
  const [quote, setQuote] = useState<UsdtGasQuote | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const amountKey = o.amount?.toString();
  useEffect(() => {
    setQuote(null);
    if (!offered || !usdtGasOffered(o.network, o.token!)) return setState('idle');
    setState('busy');
    let live = true;
    const net = o.network;
    const id = setTimeout(() => {
      quoteUsdtGas(net, o.from!, o.to!, BigInt(amountKey!))
        .then((q) => live && (setQuote(q), setState('idle')))
        .catch(() => live && setState('failed'));
    }, 450);
    return () => {
      live = false;
      clearTimeout(id);
    };
    // The values, not the objects they came from: a re-render must not quote again.
  }, [offered, o.network, o.from, o.to, o.token, amountKey]);

  const on = offered && (choice ?? true);
  const sym = NATIVE[o.network].symbol;
  const usdt = quote ? `${Number(formatUnits(quote.fee, 6)).toFixed(2)} USDT` : null;
  const trx = o.burnSun != null ? `${formatNative(o.network, o.burnSun)} ${sym}` : null;
  return {
    offered,
    on,
    /** The quote to send with, when paying in USDT. */
    quote: on ? quote : null,
    /** Nothing in the way of confirming: paying in TRX, or the USDT quote is in. */
    ok: !on || (state === 'idle' && !!quote),
    /** The fee in USDT units when paying in USDT (also its dollar value), else null. */
    usdtFee: on && quote ? quote.fee : null,
    toggle: offered
      ? ({
          on,
          onChange: setChoice,
          rent: usdt,
          burn: trx,
          busy: state === 'busy',
          error: on && state === 'failed' ? t('mobile.tron.usdt_gas_failed') : null,
        } satisfies RentalToggleProps)
      : undefined,
  };
}

/**
 * The fee choice at the confirm button's top left: a small energy mark that turns paying in USDT on
 * or off (filled when on), then the fee the choice costs, the other one struck through after it.
 */
export function RentalToggle({p, disabled}: {p: RentalToggleProps; disabled?: boolean}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const taken = p.on ? p.rent : p.burn;
  const other = p.on ? p.burn : p.rent;
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Pressable
          onPress={() => p.onChange(!p.on)}
          disabled={disabled}
          hitSlop={10}
          style={[styles.mark, p.on ? styles.markOn : styles.markOff]}
          accessibilityRole="switch"
          accessibilityState={{checked: p.on}}
          accessibilityLabel={t('mobile.tron.usdt_gas')}>
          <Svg width={14} height={14} viewBox="0 0 24 24">
            <Path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill={p.on ? c.accent : 'none'} stroke={p.on ? c.accent : c.subtext} strokeWidth={2} strokeLinejoin="round" />
          </Svg>
        </Pressable>
        <Text style={styles.value}>{taken ?? (p.busy ? t('mobile.account.fee_estimating') : '—')}</Text>
        {other ? <Text style={[styles.dim, styles.struck]}>{other}</Text> : null}
      </View>
      {p.error ? <Text style={styles.error}>{p.error}</Text> : null}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {gap: 4, flexShrink: 1},
    row: {flexDirection: 'row', alignItems: 'center', gap: 6},
    mark: {width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
    markOn: {backgroundColor: c.accentSoft, borderColor: c.accent},
    markOff: {backgroundColor: 'transparent', borderColor: c.border},
    value: {color: c.subtext, fontSize: 12, fontWeight: '600'},
    dim: {color: c.subtext, fontSize: 12},
    struck: {textDecorationLine: 'line-through'},
    error: {color: c.danger, fontSize: 12},
  });

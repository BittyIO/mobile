import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import type {Address} from 'viem';
import {NATIVE, type Network} from '@/core/chain';
import {formatNative} from '@/vault/direct';
import {fmtNum} from '@/core/format';
import {evmToTron} from '@/tron/address';
import {freeEnergy, quoteEnergy, rentAmount, rentalOffered, type RentQuote} from '@/tron/energy-rental';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/** What ConfirmButton needs to draw the rental at its top left (see {RentalToggle}). */
export type RentalToggleProps = {
  on: boolean;
  onChange: (on: boolean) => void;
  /** With the rental, and without it, as "6.5 TRX"; null while it is being worked out. */
  rent: string | null;
  burn: string | null;
  busy: boolean;
  error: string | null;
  /**
   * Renting would not change the fee: the wallet's own energy covers the operation, so it pays the
   * same bandwidth either way. The mark is then greyed and only says so when tapped.
   */
  useless?: boolean;
};

/**
 * Energy rental (tron/energy-rental) for any Tron confirm: quotes the energy the wallet's own does
 * not cover, and prices the operation both ways. The switch follows whichever costs less until the
 * user sets it. `energy` is what the operation uses (no margin), `price` the chain's sun per energy,
 * `bandwidth` what it pays either way, `worst` its full fee without renting (margins included).
 */
export function useEnergyRental(o: {network: Network; wallet?: Address | null; energy: number | null; price: bigint | null; bandwidth: bigint | null; worst: bigint | null; enabled?: boolean}) {
  const {t} = useT();
  const offered = (o.enabled ?? true) && rentalOffered(o.network) && !!o.wallet;
  const [choice, setChoice] = useState<boolean | null>(null);
  const [rent, setRent] = useState<{quote: RentQuote | null; covered: boolean; free: number} | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const ready = o.energy != null && o.price != null && o.bandwidth != null;
  useEffect(() => {
    setRent(null);
    if (!offered || !ready || !rentalOffered(o.network)) return setState('idle');
    setState('busy');
    let live = true;
    const net = o.network;
    const me = evmToTron(o.wallet!);
    const need = o.energy!;
    (async () => {
      const free = await freeEnergy(net, me);
      if (need - free <= 0) return {quote: null, covered: true, free};
      return {quote: await quoteEnergy(net, me, rentAmount(need - free)), covered: false, free};
    })()
      .then((r) => live && (setRent(r), setState('idle')))
      .catch(() => live && setState('failed'));
    return () => {
      live = false;
    };
    // The numbers, not the objects they came from: a re-render must not quote again.
  }, [offered, ready, o.network, o.wallet, o.energy]);

  const burnSun = ready ? BigInt(Math.max(0, o.energy! - (rent?.free ?? 0))) * o.price! + o.bandwidth! : null;
  const rentSun = !ready ? null : rent?.covered ? o.bandwidth! : rent?.quote ? rent.quote.costSun + o.bandwidth! : null;
  // Nothing to gain: the wallet's energy covers it, or the two totals come out the same.
  const useless = !!rent?.covered || (rentSun != null && burnSun != null && rentSun === burnSun);
  const on = offered && !useless && (choice ?? (rentSun != null && burnSun != null && rentSun < burnSun));
  const renting = on && !!rent?.quote;
  const short = renting && rent!.quote!.available < rent!.quote!.energy;
  const sym = NATIVE[o.network].symbol;
  const show = (v: bigint | null) => (v != null ? `${formatNative(o.network, v)} ${sym}` : null);
  return {
    offered,
    on,
    renting,
    /** The quote to rent with, when renting. */
    quote: renting ? rent!.quote! : null,
    /** Nothing in the way of confirming: off, or the quote is in and the market has the energy. */
    ok: !on || (state === 'idle' && !!rent && !short),
    /** The fee to show: the one the switch picks (the full fee where rental is not offered). */
    shownSun: !offered ? o.worst : on ? rentSun : burnSun,
    /** What the wallet must hold for the fee: the rent and bandwidth, or the full fee. */
    needSun: renting ? rentSun : o.worst,
    toggle: offered
      ? ({
          on,
          onChange: setChoice,
          rent: show(rentSun),
          burn: show(burnSun),
          busy: state === 'busy' || !ready,
          useless,
          error: !on ? null : state === 'failed' ? t('mobile.tron.rent_failed') : short ? t('mobile.tron.rent_short', {energy: fmtNum(rent!.quote!.available)}) : null,
        } satisfies RentalToggleProps)
      : undefined,
  };
}

/**
 * The rental at the confirm button's top left: a small energy mark that turns the rental on or off
 * (filled when on), then the fee in TRX the choice costs, the other one struck through after it.
 */
export function RentalToggle({p, disabled}: {p: RentalToggleProps; disabled?: boolean}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const taken = p.on ? p.rent : p.burn;
  // Where renting changes nothing there is one fee, not two to compare.
  const other = p.useless ? null : p.on ? p.burn : p.rent;
  const [why, setWhy] = useState(false);
  useEffect(() => {
    if (!why) return;
    const id = setTimeout(() => setWhy(false), 3000);
    return () => clearTimeout(id);
  }, [why]);
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Pressable
          onPress={() => (p.useless ? setWhy(true) : p.onChange(!p.on))}
          disabled={disabled}
          hitSlop={10}
          style={[styles.mark, p.on ? styles.markOn : styles.markOff, p.useless && styles.markUseless]}
          accessibilityRole="switch"
          accessibilityState={{checked: p.on}}
          accessibilityLabel={t('mobile.tron.rent_energy')}>
          <Svg width={14} height={14} viewBox="0 0 24 24">
            <Path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill={p.on ? c.accent : 'none'} stroke={p.on ? c.accent : c.subtext} strokeWidth={2} strokeLinejoin="round" />
          </Svg>
        </Pressable>
        <Text style={styles.value}>{taken ?? (p.busy ? t('mobile.account.fee_estimating') : '—')}</Text>
        {other ? <Text style={[styles.dim, styles.struck]}>{other}</Text> : null}
      </View>
      {p.error ? <Text style={styles.error}>{p.error}</Text> : null}
      {p.useless && why ? <Text style={styles.why}>{t('mobile.tron.rent_useless')}</Text> : null}
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
    markUseless: {opacity: 0.4},
    why: {color: c.subtext, fontSize: 12},
  });

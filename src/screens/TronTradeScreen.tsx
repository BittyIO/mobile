import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useFocusEffect} from '@react-navigation/native';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import {formatUnits, parseUnits} from 'viem';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {FIT} from '@/core/text-scale';
import {fmtNum} from '@/core/format';
import {useNetwork} from '@/core/network-store';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {ConfirmButton} from '@/components/Button';
import {ClearBtn} from '@/components/ClearBtn';
import {TokenIcon} from '@/components/TokenIcon';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {ProtocolChip} from '@/components/ProtocolIcon';
import {useToasts} from '@/components/Toast';
import {useTronWallet} from '@/tron/store';
import {balances, type TronBalance} from '@/tron/client';
import {UnlockCancelled} from '@/tron/send';
import {TRON_EXPLORER_TX} from '@/tron/config';
import {estimateSwap, quoteSwap, swapAvailable, swapTron, TRON_SWAP_FEE_BPS, type SwapCost, type SwapQuote, type SwapSide} from '@/tron/swap';

const DECIMALS = 6; // TRX (sun) and USDT both
const other = (s: SwapSide): SwapSide => (s === 'TRX' ? 'USDT' : 'TRX');
const fmt = (raw: bigint) => fmtNum(Number(formatUnits(raw, DECIMALS)));

function parseAmount(text: string): bigint | null {
  const s = text.trim().replace(',', '.');
  if (!s || !/^\d*\.?\d*$/.test(s)) return null;
  const [, frac = ''] = s.split('.');
  if (frac.length > DECIMALS) return null;
  try {
    const v = parseUnits(s, DECIMALS);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * Trade on Tron from the wallet: TRX ⇄ USDT through SunSwap (see tron/swap), laid out as the
 * Bridge and Trade tabs are: what you pay, a flip, what you get, then who swaps it and the fees.
 */
export function TronTradeScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const net = useNetwork((s) => s.tron) ?? 'tron';
  const from = useTronWallet((s) => s.address);
  const headerHeight = useTransparentHeaderInset();
  const tabBarHeight = useBottomTabBarHeight();

  const [sell, setSell] = useState<SwapSide>('TRX');
  const [amount, setAmount] = useState('');
  const [held, setHeld] = useState<TronBalance[] | null>(null);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [cost, setCost] = useState<SwapCost | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const loadBalances = useCallback(() => {
    if (!from) return;
    balances(net, from).then(setHeld, () => {});
  }, [from, net]);
  useFocusEffect(loadBalances);

  const balanceOf = (s: SwapSide) => held?.find((b) => b.asset.symbol === s)?.raw ?? 0n;
  const trx = balanceOf('TRX');
  const raw = parseAmount(amount);
  const over = raw != null && raw > balanceOf(sell);
  // The whole balance, as every wallet MAX is: what is short for the network fee, the line below says.
  const maxRaw = balanceOf(sell);
  const open = swapAvailable(net);

  // The quote, a moment after the typing stops: the router's price, then what the swap will burn.
  useEffect(() => {
    setQuote(null);
    setCost(null);
    setErr(null);
    if (!from || raw == null || over) return;
    let live = true;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const q = await quoteSwap(net, from, sell, raw);
        if (!live) return;
        setQuote(q);
        const k = await estimateSwap(net, from, q);
        if (live) setCost(k);
      } catch (e) {
        if (live) setErr((e as Error).message);
      } finally {
        if (live) setQuoting(false);
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, net, sell, amount, over]);

  // The network fee comes out of TRX, whichever side is sold; selling TRX, the TRX sold comes too.
  const trxNeeded = (cost?.burnSun ?? 0n) + (sell === 'TRX' && raw ? raw : 0n);
  const noTrx = !!cost && trxNeeded > trx;
  const canSwap = open && !!from && !!quote && !!cost && !over && !noTrx && !sending;

  const flip = () => {
    setSell(other(sell));
    setAmount('');
  };

  const swap = async () => {
    if (!canSwap || !from || !quote || !cost) return;
    Keyboard.dismiss();
    setSending(true);
    const toasts = useToasts.getState();
    const id = toasts.show({kind: 'pending', title: t('mobile.tron.swap_toast', {amount: fmt(quote.amountIn), sell, buy: other(sell)})});
    try {
      await swapTron({
        net,
        from,
        quote,
        cost,
        onSwapSent: (txID) => toasts.update(id, {kind: 'pending', hash: txID, explorer: {url: TRON_EXPLORER_TX[net], name: 'Tronscan'}}),
      });
      toasts.update(id, {kind: 'success', detail: undefined});
      setAmount('');
      loadBalances();
    } catch (e) {
      if (e instanceof UnlockCancelled) toasts.dismiss(id);
      else toasts.update(id, {kind: 'error', detail: (e as Error).message});
    } finally {
      setSending(false);
    }
  };

  const assetIcon = (s: SwapSide) => (s === 'TRX' ? <NetworkIcon network={net} size={20} /> : <TokenIcon symbol="USDT" size={20} />);
  const pct = `${Number(TRON_SWAP_FEE_BPS) / 100}%`;

  return (
    <ScrollView
      style={styles.container}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.body, {paddingTop: headerHeight + 8, paddingBottom: tabBarHeight + 16}]}>
      {/* What you pay: the coin (tap to change sides; there are two), the amount, the balance and MAX. */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>{t('mobile.tron.you_pay')}</Text>
        </View>
        <View style={styles.line}>
          <View style={styles.field}>
            <Pressable style={styles.assetPill} onPress={flip} accessibilityRole="button">
              {assetIcon(sell)}
              <Text style={styles.assetSym}>{sell}</Text>
            </Pressable>
            <TextInput
              style={[styles.input, over && styles.inputOver]}
              value={amount}
              onChangeText={setAmount}
              placeholder="0"
              placeholderTextColor={c.subtext}
              keyboardType="decimal-pad"
              textAlign="right"
            />
            {amount ? (
              <ClearBtn onPress={() => setAmount('')} />
            ) : maxRaw > 0n ? (
              <Pressable style={styles.maxBtn} onPress={() => setAmount(formatUnits(maxRaw, DECIMALS))} hitSlop={8}>
                <Text style={styles.balInline} numberOfLines={1}>{fmt(balanceOf(sell))}</Text>
                <Text style={styles.maxBadge}>{t('vault.max')}</Text>
              </Pressable>
            ) : null}
          </View>
          {over ? <Text style={styles.err}>{t('vault.exceeds_balance')}</Text> : null}
        </View>
      </View>

      <Pressable onPress={flip} hitSlop={8} style={styles.flipBtn} accessibilityRole="button" accessibilityLabel={t('mobile.trade.swap_sides')}>
        <Svg width={18} height={18} viewBox="0 0 24 24">
          <Path d="M12 5v14M6 13l6 6 6-6" stroke={c.text} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </Pressable>

      {/* What you get: the other coin, and about how much of it. */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>{t('mobile.tron.you_receive')}</Text>
        </View>
        <View style={styles.line}>
          <View style={styles.field}>
            <View style={styles.assetStatic}>
              {assetIcon(other(sell))}
              <Text style={styles.assetSym}>{other(sell)}</Text>
            </View>
            <Text {...FIT} style={[styles.receive, !quote && styles.receiveEmpty]}>
              {quote ? `≈ ${fmt(quote.receive)}` : '0'}
            </Text>
            {quoting ? <ActivityIndicator size="small" color={c.subtext} /> : null}
          </View>
        </View>
      </View>

      {err ? <Text style={styles.err}>{err}</Text> : null}
      {noTrx ? <Text style={styles.err}>{t('mobile.tron.swap_no_trx', {amount: fmt(trxNeeded)})}</Text> : null}
      {!open ? <Text style={styles.hint}>{t('mobile.tron.swap_closed')}</Text> : null}
      {cost?.needsApproval ? <Text style={styles.hint}>{t('mobile.tron.swap_approve_note')}</Text> : null}

      <View style={styles.footer}>
        <View style={styles.feeLine}>
          <Text style={styles.feeLabel}>{t('mobile.tron.swapped_by')}</Text>
          <ProtocolChip name="SunSwap" size={16} />
        </View>
        <View style={styles.feeLine}>
          <Text style={styles.feeLabel}>
            {t('mobile.bridge.bitty_fee')} <Text style={styles.feeStrong}>{pct}</Text>
          </Text>
          {quote && quote.feeSun > 0n ? <Text style={styles.feeValue}>{`${fmt(quote.feeSun)} TRX`}</Text> : null}
        </View>
        {cost ? (
          <View style={styles.feeLine}>
            <Text style={styles.feeLabel}>{t('mobile.tron.network_fee')}</Text>
            <Text style={styles.feeValue}>{t('mobile.tron.fee_trx', {amount: fmt(cost.burnSun)})}</Text>
          </View>
        ) : null}
        {quote ? (
          <View style={styles.feeLine}>
            <Text style={styles.feeLabel}>{t('mobile.tron.min_receive')}</Text>
            <Text style={styles.feeValue}>{`${fmt(sell === 'USDT' ? quote.minOut - quote.feeSun : quote.minOut)} ${other(sell)}`}</Text>
          </View>
        ) : null}
        <ConfirmButton fee={false} loading={sending} disabled={!canSwap} onPress={() => void swap()} />
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {paddingHorizontal: 16, gap: 20},
    card: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    cardHead: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    cardTitle: {color: c.text, fontSize: 15, fontWeight: '700'},
    line: {gap: 4, paddingHorizontal: 16, paddingVertical: 8},
    field: {flexDirection: 'row', alignItems: 'center', height: 48, gap: 8},
    assetPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10},
    assetStatic: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7},
    assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
    input: {flex: 1, minWidth: 0, color: c.text, fontSize: 22, fontWeight: '600', paddingVertical: 0},
    inputOver: {color: c.danger},
    receive: {flex: 1, textAlign: 'right', color: c.text, fontSize: 22, fontWeight: '600'},
    receiveEmpty: {color: c.subtext},
    maxBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 124},
    balInline: {color: c.subtext, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
    maxBadge: {color: c.accent, backgroundColor: c.accentSoft, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden'},
    flipBtn: {alignSelf: 'center', width: 36, height: 36, borderRadius: 18, backgroundColor: c.input, borderWidth: 3, borderColor: c.bg, alignItems: 'center', justifyContent: 'center', marginVertical: -8},
    err: {color: c.danger, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    hint: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    footer: {gap: 8},
    feeLine: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 4},
    feeLabel: {color: c.subtext, fontSize: 13},
    feeStrong: {color: c.text, fontWeight: '600'},
    feeValue: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums']},
  });

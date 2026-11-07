import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import {formatUnits, parseUnits} from 'viem';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors, MONO} from '@/theme';
import {useNetwork} from '@/core/network-store';
import {fmtNum} from '@/core/format';
import {ConfirmButton} from '@/components/Button';
import {GasIcon} from '@/components/GasIcon';
import {ClearBtn} from '@/components/ClearBtn';
import {Sheet} from '@/components/Sheet';
import {QrScanner} from '@/components/QrScanner';
import {ScanButton} from '@/components/ScanIcon';
import {TokenIcon} from '@/components/TokenIcon';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {useToasts} from '@/components/Toast';
import {useTronWallet} from '@/tron/store';
import {isTronAddress, tronAddressInQr} from '@/tron/address';
import {balances, estimateFee, trxUsd, txStatus, type TronBalance, type TronFee} from '@/tron/client';
import {fmtUsd} from '@/core/prices';
import {sendTron, UnlockCancelled} from '@/tron/send';
import {TRON_ASSETS, TRON_EXPLORER_TX, type TronAsset} from '@/tron/config';

/** The amount typed, in base units; null while it is not a positive number this asset can hold. */
function parseAmount(text: string, decimals: number): bigint | null {
  const s = text.trim().replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  try {
    const v = parseUnits(s, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

const trxText = (sun: bigint) => fmtNum(Number(formatUnits(sun, 6)));

/**
 * Pay from the Tron wallet: TRX or USDT, to any Tron address.
 *
 * There is no address book and no allowance here — those are the vault's, and Tron has no vault —
 * so what protects the user is the confirmation itself: the recipient checked as a real Tron
 * address (Base58Check, so a typo fails), the full fee shown before Face ID, and the send refused
 * when the wallet's TRX cannot pay that fee, rather than broadcast to fail on chain.
 */
export function TronSendScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'TronSend'>>();
  const net = useNetwork((s) => s.tron) ?? 'tron';
  const from = useTronWallet((s) => s.address);
  const assets = TRON_ASSETS[net];

  const [symbol, setSymbol] = useState(route.params?.symbol ?? 'USDT');
  const asset: TronAsset = assets.find((a) => a.symbol === symbol) ?? assets[0];
  const [held, setHeld] = useState<TronBalance[] | null>(null);
  const [to, setTo] = useState('');
  const [amountText, setAmountText] = useState('');
  const [scanning, setScanning] = useState(false);
  const [fee, setFee] = useState<TronFee | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [toFocused, setToFocused] = useState(false);
  const screenHeight = useWindowDimensions().height;

  useEffect(() => {
    if (from) balances(net, from).then(setHeld, () => setHeld(null));
  }, [net, from]);

  const balanceOf = (s: string) => held?.find((b) => b.asset.symbol === s)?.raw ?? 0n;
  const balance = balanceOf(asset.symbol);
  const trxBalance = balanceOf('TRX');

  const toTrim = to.trim();
  const toValid = isTronAddress(toTrim);
  const toSelf = toValid && toTrim === from;
  const amount = parseAmount(amountText, asset.decimals);
  const overBalance = amount != null && amount > balance;

  // The fee for exactly this send, re-estimated as its inputs settle. A token transfer is simulated
  // for its energy, which needs a real amount the wallet holds; TRX only needs the recipient.
  const estAmount = asset.contract ? (amount != null && !overBalance ? amount : null) : (amount ?? 1n);
  useEffect(() => {
    setFee(null);
    setFeeError(null);
    if (!from || !toValid || toSelf || estAmount == null) return;
    let live = true;
    setEstimating(true);
    const id = setTimeout(() => {
      estimateFee(net, from, toTrim, asset, estAmount)
        .then((f) => live && setFee(f))
        .catch((e: Error) => live && setFeeError(e.message))
        .finally(() => live && setEstimating(false));
    }, 400);
    return () => {
      live = false;
      clearTimeout(id);
      setEstimating(false);
    };
  }, [net, from, toTrim, toValid, toSelf, asset, estAmount]);

  // What the wallet's TRX has to cover: the fee, and for a TRX send the amount as well.
  const trxNeeded = fee ? fee.burnSun + (asset.contract ? 0n : amount ?? 0n) : null;
  const noTrxForFee = trxNeeded != null && trxNeeded > trxBalance;
  // Max for TRX leaves the fee behind; before the fee is known, a conservative 1.1 TRX (an activation's worth).
  const maxRaw = asset.contract ? balance : balance - (fee ? fee.burnSun : 1_100_000n);
  const max = maxRaw > 0n ? formatUnits(maxRaw, asset.decimals) : '0';

  const canSend = !!from && toValid && !toSelf && amount != null && !overBalance && !!fee && !noTrxForFee && !sending;

  const send = async () => {
    if (!canSend || !from || amount == null || !fee) return;
    Keyboard.dismiss();
    setSending(true);
    const title = t('mobile.tron.send_toast', {amount: fmtNum(Number(formatUnits(amount, asset.decimals))), symbol: asset.symbol});
    const toasts = useToasts.getState();
    const id = toasts.show({kind: 'pending', title});
    try {
      const txID = await sendTron({net, from, to: toTrim, asset, amount, fee});
      // The hash, which the toast shows and opens on Tronscan, as an EVM send's does on its explorer.
      toasts.update(id, {kind: 'pending', hash: txID, explorer: {url: TRON_EXPLORER_TX[net], name: 'Tronscan'}});
      nav.goBack();
      void followUp(id, txID);
    } catch (e) {
      if (e instanceof UnlockCancelled) toasts.dismiss(id);
      else toasts.update(id, {kind: 'error', detail: (e as Error).message});
    } finally {
      setSending(false);
    }
  };

  /** Tron confirms in about three seconds; watch for a minute, then leave it to the activity list. */
  const followUp = async (id: number, txID: string) => {
    const toasts = useToasts.getState();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await txStatus(net, txID).catch(() => 'pending' as const);
      if (s === 'success') return toasts.update(id, {kind: 'success', detail: undefined});
      if (s === 'failed') return toasts.update(id, {kind: 'error', detail: t('mobile.tron.failed_on_chain')});
    }
    toasts.update(id, {kind: 'success', detail: t('mobile.tron.submitted')});
  };

  // TRX's price, so a fee reads as money and not only as a number of a coin few people price in
  // their head. At the real coin's price on Nile too, as the wallet's own total is.
  const [trxPrice, setTrxPrice] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    trxUsd().then((p) => live && setTrxPrice(p), () => {});
    return () => {
      live = false;
    };
  }, []);
  /** "1.27 TRX (≈ $0.36)", or the TRX alone until the price is in. */
  const withUsd = (sun: bigint, text: string) => {
    if (trxPrice == null) return text;
    return `${text} (${fmtUsd(Number(formatUnits(sun, 6)) * trxPrice, {cents: true})})`;
  };

  const feeLine = useMemo(() => {
    if (feeError) return {text: t('mobile.tron.fee_failed', {reason: feeError}), danger: true};
    if (!fee) return null;
    if (fee.burnSun === 0n) return {text: t('mobile.tron.fee_free'), danger: false};
    return {text: withUsd(fee.burnSun, t('mobile.tron.fee_trx', {amount: trxText(fee.burnSun)})), danger: false};
    // eslint-disable-next-line react-hooks/exhaustive-deps -- withUsd reads trxPrice, listed
  }, [fee, feeError, t, trxPrice]);

  return (
    <>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.body}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>{t('mobile.tron.to')}</Text>
        <View style={[styles.card, styles.toRow]}>
          {/* A checked address, while not being edited, is one line of the WHOLE address that gives
              up only its middle when the row is too narrow, ellipsis in the middle, never a fixed
              cut: what fits is shown. A TextInput cannot ellipsize, so that line is a Text, and a
              tap swaps the field back in to change it. */}
          {toValid && !toFocused ? (
            <Pressable style={styles.inputWrap} onPress={() => setToFocused(true)} accessibilityRole="button" accessibilityLabel={toTrim}>
              <Text style={[styles.input, styles.inputText, toSelf && styles.inputErr]} numberOfLines={1} ellipsizeMode="middle">
                {toTrim}
              </Text>
            </Pressable>
          ) : (
            <TextInput
              style={[styles.input, toTrim.length > 0 && (!toValid || toSelf) && styles.inputErr]}
              placeholder={t('mobile.vault.enter_address')}
              placeholderTextColor={c.subtext}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={toFocused}
              value={to}
              onFocus={() => setToFocused(true)}
              onBlur={() => setToFocused(false)}
              onChangeText={setTo}
            />
          )}
          <ScanButton onPress={() => setScanning(true)} />
        </View>
        {toTrim.length > 0 && !toValid ? <Text style={styles.err}>{t('mobile.tron.bad_address')}</Text> : null}
        {toSelf ? <Text style={styles.err}>{t('mobile.tron.own_address')}</Text> : null}

        {/* As the EVM send: the asset pill and the amount on the left, and at the end one control —
            what can be sent with a Max badge while the field is empty, a clear once it is not.
            The pill opens the choice of asset. */}
        <View style={[styles.card, styles.amountCard]}>
          <View style={styles.field}>
            <Pressable style={styles.assetPill} onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel={t('vault.select_asset')}>
              {asset.contract ? <TokenIcon symbol={asset.symbol} size={20} /> : <NetworkIcon network={net} size={20} />}
              <Text style={styles.assetSym}>{asset.symbol}</Text>
            </Pressable>
            <TextInput
              style={[styles.fieldInput, overBalance && styles.inputErr]}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={c.subtext}
              value={amountText}
              selectTextOnFocus
              onChangeText={setAmountText}
            />
            {Number(amountText) > 0 ? (
              <ClearBtn onPress={() => setAmountText('')} />
            ) : held && Number(max) > 0 ? (
              <Pressable style={styles.maxBtn} onPress={() => setAmountText(max)} hitSlop={8}>
                <Text style={styles.balInline} numberOfLines={1}>
                  {fmtNum(Number(max))}
                </Text>
                <Text style={styles.maxBadge}>{t('common.max')}</Text>
              </Pressable>
            ) : null}
          </View>
          {overBalance ? <Text style={styles.over}>{t('vault.exceeds_balance')}</Text> : null}
        </View>

        {noTrxForFee ? <Text style={styles.err}>{t('mobile.tron.no_trx_for_fee', {amount: trxText(trxNeeded ?? 0n)})}</Text> : null}

        {/* The fee as every EVM confirm shows it: a pump and a figure, at the right, just above the
            button that spends it. The one thing it cannot say alone — that part of it activates a
            brand-new address — rides on the line above. */}
        <View style={styles.confirm}>
          {fee && fee.activationSun > 0n ? <Text style={styles.feeNote}>{t('mobile.tron.fee_activation', {amount: trxText(fee.activationSun)})}</Text> : null}
          {estimating ? (
            <View style={styles.feeRow}>
              <ActivityIndicator color={c.subtext} size="small" />
            </View>
          ) : feeLine ? (
            <View style={styles.feeRow}>
              <GasIcon color={feeLine.danger ? c.danger : c.subtext} />
              <Text style={[styles.feeValue, feeLine.danger && styles.errText]} numberOfLines={2}>
                {feeLine.text}
              </Text>
            </View>
          ) : null}
          <ConfirmButton fee={false} loading={sending} disabled={!canSend} onPress={() => void send()} />
        </View>
      </ScrollView>
      <Sheet visible={picking} title={t('vault.select_asset')} onClose={() => setPicking(false)} height={Math.round(screenHeight * 0.38)}>
        {assets.map((a) => (
          <Pressable
            key={a.symbol}
            style={styles.pickRow}
            onPress={() => {
              if (a.symbol !== asset.symbol) setAmountText('');
              setSymbol(a.symbol);
              setPicking(false);
            }}>
            {a.contract ? <TokenIcon symbol={a.symbol} size={30} /> : <NetworkIcon network={net} size={30} />}
            <Text style={styles.pickLabel}>{a.symbol}</Text>
            <Text style={styles.pickSub}>{held ? fmtNum(Number(formatUnits(balanceOf(a.symbol), a.decimals))) : '…'}</Text>
            {a.symbol === asset.symbol ? (
              <Svg width={18} height={18} viewBox="0 0 24 24">
                <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </Svg>
            ) : null}
          </Pressable>
        ))}
      </Sheet>
      <QrScanner
        visible={scanning}
        parse={tronAddressInQr}
        onScan={(a) => {
          setScanning(false);
          setTo(a);
        }}
        onClose={() => setScanning(false)}
      />
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, paddingBottom: 40},
    label: {color: c.subtext, fontSize: 13, fontWeight: '600', marginTop: 20, marginBottom: 8, paddingHorizontal: 4},
    // The EVM send's amount row, measure for measure (SendScreen's line / field / assetPill / maxBtn).
    amountCard: {marginTop: 16, gap: 4, paddingHorizontal: 16, paddingVertical: 8},
    field: {flexDirection: 'row', alignItems: 'center', height: 48, gap: 8},
    fieldInput: {flex: 1, minWidth: 0, color: c.text, fontSize: 17, paddingVertical: 0},
    assetPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10},
    assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
    maxBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 124},
    balInline: {color: c.subtext, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
    maxBadge: {color: c.accent, backgroundColor: c.accentSoft, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden'},
    over: {color: c.danger, fontSize: 12, paddingBottom: 4},
    pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    pickLabel: {flex: 1, color: c.text, fontSize: 15, fontWeight: '600'},
    pickSub: {color: c.subtext, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
    card: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    toRow: {flexDirection: 'row', alignItems: 'stretch'},
    input: {flex: 1, minHeight: 52, color: c.text, paddingLeft: 16, paddingVertical: 14, fontSize: 15, fontFamily: MONO},
    inputErr: {color: c.danger},
    inputWrap: {flex: 1, minWidth: 0, justifyContent: 'center'},
    inputText: {flex: 0, paddingRight: 4},
    err: {color: c.danger, fontSize: 12, lineHeight: 17, marginTop: 6, paddingHorizontal: 16},
    errText: {color: c.danger},
    // The EVM confirm's own measurements (Button's confirmWrap, NetworkFee's row).
    confirm: {marginTop: 24, gap: 8},
    feeRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5, paddingRight: 4},
    feeValue: {color: c.subtext, fontSize: 12, flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums']},
    feeNote: {color: c.subtext, fontSize: 12, lineHeight: 17, textAlign: 'right', paddingRight: 4},
  });

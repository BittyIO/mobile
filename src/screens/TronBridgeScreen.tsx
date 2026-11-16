import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import Svg, {Path} from 'react-native-svg';
import {formatUnits, parseUnits} from 'viem';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {FIT} from '@/core/text-scale';
import {fmtNum} from '@/core/format';
import {NETWORK_LABEL, useNetwork} from '@/core/network-store';
import {useVaults} from '@/core/vault-store';
import {activeVaultAddress} from '@/core/active-vault';
import type {Network} from '@/core/chain';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {ConfirmButton} from '@/components/Button';
import {ClearBtn} from '@/components/ClearBtn';
import {Sheet} from '@/components/Sheet';
import {TokenIcon} from '@/components/TokenIcon';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {ProtocolChip} from '@/components/ProtocolIcon';
import {useToasts} from '@/components/Toast';
import {useTronWallet} from '@/tron/store';
import {balances, type TronBalance} from '@/tron/client';
import {UnlockCancelled} from '@/tron/send';
import {TRON_EXPLORER_TX, TRON_LABEL} from '@/tron/config';
import {
  bridgeFromTron,
  estimateTronBridge,
  quoteTronBridge,
  TRON_BRIDGE_DESTINATIONS,
  TRON_BRIDGE_FEE_BPS,
  TronBridgeError,
  type TronBridgeCost,
  type TronBridgeQuote,
} from '@/tron/bridge';

const fmt6 = (raw: bigint) => fmtNum(Number(formatUnits(raw, 6)));
const short = (a: string) => `${a.slice(0, 8)}...${a.slice(-6)}`;

function parseUsdt(text: string): bigint | null {
  const s = text.trim().replace(',', '.');
  if (!s || !/^\d*\.?\d*$/.test(s)) return null;
  const [, frac = ''] = s.split('.');
  if (frac.length > 6) return null;
  try {
    const v = parseUnits(s, 6);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * Bridge from the Tron wallet: USDT on Tron to the owner's vault on an EVM network, by Across (see
 * tron/bridge). The Bridge tab's layout: From (Tron, the header's network), To (a vault network),
 * then who carries it and the fees. There is no flip: nothing bridges back to the Tron wallet.
 */
export function TronBridgeScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {height: screenHeight} = useWindowDimensions();
  const net = useNetwork((s) => s.tron) ?? 'tron';
  const from = useTronWallet((s) => s.address);
  // Re-render when the vault in front changes: it is who receives.
  useVaults((s) => s.activeIndex);
  const headerHeight = useTransparentHeaderInset();
  const tabBarHeight = useBottomTabBarHeight();

  const [to, setTo] = useState<Network>(TRON_BRIDGE_DESTINATIONS[0]);
  const [picking, setPicking] = useState(false);
  const [amount, setAmount] = useState('');
  const [held, setHeld] = useState<TronBalance[] | null>(null);
  const [quote, setQuote] = useState<TronBridgeQuote | null>(null);
  const [cost, setCost] = useState<TronBridgeCost | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [pulled, setPulled] = useState(false);

  const loadBalances = useCallback(() => {
    if (!from) return;
    balances(net, from).then(setHeld, () => {});
  }, [from, net]);
  useFocusEffect(loadBalances);

  const usdt = held?.find((b) => b.asset.symbol === 'USDT')?.raw ?? 0n;
  const trx = held?.find((b) => b.asset.symbol === 'TRX')?.raw ?? 0n;
  const raw = parseUsdt(amount);
  const over = raw != null && raw > usdt;
  const recipient = activeVaultAddress(to);

  useEffect(() => {
    setQuote(null);
    setCost(null);
    setErr(null);
    // Quoted over the balance too, so what an amount would bring is seen before there is enough; Confirm stays off.
    if (!from || raw == null || !recipient) return;
    let live = true;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const q = await quoteTronBridge(net, from, to, raw, recipient);
        if (!live) return;
        setQuote(q);
        // Over the balance the deposit cannot be simulated (it would revert): the quote alone.
        if (over) return;
        const k = await estimateTronBridge(net, from, q);
        if (live) setCost(k);
      } catch (e) {
        if (!live) return;
        if (e instanceof TronBridgeError) {
          setErr(
            e.key === 'too_low'
              ? t('mobile.bridge.too_low', {min: fmt6(BigInt(e.params.min ?? '0')), symbol: 'USDT'})
              : e.key === 'too_high'
                ? t('mobile.bridge.too_high', {max: fmt6(BigInt(e.params.max ?? '0')), symbol: 'USDT'})
                : t('mobile.bridge.quote_failed'),
          );
        } else setErr((e as Error).message);
      } finally {
        if (live) setQuoting(false);
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, net, to, amount, over, recipient, quoteNonce]);

  // Pull to refresh, as on Trade: the wallet's balances and the quote. The spinner clears on its own.
  const onPull = () => {
    setPulled(true);
    loadBalances();
    setQuoteNonce((n) => n + 1);
    setTimeout(() => setPulled(false), 1200);
  };

  // Every Tron fee is TRX: the deposit's network fee, and Bitty's fee after it.
  const trxNeeded = (cost?.burnSun ?? 0n) + (quote?.feeSun ?? 0n);
  const noTrx = !!cost && trxNeeded > trx;
  const can = !!from && !!quote && !!cost && !over && !noTrx && !sending;

  const bridge = async () => {
    if (!can || !from || !quote || !cost) return;
    Keyboard.dismiss();
    setSending(true);
    const toasts = useToasts.getState();
    const id = toasts.show({kind: 'pending', title: `${t('mobile.bridge.tab')} ${fmt6(quote.amount)} USDT → ${NETWORK_LABEL[quote.to]}`});
    try {
      await bridgeFromTron({
        net,
        from,
        quote,
        cost,
        onSent: (txID) => toasts.update(id, {kind: 'pending', hash: txID, explorer: {url: TRON_EXPLORER_TX[net], name: 'Tronscan'}}),
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

  const fillTime = (s: number) => (s < 90 ? t('mobile.bridge.seconds', {n: Math.max(1, Math.round(s))}) : t('mobile.bridge.minutes', {n: Math.round(s / 60)}));
  const received = quote ? fmtNum(Number(formatUnits(quote.outputAmount, quote.outputDecimals))) : null;

  return (
    <>
      <ScrollView
        style={styles.container}
        keyboardShouldPersistTaps="handled"
        contentInset={{top: headerHeight}}
        contentOffset={{x: 0, y: -headerHeight}}
        scrollIndicatorInsets={{top: headerHeight}}
        automaticallyAdjustContentInsets={false}
        refreshControl={<RefreshControl refreshing={pulled} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}
        contentContainerStyle={[styles.body, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}>
        {/* From: the Tron wallet, picked in the header; USDT, the one coin Across carries from Tron. */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{t('mobile.bridge.from')}</Text>
            <View style={styles.netStatic}>
              <NetworkIcon network={net} size={18} />
              <Text {...FIT} style={styles.netName}>{TRON_LABEL[net]}</Text>
            </View>
          </View>
          <View style={styles.line}>
            <View style={styles.field}>
              <View style={styles.assetStatic}>
                <TokenIcon symbol="USDT" size={20} />
                <Text style={styles.assetSym}>USDT</Text>
              </View>
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
              ) : usdt > 0n ? (
                <Pressable style={styles.maxBtn} onPress={() => setAmount(formatUnits(usdt, 6))} hitSlop={8}>
                  <Text style={styles.balInline} numberOfLines={1}>{fmt6(usdt)}</Text>
                  <Text style={styles.maxBadge}>{t('vault.max')}</Text>
                </Pressable>
              ) : null}
            </View>
            {over ? <Text style={styles.err}>{t('vault.exceeds_balance')}</Text> : null}
          </View>
        </View>

        <View style={styles.arrow}>
          <Svg width={18} height={18} viewBox="0 0 24 24">
            <Path d="M12 5v14M6 13l6 6 6-6" stroke={c.subtext} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </View>

        {/* To: the vault in front, on the network picked here, and about what arrives. */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{t('mobile.bridge.to')}</Text>
            <Pressable onPress={() => setPicking(true)} hitSlop={6} style={({pressed}) => [styles.netPill, pressed && styles.pressed]} accessibilityRole="button">
              <NetworkIcon network={to} size={18} />
              <Text {...FIT} style={styles.netName}>{NETWORK_LABEL[to]}</Text>
            </Pressable>
            <View style={styles.spacer} />
            {quote?.fillSeconds ? (
              <Text {...FIT} style={styles.arrival}>
                {t('mobile.bridge.arrival_time')} <Text style={styles.arrivalValue}>{fillTime(quote.fillSeconds)}</Text>
              </Text>
            ) : null}
          </View>
          <View style={styles.line}>
            <View style={styles.field}>
              <View style={styles.assetStatic}>
                <TokenIcon symbol="USDT" size={20} />
                <Text style={styles.assetSym}>USDT</Text>
              </View>
              <Text {...FIT} style={[styles.receive, !quote && styles.receiveEmpty]}>
                {received ? `≈ ${received}` : '0'}
              </Text>
              {quoting ? <ActivityIndicator size="small" color={c.subtext} /> : null}
            </View>
            {recipient ? <Text style={styles.toVault}>{t('mobile.tron.bridge_to_vault', {address: short(recipient)})}</Text> : null}
          </View>
        </View>

        {!recipient ? <Text style={styles.err}>{t('mobile.tron.bridge_no_vault', {network: NETWORK_LABEL[to]})}</Text> : null}
        {err ? <Text style={styles.err}>{err}</Text> : null}
        {noTrx ? <Text style={styles.err}>{t('mobile.tron.bridge_no_trx', {amount: fmt6(trxNeeded)})}</Text> : null}
        {cost?.needsApproval ? <Text style={styles.hint}>{t('mobile.tron.bridge_approve_note')}</Text> : null}

        <View style={styles.footer}>
          <View style={styles.feeLine}>
            <Text style={styles.feeLabel}>{t('mobile.bridge.protocol')}</Text>
            <ProtocolChip name="Across" size={16} />
          </View>
          <View style={styles.feeLine}>
            <Text style={styles.feeLabel}>
              {t('mobile.bridge.bitty_fee')} <Text style={styles.feeStrong}>{`${Number(TRON_BRIDGE_FEE_BPS) / 100}%`}</Text>
            </Text>
            {quote && quote.feeSun > 0n ? <Text style={styles.feeValue}>{`≈ ${fmt6(quote.feeSun)} TRX`}</Text> : null}
          </View>
          {cost ? (
            <View style={styles.feeLine}>
              <Text style={styles.feeLabel}>{t('mobile.tron.network_fee')}</Text>
              <Text style={styles.feeValue}>{t('mobile.tron.fee_trx', {amount: fmt6(cost.burnSun)})}</Text>
            </View>
          ) : null}
          <ConfirmButton fee={false} loading={sending} disabled={!can} onPress={() => void bridge()} />
        </View>
      </ScrollView>

      <Sheet visible={picking} title={t('mobile.bridge.to')} onClose={() => setPicking(false)} height={Math.round(screenHeight * 0.5)}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {TRON_BRIDGE_DESTINATIONS.map((n) => (
            <Pressable key={n} style={styles.pickRow} onPress={() => (setTo(n), setPicking(false))}>
              <NetworkIcon network={n} size={30} />
              <Text style={styles.pickLabel}>{NETWORK_LABEL[n]}</Text>
              {n === to ? (
                <Svg width={18} height={18} viewBox="0 0 24 24">
                  <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </Svg>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {paddingHorizontal: 16, gap: 20},
    card: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    cardHead: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    cardTitle: {color: c.text, fontSize: 15, fontWeight: '700'},
    spacer: {flex: 1},
    netStatic: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, paddingVertical: 5},
    netPill: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, backgroundColor: c.neutralSoft, borderRadius: 16, paddingVertical: 5, paddingHorizontal: 10},
    pressed: {opacity: 0.6},
    netName: {color: c.text, fontSize: 14, fontWeight: '600', flexShrink: 1},
    arrival: {color: c.subtext, fontSize: 13, flexShrink: 1},
    arrivalValue: {color: c.text, fontWeight: '600'},
    line: {gap: 4, paddingHorizontal: 16, paddingVertical: 8},
    field: {flexDirection: 'row', alignItems: 'center', height: 48, gap: 8},
    assetStatic: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7},
    assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
    input: {flex: 1, minWidth: 0, color: c.text, fontSize: 22, fontWeight: '600', paddingVertical: 0},
    inputOver: {color: c.danger},
    receive: {flex: 1, textAlign: 'right', color: c.text, fontSize: 22, fontWeight: '600'},
    receiveEmpty: {color: c.subtext},
    toVault: {color: c.subtext, fontSize: 12, paddingBottom: 4},
    maxBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 124},
    balInline: {color: c.subtext, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
    maxBadge: {color: c.accent, backgroundColor: c.accentSoft, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden'},
    arrow: {alignSelf: 'center', width: 36, height: 36, borderRadius: 18, backgroundColor: c.input, borderWidth: 3, borderColor: c.bg, alignItems: 'center', justifyContent: 'center', marginVertical: -8},
    err: {color: c.danger, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    hint: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    footer: {gap: 8},
    feeLine: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 4},
    feeLabel: {color: c.subtext, fontSize: 13},
    feeStrong: {color: c.text, fontWeight: '600'},
    feeValue: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums']},
    pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    pickLabel: {flex: 1, color: c.text, fontSize: 15, fontWeight: '600'},
  });

import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import {formatUnits, parseUnits, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {NATIVE} from '@/core/chain';
import {displayAddress, parseAddress} from '@/core/address';
import {networkLabel, useNetwork} from '@/core/network-store';
import {useActiveAccount} from '@/core/account-mode';
import {fmtNum, fmtShort, shortAddress} from '@/core/format';
import {fmtValue, usdValue} from '@/core/prices';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {usePrices} from '@/vault/usePrices';
import {formatNative} from '@/vault/direct';
import {useWallet} from '@/wallet/store';
import {recordSent} from '@/wallet/sent-log';
import {maxNativeSend, planWalletTransfer, sendWalletTransfer, type WalletAsset} from '@/wallet/send';
import {TokenIcon} from '@/components/TokenIcon';
import {ScanButton} from '@/components/ScanIcon';
import {QrScanner} from '@/components/QrScanner';
import {Sheet} from '@/components/Sheet';
import {showTx} from '@/components/Toast';
import {useT} from '@/i18n';
import {MONO, useColors, useStyles, type Colors} from '@/theme';

type Held = WalletAsset & {raw: bigint; label: string};

/**
 * Send from the WALLET: one recipient, one asset, the wallet's own network fee.
 *
 * The vault's Send (SendScreen) is a different thing — a payee book, the guard's allowances, a fee
 * billed in a stablecoin — none of which a plain address has. This is the ordinary wallet form:
 * address, asset, amount, and the fee in the chain's coin before anything is signed.
 */
export function WalletSendScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const {params} = useRoute<RouteProp<RootStackParamList, 'WalletSend'>>();
  const network = useNetwork((s) => s.network);
  const account = useActiveAccount(network);
  const from = account.wallet;
  const bal = useVaultBalances(network);
  const prices = usePrices(network);
  const native = NATIVE[network];

  /**
   * What the wallet holds, as separate things to send: the chain's coin, and each token. The
   * balance read folds the coin into its wrapped row (a vault's habit — it wraps on receipt), so
   * the wrapped token's own balance is that row less the coin.
   */
  const held = useMemo<Held[]>(() => {
    const b = bal.balances;
    if (!b) return [];
    const coin: Held = {symbol: native.symbol, address: 'native', decimals: native.decimals, raw: b.native.raw, label: native.symbol};
    const tokens = b.tokens
      .map((x): Held => {
        const raw = x.symbol === native.wrapped ? x.raw - b.native.raw : x.raw;
        return {symbol: x.symbol, address: x.address as Address, decimals: x.decimals, raw, label: x.symbol};
      })
      .filter((x) => x.raw > BigInt(0));
    return [coin, ...tokens];
  }, [bal.balances, native]);

  const [toText, setToText] = useState(params?.to ? displayAddress(network, params.to) : '');
  const [symbol, setSymbol] = useState<string>(params?.symbol ?? native.symbol);
  const [amount, setAmount] = useState('');
  const [picking, setPicking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [fee, setFee] = useState<{cost: bigint} | null>(null);
  const [feeState, setFeeState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [sending, setSending] = useState(false);

  const asset = held.find((h) => h.symbol === symbol) ?? held[0];
  const to = parseAddress(network, toText);
  const badAddress = toText.trim().length > 0 && !to;
  const raw = useMemo(() => {
    if (!asset || !amount) return null;
    try {
      return parseUnits(amount.replace(',', '.'), asset.decimals);
    } catch {
      return null;
    }
  }, [amount, asset]);

  // The fee, re-asked whenever what would be sent changes; a little after the last keystroke.
  useEffect(() => {
    setFee(null);
    if (!from || !to || !asset || !raw || raw <= BigInt(0)) {
      setFeeState('idle');
      return;
    }
    setFeeState('busy');
    let live = true;
    const id = setTimeout(() => {
      planWalletTransfer({network, from, to, asset, amount: raw})
        .then((p) => live && (setFee({cost: p.cost}), setFeeState('idle')))
        .catch(() => live && setFeeState('failed'));
    }, 450);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [network, from, to, asset, raw]);

  const nativeHeld = held[0]?.raw ?? BigInt(0);
  const short =
    !!asset && !!raw && (raw > asset.raw || (!!fee && (asset.address === 'native' ? raw + fee.cost > nativeHeld : fee.cost > nativeHeld)));
  const shortSymbol = asset && raw && raw > asset.raw ? asset.label : native.symbol;
  const canSend = !!from && !!to && !!asset && !!raw && raw > BigInt(0) && !!fee && !short && !sending;

  const setMax = async () => {
    if (!asset || !from) return;
    if (asset.address !== 'native') return setAmount(formatUnits(asset.raw, asset.decimals));
    const max = await maxNativeSend(network, from, to ?? from);
    setAmount(formatUnits(max, asset.decimals));
  };

  const send = async () => {
    if (!canSend || !from || !to || !asset || !raw) return;
    setSending(true);
    const tx = showTx(`${t('vault.send')} ${fmtShort(Number(formatUnits(raw, asset.decimals)))} ${asset.label}`, network);
    try {
      const signer = await useWallet.getState().walletSigner();
      const {hash} = await sendWalletTransfer({account: signer, network, from, to, asset, amount: raw});
      recordSent({hash, network, from, to, symbol: asset.address === 'native' ? native.wrapped : asset.symbol, token: asset.address === 'native' ? null : asset.address, amount: formatUnits(raw, asset.decimals)});
      tx.success(hash);
      bal.refresh();
      nav.goBack();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/cancel/i.test(msg)) tx.done();
      else tx.error(msg);
    } finally {
      setSending(false);
    }
  };

  const feeUsd = fee ? usdValue(Number(formatUnits(fee.cost, native.decimals)), native.wrapped, prices) : null;
  const vault = account.vault;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
        <Text style={styles.label}>{t('mobile.account.to')}</Text>
        <View style={styles.card}>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={toText}
              onChangeText={setToText}
              placeholder={t('mobile.account.to_placeholder')}
              placeholderTextColor={c.subtext}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <ScanButton onPress={() => setScanning(true)} />
          </View>
          {badAddress ? <Text style={styles.error}>{t('mobile.account.bad_address', {network: networkLabel(network, t)})}</Text> : null}
          {vault ? (
            <Pressable style={styles.chip} onPress={() => setToText(displayAddress(network, vault))} accessibilityRole="button">
              <Text style={styles.chipText}>
                {t('mobile.account.my_vault')} · {shortAddress(vault)}
              </Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.label}>{t('mobile.account.asset')}</Text>
        <Pressable style={[styles.card, styles.assetRow]} onPress={() => setPicking(true)} accessibilityRole="button">
          {asset ? <TokenIcon symbol={asset.address === 'native' ? native.wrapped : asset.symbol} size={30} /> : <ActivityIndicator color={c.subtext} />}
          <View style={styles.assetText}>
            <Text style={styles.assetSymbol}>{asset?.label ?? '—'}</Text>
            <Text style={styles.sub}>{asset ? fmtNum(Number(formatUnits(asset.raw, asset.decimals))) : ''}</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Text style={styles.label}>{t('mobile.account.amount')}</Text>
        <View style={[styles.card, styles.inputRow]}>
          <TextInput
            style={[styles.input, styles.amount]}
            value={amount}
            onChangeText={setAmount}
            placeholder="0"
            placeholderTextColor={c.subtext}
            keyboardType="decimal-pad"
          />
          <Pressable onPress={setMax} hitSlop={8} style={styles.max} accessibilityRole="button">
            <Text style={styles.maxText}>{t('mobile.account.max')}</Text>
          </Pressable>
        </View>
        {short ? <Text style={styles.error}>{t('mobile.account.not_enough', {symbol: shortSymbol})}</Text> : null}

        <View style={styles.feeRow}>
          <Text style={styles.sub}>{t('mobile.account.fee')}</Text>
          <Text style={styles.feeValue}>
            {feeState === 'busy'
              ? t('mobile.account.fee_estimating')
              : fee
                ? `${formatNative(network, fee.cost)} ${native.symbol}${feeUsd != null ? ` · ${fmtValue(feeUsd)}` : ''}`
                : '—'}
          </Text>
        </View>
        {feeState === 'failed' ? <Text style={styles.error}>{t('mobile.account.fee_failed')}</Text> : null}
      </ScrollView>

      <Pressable style={[styles.button, !canSend && styles.buttonOff]} disabled={!canSend} onPress={send} accessibilityRole="button">
        {sending ? <ActivityIndicator color={c.onAccent} /> : <Text style={styles.buttonText}>{t('vault.send')}</Text>}
      </Pressable>

      <Sheet visible={picking} title={t('mobile.account.asset')} onClose={() => setPicking(false)}>
        <ScrollView>
          {held.map((h) => (
            <Pressable
              key={h.symbol}
              style={styles.pickRow}
              onPress={() => {
                setSymbol(h.symbol);
                setAmount('');
                setPicking(false);
              }}>
              <TokenIcon symbol={h.address === 'native' ? native.wrapped : h.symbol} size={30} />
              <Text style={[styles.assetSymbol, styles.assetText]}>{h.label}</Text>
              <Text style={styles.sub}>{fmtNum(Number(formatUnits(h.raw, h.decimals)))}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>

      {scanning ? (
        <QrScanner
          visible={scanning}
          onScan={(a) => {
            setScanning(false);
            setToText(displayAddress(network, a));
          }}
          onClose={() => setScanning(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    content: {padding: 16, gap: 8, paddingBottom: 32},
    label: {color: c.subtext, fontSize: 13, fontWeight: '600', marginTop: 10, marginLeft: 4},
    card: {backgroundColor: c.card, borderRadius: 16, padding: 14, gap: 10},
    inputRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
    input: {flex: 1, color: c.text, fontSize: 15, fontFamily: MONO, padding: 0},
    amount: {fontSize: 22, fontWeight: '700', fontFamily: undefined},
    chip: {alignSelf: 'flex-start', backgroundColor: c.accentSoft, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5},
    chipText: {color: c.accent, fontSize: 13, fontWeight: '600'},
    assetRow: {flexDirection: 'row', alignItems: 'center'},
    assetText: {flex: 1, gap: 2},
    assetSymbol: {color: c.text, fontSize: 16, fontWeight: '700'},
    sub: {color: c.subtext, fontSize: 13},
    chevron: {color: c.subtext, fontSize: 22},
    max: {backgroundColor: c.accentSoft, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5},
    maxText: {color: c.accent, fontSize: 13, fontWeight: '700'},
    error: {color: c.danger, fontSize: 13, marginLeft: 4},
    feeRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, paddingHorizontal: 4},
    feeValue: {color: c.text, fontSize: 14, fontWeight: '600'},
    button: {marginHorizontal: 16, marginBottom: 8, backgroundColor: c.accent, borderRadius: 14, paddingVertical: 15, alignItems: 'center'},
    buttonOff: {opacity: 0.4},
    buttonText: {color: c.onAccent, fontSize: 16, fontWeight: '700'},
    pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 4},
  });

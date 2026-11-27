import React, {useEffect, useLayoutEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import {formatUnits, parseUnits, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {isTronNetwork, NATIVE} from '@/core/chain';
import {displayAddress, parseAddress} from '@/core/address';
import {networkLabel, useNetwork} from '@/core/network-store';
import {useActiveAccount, useHiddenWallets} from '@/core/account-mode';
import {fmtNum, fmtShort, shortAddress} from '@/core/format';
import {usdValue} from '@/core/prices';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {usePrices} from '@/vault/usePrices';
import {formatNative} from '@/vault/direct';
import {useWallet} from '@/wallet/store';
import {recordSent} from '@/wallet/sent-log';
import {energyOf, maxNativeSend, planWalletTransfer, sendWalletTransfer, type WalletAsset} from '@/wallet/send';
import type {OwnerTxPlan} from '@/vault/direct';
import {useEnergyRental} from '@/components/EnergyRental';
import {BookIcon} from '@/components/BookIcon';
import {ClearBtn} from '@/components/ClearBtn';
import {AddressInput} from '@/components/AddressInput';
import {TokenIcon} from '@/components/TokenIcon';
import {useVaults} from '@/core/vault-store';
import {walletRows} from './WalletListScreen';
import {ScanButton} from '@/components/ScanIcon';
import {QrScanner} from '@/components/QrScanner';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
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
  // Tron: a note on the transaction (raw_data.data), which costs the chain's memo fee.
  const [memo, setMemo] = useState('');
  const [memoSun, setMemoSun] = useState<bigint | null>(null);
  const [picking, setPicking] = useState(false);
  const [scanning, setScanning] = useState(false);
  // The scanner at the page's top right, in the navigation bar.
  useLayoutEffect(() => {
    nav.setOptions({headerRight: () => <ScanButton onPress={() => setScanning(true)} />});
  }, [nav]);
  // The address book: this phone's own wallets (the ones created or added here), but the one sending.
  const [booking, setBooking] = useState(false);
  const vaults = useVaults((s) => s.vaults);
  const hidden = useHiddenWallets((s) => s.hidden);
  const book = useMemo(() => walletRows(vaults, hidden, 'shown').filter((r) => !from || r.address.toLowerCase() !== from.toLowerCase()), [vaults, hidden, from]);
  const [fee, setFee] = useState<OwnerTxPlan | null>(null);
  const [feeState, setFeeState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [sending, setSending] = useState(false);

  const asset = held.find((h) => h.symbol === symbol) ?? held[0];
  const tron = isTronNetwork(network);
  const note = tron ? memo.trim() : '';
  // The chain's memo fee, for the Note header (bandwidth for its bytes is in the network fee).
  useEffect(() => {
    setMemoSun(null);
    if (!tron) return;
    let live = true;
    (require('@/tron/client') as typeof import('@/tron/client'))
      .memoFeeSun(network as import('@/tron/config').TronChain)
      .then((v) => live && setMemoSun(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [network, tron]);
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
      planWalletTransfer({network, from, to, asset, amount: raw, memo: note})
        .then((p) => live && (setFee(p), setFeeState('idle')))
        .catch(() => live && setFeeState('failed'));
    }, 450);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [network, from, to, asset, raw, note]);

  /**
   * Rent the transfer's energy from TronSave instead of burning TRX for it (components/EnergyRental,
   * at the confirm button's top left). Only for a token transfer, where the network offers it.
   */
  const rental = useEnergyRental({
    network,
    wallet: from,
    energy: fee ? energyOf(fee) : null,
    price: fee?.maxFeePerGas ?? null,
    bandwidth: fee?.l1Fee ?? null,
    worst: fee?.cost ?? null,
    enabled: !!asset && asset.address !== 'native',
  });
  const renting = rental.renting;
  // What the wallet must hold for the fee (the "not enough" check), and the fee shown.
  const feeCost = rental.needSun;
  const shownFee = rental.shownSun;
  const rentReady = rental.ok;

  const nativeHeld = held[0]?.raw ?? BigInt(0);
  const short = !!asset && !!raw && (raw > asset.raw || (feeCost != null && (asset.address === 'native' ? raw + feeCost > nativeHeld : feeCost > nativeHeld)));
  const shortSymbol = asset && raw && raw > asset.raw ? asset.label : native.symbol;
  const canSend = !!from && !!to && !!asset && !!raw && raw > BigInt(0) && !!fee && !short && rentReady && !sending;

  const setMax = async () => {
    if (!asset || !from) return;
    if (asset.address !== 'native') return setAmount(formatUnits(asset.raw, asset.decimals));
    const max = await maxNativeSend(network, from, to ?? from, note || undefined);
    setAmount(formatUnits(max, asset.decimals));
  };

  const send = async () => {
    if (!canSend || !from || !to || !asset || !raw) return;
    setSending(true);
    const tx = showTx(`${t('vault.send')} ${fmtShort(Number(formatUnits(raw, asset.decimals)))} ${asset.label}`, network);
    try {
      const signer = await useWallet.getState().walletSigner();
      const {hash} = await sendWalletTransfer({account: signer, network, from, to, asset, amount: raw, memo: note || undefined, ...(renting ? {plan: fee ?? undefined, rent: rental.quote!} : {})});
      recordSent({
        hash,
        network,
        from,
        to,
        symbol: asset.address === 'native' ? native.wrapped : asset.symbol,
        token: asset.address === 'native' ? null : asset.address,
        amount: formatUnits(raw, asset.decimals),
      });
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

  const feeUsd = shownFee != null ? usdValue(Number(formatUnits(shownFee, native.decimals)), native.wrapped, prices) : null;
  const vault = account.vault;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
        <Text style={styles.label}>{t('mobile.account.to')}</Text>
        <View style={styles.card}>
          <View style={styles.inputRow}>
            <AddressInput style={styles.input} value={toText} onChangeText={setToText} placeholder={t('mobile.account.to_placeholder')} valid={!!to} />
            {toText ? <ClearBtn onPress={() => setToText('')} /> : null}
            {book.length ? (
              <Pressable onPress={() => setBooking(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('mobile.account.address_book')}>
                <BookIcon color={c.accent} />
              </Pressable>
            ) : null}
          </View>
          {badAddress ? <Text style={[styles.error, styles.inCard]}>{t('mobile.account.bad_address', {network: networkLabel(network, t)})}</Text> : null}
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
        {tron ? (
          <>
            <Text style={styles.label}>{t('mobile.tron.note')}</Text>
            <View style={styles.card}>
              <TextInput
                style={[styles.input, styles.noteInput]}
                value={memo}
                onChangeText={setMemo}
                maxLength={200}
                multiline
                placeholder={t('mobile.tron.note_optional')}
                placeholderTextColor={c.subtext}
              />
            </View>
            {/* Said before anything is typed: Tron burns its memo fee for any note (1 TRX on
                mainnet and Nile, the chain's getMemoFee), and it is in the network fee below. */}
            <Text style={[styles.noteFee, note ? styles.noteFeeOn : null]}>
              {t('mobile.tron.note_fee', {fee: `${formatNative(network, memoSun ?? BigInt(1_000_000))} ${native.symbol}`})}
            </Text>
          </>
        ) : null}
        {feeState === 'failed' ? <Text style={styles.error}>{t('mobile.account.fee_failed')}</Text> : null}
      </ScrollView>

      {/* The app's one signing control (Face ID, Confirm), in the footer as on the smart wallet's Send.
          The fee is at its top left/right: the rental and TRX, then the network fee in dollars; until
          it is priced (`pricing`) no line, as a wallet has no activation to quote. */}
      <View style={styles.footer}>
        <ConfirmButton onPress={send} loading={sending} disabled={!canSend} pricing={!rental.toggle && feeUsd == null} rental={rental.toggle} networkFeeUsd={feeUsd ?? undefined} />
      </View>

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

      <Sheet visible={booking} title={t('mobile.account.address_book')} onClose={() => setBooking(false)}>
        <ScrollView>
          {book.map((r) => (
            <Pressable
              key={r.address}
              style={styles.pickRow}
              onPress={() => {
                setToText(displayAddress(network, r.address));
                setBooking(false);
              }}
              accessibilityRole="button">
              <View style={styles.assetText}>
                <Text style={styles.assetSymbol}>{t('mobile.account.wallet_n', {n: r.number})}</Text>
                <Text style={[styles.sub, styles.mono]} numberOfLines={1} ellipsizeMode="middle">
                  {displayAddress(network, r.address)}
                </Text>
              </View>
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
    content: {padding: 16, paddingTop: 4, gap: 6, paddingBottom: 32},
    // As a Settings group's label: inset to the card's content, 20 pt between one group and the next.
    label: {color: c.subtext, fontSize: 15, fontWeight: '600', marginTop: 14, paddingHorizontal: 16},
    mono: {fontFamily: MONO},
    // A Settings group's shape (SettingsRow `group`): the same corners and insets as every other page.
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, gap: 10},
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
    max: {backgroundColor: c.accentSoft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6},
    maxText: {color: c.accent, fontSize: 13, fontWeight: '700'},
    error: {color: c.danger, fontSize: 13, marginHorizontal: 16},
    // Inside a card, whose own padding already insets it.
    inCard: {marginHorizontal: 0},
    noteInput: {fontFamily: undefined, minHeight: 22},
    noteFee: {color: c.subtext, fontSize: 13, marginTop: 6, paddingHorizontal: 16},
    noteFeeOn: {color: c.text, fontWeight: '600'},
    footer: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16},
    pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 4},
  });

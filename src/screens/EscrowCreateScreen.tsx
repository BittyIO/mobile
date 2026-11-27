import React, {useEffect, useMemo, useState} from 'react';
import {Keyboard, Pressable, useWindowDimensions, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {formatUnits, parseUnits, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {displayAddress, parseAddress} from '@/core/address';
import {networkLabel, useNetwork} from '@/core/network-store';
import {useActiveAccount, useHiddenWallets} from '@/core/account-mode';
import {useVaults} from '@/core/vault-store';
import {walletRows} from './WalletListScreen';
import {fmtNum, shortAddress} from '@/core/format';
import {createDeal, DepositPendingError, estimateDeal, type DealCost, rememberEscrow, escrowToken, feeBps, feeFor, prepareDeal, type NewDeal} from '@/escrow/escrow';
import {NATIVE} from '@/core/chain';
import {formatNative} from '@/vault/direct';
import {Sheet} from '@/components/Sheet';
import {Button, ConfirmButton} from '@/components/Button';
import {usePrices} from '@/vault/usePrices';
import {usdValue} from '@/core/prices';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useWallet} from '@/wallet/store';
import {ScanButton} from '@/components/ScanIcon';
import {EscrowRule} from '@/components/EscrowRule';
import {BookIcon} from '@/components/BookIcon';
import {ClearBtn} from '@/components/ClearBtn';
import {AddressInput} from '@/components/AddressInput';
import {useEnergyRental} from '@/components/EnergyRental';
import {OptionRow, SettingsGroup} from '@/components/SettingsRow';
import {QrScanner} from '@/components/QrScanner';
import {showToast, showTx} from '@/components/Toast';
import {useT} from '@/i18n';
import {MONO, useColors, useStyles, type Colors} from '@/theme';

const DAY = 86_400;
/** The end times on offer, in seconds from creation (0: none), then Custom. */
const ENDS = [
  {key: 'end_none', seconds: 0},
  {key: 'end_1m', seconds: 60},
  {key: 'end_1d', seconds: DAY},
  {key: 'end_7d', seconds: 7 * DAY},
  {key: 'end_30d', seconds: 30 * DAY},
] as const;
/** A custom end time: a whole number of one of these units, up to its max. */
const UNITS = [
  {key: 'unit_minutes', seconds: 60, max: 1440},
  {key: 'unit_hours', seconds: 3600, max: 720},
  {key: 'unit_days', seconds: DAY, max: 365},
] as const;
type UnitKey = (typeof UNITS)[number]['key'];

/**
 * Escrow › New escrow: this wallet is A. B and the optional arbiter C by address, what each side
 * puts in, who decides, and an optional end time with what happens then. Creating also deposits A's
 * own amount (approve, then deposit), each step a transaction from the wallet.
 */
export function EscrowCreateScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const me = useActiveAccount(network).wallet as Address | undefined;
  // Once per network: a fresh object each render would re-run the fee lookup on every render.
  const token = useMemo(() => escrowToken(network), [network]);
  const bal = useVaultBalances(network);
  // As tall as Earn's deposit sheet (components/FormSheet): its top edge 8 under the status bar.
  const {height: screenHeight} = useWindowDimensions();
  const formSheetHeight = screenHeight - (useSafeAreaInsets().top || 44) - 8;
  const prices = usePrices(network, 0, useMemo(() => [NATIVE[network].wrapped], [network]));

  const [bText, setBText] = useState('');
  const [cText, setCText] = useState('');
  const [mine, setMine] = useState('');
  const [theirs, setTheirs] = useState('');
  const [endPreset, setEndPreset] = useState<number | 'custom'>(0);
  const [customN, setCustomN] = useState('');
  const [customUnit, setCustomUnit] = useState<UnitKey>('unit_minutes');
  const [fees, setFees] = useState<{a: bigint; b: bigint} | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [scanning, setScanning] = useState<'b' | 'c' | null>(null);
  // Which field the "my wallets" sheet fills, when open.
  const [picking, setPicking] = useState<'b' | 'c' | null>(null);
  // The earliest-settlement choices, from its row.
  const [endOpen, setEndOpen] = useState(false);
  // The rules sheet, from the Rules row.
  const [rulesOpen, setRulesOpen] = useState(false);
  const vaults = useVaults((s) => s.vaults);
  const hidden = useHiddenWallets((s) => s.hidden);
  const myWallets = useMemo(() => walletRows(vaults, hidden, 'shown'), [vaults, hidden]);
  const [busy, setBusy] = useState<string | null>(null);
  // The confirm sheet: open once Review is tapped; the network fee estimated for exactly what it shows.
  const [reviewing, setReviewing] = useState(false);
  const [gas, setGas] = useState<DealCost | null>(null);
  /**
   * The deal Review showed and the address it will have. The factory derives the address from the
   * terms, end time included, so Confirm sends exactly this deal — not one rebuilt at the tap,
   * whose later end time would put it somewhere other than the address on the sheet.
   */
  const [planned, setPlanned] = useState<{deal: NewDeal; escrow: Address; reused: boolean} | null>(null);
  const [gasState, setGasState] = useState<'busy' | 'failed' | 'idle'>('idle');

  const b = parseAddress(network, bText);
  const cAddr = cText.trim() ? parseAddress(network, cText) : null;
  const badB = bText.trim().length > 0 && !b;
  const badC = cText.trim().length > 0 && !cAddr;
  const parse = (s: string) => {
    if (!token || !s.trim()) return BigInt(0);
    try {
      return parseUnits(s.replace(',', '.'), token.decimals);
    } catch {
      return null;
    }
  };
  const amountA = parse(mine);
  const amountB = parse(theirs);
  const unit = UNITS.find((u) => u.key === customUnit)!;
  const n = Number(customN);
  const customOk = customN.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= unit.max;
  // Seconds from creation to the end time: 0 for none, null while a custom one is not valid yet.
  const endSeconds = endPreset === 'custom' ? (customOk ? n * unit.seconds : null) : endPreset;
  // What the row shows: the preset's name, the custom time typed, or "Custom" until it is valid.
  const endLabel =
    endPreset === 'custom'
      ? customOk
        ? `${customN} ${t(`mobile.escrow.${customUnit}`)}`
        : t('mobile.escrow.end_custom')
      : t(`mobile.escrow.${ENDS.find((e) => e.seconds === endPreset)!.key}`);
  const held = useMemo(() => bal.balances?.tokens.find((x) => token && x.address.toLowerCase() === token.address.toLowerCase())?.raw ?? null, [bal.balances, token]);

  useEffect(() => {
    let live = true;
    feeBps(network)
      .then((r) => live && setRate(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [network]);

  // Two of the three the same address: only a real repeat, never a field not filled in yet.
  const same = (x: Address | null | undefined, y: Address | null | undefined) => !!x && !!y && x.toLowerCase() === y.toLowerCase();
  const clash = same(b, me) || same(cAddr, me) || same(b, cAddr);
  const distinct = !!b && !!me && !!cAddr && !clash;
  // Every field set: only then can it be reviewed, and the fees are worked out in the confirm sheet.
  const complete = distinct && !badC && amountA !== null && amountB !== null && amountA + amountB > BigInt(0) && endSeconds !== null;

  if (!token || !me) return null;
  const fmt = (v: bigint) => `${fmtNum(Number(formatUnits(v, token.decimals)))} ${token.symbol}`;

  const tooSmall = !!fees && amountA !== null && amountB !== null && ((amountA > BigInt(0) && amountA <= fees.a) || (amountB > BigInt(0) && amountB <= fees.b));
  const short = amountA !== null && held !== null && amountA > held;
  const ok = complete && !short && !busy;

  /** Each side's escrow fee: the factory's feeFor, or, when that read fails, its formula from the rate. */
  const feesFor = async (a: bigint, bb: bigint) => {
    try {
      const [fa, fb] = await Promise.all([feeFor(network, token.address, a), feeFor(network, token.address, bb)]);
      return {a: fa, b: fb};
    } catch (e) {
      if (rate === null) throw e;
      const floor = BigInt(10) ** BigInt(token.decimals) / BigInt(10);
      const of = (v: bigint) => {
        if (v <= BigInt(0)) return BigInt(0);
        const pct = (v * BigInt(rate) + BigInt(9_999)) / BigInt(10_000);
        return pct > floor ? pct : floor;
      };
      return {a: of(a), b: of(bb)};
    }
  };

  const native = NATIVE[network];
  const nativeHeld = bal.balances?.native.raw ?? null;
  // The deal as it would go out now; the end time counts from the moment it is built.
  const dealNow = (): NewDeal | null => {
    if (!b || !cAddr || amountA === null || amountB === null || endSeconds === null) return null;
    const endTime = endSeconds ? Math.floor(Date.now() / 1000) + endSeconds : 0;
    return {token: token.address, b, c: cAddr, amountA, amountB, endTime};
  };
  const ruleLabel = t('mobile.escrow.rule_arbiter_or_both');
  // Energy rental for the deal's transactions, at the confirm button's top left, as on Send.
  const rental = useEnergyRental({
    network,
    wallet: me,
    energy: gas ? Number(gas.energy) : null,
    price: gas?.price ?? null,
    bandwidth: gas?.bandwidth ?? null,
    worst: gas?.cost ?? null,
  });
  const rentable = rental.offered;
  const renting = rental.renting;
  const rentReady = rental.ok;
  const shownFee = rental.shownSun;
  const needSun = rental.needSun;
  const gasUsd = shownFee != null ? usdValue(Number(formatUnits(shownFee, native.decimals)), native.wrapped, prices) : null;
  const gasShort = needSun != null && nativeHeld !== null && needSun > nativeHeld;

  // Review: nothing is sent; the sheet shows every term and the network fee for them.
  const review = async () => {
    const deal = dealNow();
    if (!ok || !deal) return;
    // An open keyboard would shrink the sheet to a strip with no room for its button.
    Keyboard.dismiss();
    setReviewing(true);
    setGas(null);
    setFees(null);
    setPlanned(null);
    setGasState('busy');
    try {
      setFees(await feesFor(deal.amountA, deal.amountB));
      const prepared = await prepareDeal({network, me, deal});
      setPlanned({deal, escrow: prepared.escrow, reused: prepared.reused});
      setGas(await estimateDeal({network, me, prepared}));
      setGasState('idle');
    } catch (e) {
      setGasState('failed');
    }
  };

  const create = async () => {
    if (!ok || !planned || !gas || gasShort || !fees || tooSmall || !rentReady) return;
    const {deal} = planned;
    // An end time about to pass would be refused on chain: review again, with a new end time.
    if (deal.endTime && deal.endTime - Math.floor(Date.now() / 1000) < 30) {
      void review();
      return;
    }
    setReviewing(false);
    const tx = showTx(`${t('mobile.escrow.new')} ${fmt(deal.amountA + deal.amountB)}`, network);
    setBusy(t('mobile.escrow.create'));
    try {
      const signer = await useWallet.getState().walletSigner();
      // The reviewed deal, as reviewed: its address is the one the sheet showed.
      const prepared = await prepareDeal({network, me, deal});
      const {escrow, dealId, hash} = await createDeal({
        account: signer,
        network,
        prepared,
        onStep: (i, n) => n > 1 && setBusy(t('mobile.escrow.step', {i: i + 1, n})),
        rent: renting ? {quote: rental.quote!, need: Number(gas.energy)} : undefined,
      });
      tx.success(hash);
      nav.replace('EscrowDetail', {escrow, dealId});
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (e instanceof DepositPendingError) {
        // Created, not funded: say so, and go to its page, where Deposit is.
        tx.error(msg);
        nav.replace('EscrowDetail', {escrow: e.escrow, dealId: e.dealId});
        return;
      }
      if (/cancel/i.test(msg)) tx.done();
      else tx.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const addressField = (label: string, value: string, set: (s: string) => void, bad: boolean, which: 'b' | 'c') => (
    <>
      {/* The heading, then the address book (this phone's other wallets, never A's own) right after it. */}
      <View style={styles.labelRow}>
        <Text style={[styles.label, styles.labelInRow]}>{label}</Text>
        {pickable.length ? (
          <Pressable onPress={() => setPicking(which)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('mobile.account.address_book')}>
            <BookIcon color={c.accent} size={18} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.card}>
        <View style={styles.inputRow}>
          <AddressInput style={styles.input} value={value} onChangeText={set} placeholder={t('mobile.account.to_placeholder')} valid={!!parseAddress(network, value)} />
          {/* Clear what is typed, then the camera. */}
          {value ? <ClearBtn onPress={() => set('')} /> : null}
          <ScanButton onPress={() => setScanning(which)} />
        </View>
        {bad ? <Text style={[styles.error, styles.inCard]}>{t('mobile.account.bad_address', {network: networkLabel(network, t)})}</Text> : null}
      </View>
    </>
  );

  const pickable = myWallets.filter((r) => r.address.toLowerCase() !== me.toLowerCase());
  const pick = (a: Address) => {
    (picking === 'b' ? setBText : setCText)(displayAddress(network, a));
    setPicking(null);
  };

  // A confirm-sheet row, Settings-sized: the label at the left, the value at the right, a hairline under.
  const row = (label: string, value: string, mono?: boolean, last?: boolean) => (
    <View key={label} style={[styles.sheetRow, !last && styles.sheetDivider]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.sheetValue, mono && styles.sheetMono]} numberOfLines={1} selectable>
        {value}
      </Text>
    </View>
  );

  const choice = (on: boolean, label: string, onPress: () => void) => (
    <Pressable key={label} style={[styles.option, on && styles.optionOn]} onPress={onPress} accessibilityRole="button" accessibilityState={{selected: on}}>
      <Text style={[styles.optionText, on && styles.optionTextOn]}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
        {addressField(t('mobile.escrow.counterparty'), bText, setBText, badB, 'b')}
        {addressField(t('mobile.escrow.arbiter'), cText, setCText, badC, 'c')}
        {clash ? <Text style={styles.error}>{t('mobile.escrow.bad_parties')}</Text> : null}

        <Text style={styles.label}>{t('mobile.escrow.my_amount')}</Text>
        <View style={[styles.card, styles.inputRow]}>
          <TextInput style={[styles.input, styles.amount]} value={mine} onChangeText={setMine} placeholder="0" placeholderTextColor={c.subtext} keyboardType="decimal-pad" />
          <Text style={styles.sub}>{token.symbol}</Text>
        </View>
        {short ? <Text style={styles.error}>{t('mobile.account.not_enough', {symbol: token.symbol})}</Text> : null}

        <Text style={styles.label}>{t('mobile.escrow.their_amount')}</Text>
        <View style={[styles.card, styles.inputRow]}>
          <TextInput style={[styles.input, styles.amount]} value={theirs} onChangeText={setTheirs} placeholder="0" placeholderTextColor={c.subtext} keyboardType="decimal-pad" />
          <Text style={styles.sub}>{token.symbol}</Text>
        </View>

        {/* Earliest settlement, as a Settings row: the choice on the right, the choices in a sheet. */}
        <Pressable style={({pressed}) => [styles.card, styles.navRow, pressed && styles.pressed]} onPress={() => setEndOpen(true)} accessibilityRole="button">
          <Text style={styles.navTitle}>{t('mobile.escrow.end')}</Text>
          <View style={styles.navRight}>
            <Text style={[styles.navValue, endSeconds === null && styles.navValueBad]} numberOfLines={1}>
              {endLabel}
            </Text>
            <Text style={styles.chevron}>›</Text>
          </View>
        </Pressable>

        {/* The rules as on the deal's page: one row, its details in a sheet. */}
        <Pressable style={({pressed}) => [styles.card, styles.navRow, pressed && styles.pressed]} onPress={() => setRulesOpen(true)} accessibilityRole="button">
          <Text style={styles.navTitle}>{t('mobile.escrow.rule')}</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

      </ScrollView>

      {/* The app's pill button in a footer, as on Send; Review opens the confirm sheet, which signs. */}
      <View style={styles.footer}>
        <Button title={busy ?? t('mobile.escrow.review')} onPress={review} loading={!!busy && !reviewing} disabled={!ok} />
      </View>

      <Sheet visible={reviewing} title={t('mobile.escrow.confirm_title')} onClose={() => setReviewing(false)} height={formSheetHeight}>
        {/* The terms scroll; the fee and the Face ID Confirm stay at the bottom, as on Earn's deposit. */}
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetBody} showsVerticalScrollIndicator={false}>
          {/* The total held, large: what is being confirmed, at a glance. */}
          <View style={styles.hero}>
            <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit>
              {amountA !== null && amountB !== null ? fmt(amountA + amountB) : '—'}
            </Text>
          </View>
          {/* Grouped as the pages are: the escrow, the three parties, then the terms. Settings rows. */}
          <View style={styles.sheetGroup}>
            {row(t('mobile.escrow.address'), planned ? shortAddress(displayAddress(network, planned.escrow)) : t('mobile.account.fee_estimating'), !!planned)}
            {/* Your escrow account: one whose last deal is over is reused, for about a quarter of the gas. */}
            {row(t('mobile.escrow.account'), planned ? t(planned.reused ? 'mobile.escrow.account_reused' : 'mobile.escrow.account_new') : '…', false, true)}
          </View>
          <View style={styles.sheetGroup}>
            {row(t('mobile.escrow.party_a'), shortAddress(displayAddress(network, me)), true)}
            {row(t('mobile.escrow.counterparty'), b ? shortAddress(displayAddress(network, b)) : '—', true)}
            {row(t('mobile.escrow.arbiter'), cAddr ? shortAddress(displayAddress(network, cAddr)) : '—', !!cAddr, true)}
          </View>
          <View style={styles.sheetGroup}>
            {row(t('mobile.escrow.my_amount'), amountA !== null ? fmt(amountA) : '—')}
            {row(t('mobile.escrow.their_amount'), amountB !== null ? fmt(amountB) : '—')}
            {row(t('mobile.escrow.end'), endLabel)}
            {row(t('mobile.escrow.fee'), fees ? (fees.a === fees.b ? t('mobile.escrow.fee_each', {amount: fmt(fees.a)}) : `${t('mobile.escrow.role_a')} ${fmt(fees.a)} · ${t('mobile.escrow.role_b')} ${fmt(fees.b)}`) : gasState === 'busy' ? t('mobile.account.fee_estimating') : '—', false, true)}
          </View>
          {!rentable && gas ? <View style={styles.sheetGroup}>{row(t('mobile.escrow.network_fee'), `≈ ${formatNative(network, gas.cost)} ${native.symbol}`, false, true)}</View> : null}
        </ScrollView>
        {gasState === 'failed' ? <Text style={[styles.error, styles.inSheet]}>{t('mobile.account.fee_failed')}</Text> : null}
        {tooSmall ? <Text style={[styles.error, styles.inSheet]}>{t('mobile.escrow.too_small')}</Text> : null}
        {gasShort ? <Text style={[styles.error, styles.inSheet]}>{t('mobile.escrow.gas_short', {symbol: native.symbol})}</Text> : null}
        {/* Earn's wallet deposit button: Face ID and Confirm, the network fee in dollars above it. */}
        <ConfirmButton
          onPress={create}
          loading={gasState === 'busy'}
          disabled={!gas || !fees || !planned || tooSmall || gasShort || !rentReady || !!busy}
          fee={gasUsd != null}
          networkFeeUsd={gasUsd ?? undefined}
          rental={rental.toggle}
        />
      </Sheet>

      <Sheet visible={endOpen} title={t('mobile.escrow.end')} onClose={() => setEndOpen(false)}>
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <SettingsGroup>
            {ENDS.map((e) => (
              <OptionRow
                key={e.key}
                title={t(`mobile.escrow.${e.key}`)}
                checked={endPreset === e.seconds}
                onPress={() => {
                  setEndPreset(e.seconds);
                  setEndOpen(false);
                }}
              />
            ))}
            <OptionRow title={t('mobile.escrow.end_custom')} checked={endPreset === 'custom'} onPress={() => setEndPreset('custom')} last={endPreset !== 'custom'} />
            {endPreset === 'custom' ? (
              <View style={styles.customBox}>
                <View style={styles.customRow}>
                  <TextInput
                    style={styles.customInput}
                    value={customN}
                    onChangeText={(v) => setCustomN(v.replace(/[^0-9]/g, ''))}
                    placeholder={`1–${unit.max}`}
                    placeholderTextColor={c.subtext}
                    keyboardType="number-pad"
                    autoFocus
                  />
                  <Pressable disabled={!customOk} onPress={() => setEndOpen(false)} style={[styles.doneBtn, !customOk && styles.doneOff]} accessibilityRole="button">
                    <Text style={[styles.doneText, !customOk && styles.doneTextOff]}>{t('vault.done')}</Text>
                  </Pressable>
                </View>
                <View style={styles.options}>{UNITS.map((u) => choice(customUnit === u.key, t(`mobile.escrow.${u.key}`), () => setCustomUnit(u.key)))}</View>
                {customN.trim() && !customOk ? <Text style={[styles.error, styles.inCard]}>{t('mobile.escrow.end_custom_bad', {max: unit.max})}</Text> : null}
              </View>
            ) : null}
          </SettingsGroup>
        </ScrollView>
      </Sheet>

      <Sheet visible={rulesOpen} title={t('mobile.escrow.rule')} onClose={() => setRulesOpen(false)}>
        <View style={styles.rulesSheet}>
          <EscrowRule />
        </View>
      </Sheet>

      {/* The address book, as on Send: this phone's wallets, Wallet N over its address. */}
      <Sheet visible={picking !== null} title={t('mobile.account.address_book')} onClose={() => setPicking(null)}>
        <ScrollView>
          {pickable.map((r) => {
            const shown = displayAddress(network, r.address);
            const other = picking === 'b' ? cText : bText;
            const taken = other.trim().toLowerCase() === shown.toLowerCase();
            return (
              <Pressable key={r.address} disabled={taken} onPress={() => pick(r.address)} style={[styles.bookRow, taken && styles.buttonOff]} accessibilityRole="button">
                <View style={styles.bookText}>
                  <Text style={styles.bookTitle}>{t('mobile.account.wallet_n', {n: r.number})}</Text>
                  <Text style={[styles.sub, styles.mono]} numberOfLines={1} ellipsizeMode="middle">
                    {shown}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </Sheet>

      {scanning ? (
        <QrScanner
          visible
          onScan={(a) => {
            (scanning === 'b' ? setBText : setCText)(displayAddress(network, a));
            setScanning(null);
          }}
          onClose={() => setScanning(null)}
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
    // A Settings group's shape (SettingsRow `group`): the same corners and insets as every other page.
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, gap: 10},
    inputRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
    input: {flex: 1, color: c.text, fontSize: 15, fontFamily: MONO, padding: 0},
    amount: {fontSize: 22, fontWeight: '700', fontFamily: undefined},
    options: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    option: {backgroundColor: c.card, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9},
    optionOn: {backgroundColor: c.accentSoft},
    optionText: {color: c.text, fontSize: 14, fontWeight: '600'},
    optionTextOn: {color: c.accent},
    sub: {color: c.subtext, fontSize: 13},
    note: {color: c.subtext, fontSize: 12, marginHorizontal: 16},
    warn: {color: c.subtext, fontSize: 13, marginHorizontal: 16, marginTop: 4},
    error: {color: c.danger, fontSize: 13, marginHorizontal: 16},
    // Inside a card, whose own padding already insets it.
    inCard: {marginHorizontal: 0},
    // A heading with the address book after it: the label's spacing, on a row.
    labelRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, marginTop: 14},
    labelInRow: {paddingHorizontal: 0, marginTop: 0},
    // A group inside the confirm sheet: one step off the sheet's own surface, as Guard's level panel.
    sheetGroup: {backgroundColor: c.cardAlt, borderRadius: 20, paddingHorizontal: 16},
    sheetRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 50, paddingVertical: 12},
    sheetDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    rowLabel: {color: c.text, fontSize: 16},
    sheetValue: {color: c.subtext, fontSize: 16, flexShrink: 1, textAlign: 'right'},
    sheetMono: {fontFamily: MONO, fontSize: 15},
    hero: {alignItems: 'center', gap: 4, paddingVertical: 12},
    heroAmount: {color: c.text, fontSize: 34, fontWeight: '700'},
    // The address book sheet's rows: Send's (WalletSendScreen `pickRow`).
    bookRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 4},
    bookText: {flex: 1, gap: 2},
    bookTitle: {color: c.text, fontSize: 16, fontWeight: '700'},
    // A Settings row: its title, and a chevron for the sheet it opens (as on the deal's page).
    navRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52, marginTop: 14},
    navTitle: {color: c.text, fontSize: 16, fontWeight: '500'},
    chevron: {color: c.subtext, fontSize: 22, fontWeight: '300'},
    pressed: {opacity: 0.6},
    rulesSheet: {paddingHorizontal: 4, paddingBottom: 24},
    navRight: {flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1},
    navValue: {color: c.subtext, fontSize: 15, flexShrink: 1},
    navValueBad: {color: c.danger},
    // Custom, in the sheet: the number and Done on a line, the units under it (as Guard's timelock).
    customBox: {gap: 10, paddingHorizontal: 16, paddingVertical: 12},
    customRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
    customInput: {flex: 1, minHeight: 40, borderRadius: 10, backgroundColor: c.input, color: c.text, paddingHorizontal: 12, fontSize: 17},
    doneBtn: {minHeight: 40, paddingHorizontal: 16, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.accent, backgroundColor: c.accentSoft},
    doneOff: {borderColor: c.border, backgroundColor: c.card},
    doneText: {color: c.accent, fontSize: 14, fontWeight: '700'},
    doneTextOff: {color: c.subtext},
    // In the confirm sheet, as before: the sheet has its own padding.
    inSheet: {marginHorizontal: 4},
    sheetScroll: {flex: 1},
    // As Send's quick-recipient chip: the same control for the same thing.
    chip: {alignSelf: 'flex-start', backgroundColor: c.accentSoft, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5},
    chipText: {color: c.accent, fontSize: 13, fontWeight: '600'},
    pickRow: {paddingVertical: 10, gap: 2},
    pickDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    sheetBody: {gap: 16, paddingBottom: 12},
    divider: {height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 2},
    mono: {fontFamily: MONO, fontSize: 13, fontWeight: '500'},
    footer: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16},
    buttonOff: {opacity: 0.4},
  });

import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Svg, {Circle, Path} from 'react-native-svg';
import {encodeFunctionData, formatUnits, parseUnits, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {NATIVE} from '@/core/chain';
import {knownAssets} from '@/core/assets';
import {displayAddress, parseAddress} from '@/core/address';
import {useNetwork} from '@/core/network-store';
import {useActiveAccount} from '@/core/account-mode';
import {displaySymbol, fmtNum, fmtShort} from '@/core/format';
import {useRecipientPick} from '@/core/recipient-pick';
import {WHITELIST_STATUS} from '@/core/abi';
import {useVaultBalances} from '@/vault/useVaultBalances';
import type {WhitelistedRecipient} from '@/vault/payments';
import {useWallet} from '@/wallet/store';
import {ACCOUNT_ABI, AccountRelayError, feeCall, quoteAccount, relayAccount, type AccountCall, type AccountQuote} from '@/account/relay';
import {addPayeeCall, readGuard, type AccountGuard} from '@/account/guard';
import {accountBook} from '@/account/guard-evm';
import {fmtWait} from '@/components/riskFormat';
import {exceedsMax} from '@/components/AmountInput';
import {ScanButton} from '@/components/ScanIcon';
import {QrScanner} from '@/components/QrScanner';
import {TokenIcon} from '@/components/TokenIcon';
import {ClearBtn} from '@/components/ClearBtn';
import {Sheet} from '@/components/Sheet';
import {SettingsGroup} from '@/components/SettingsRow';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

type Sym = 'USDT' | 'TRX';
type Line = {sym: Sym; amount: string};

/** The vault's Send page's recipient mark (SendScreen's AvatarIcon). */
function AvatarIcon({color}: {color: string}) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Circle cx={12} cy={8} r={4.2} fill={color} />
      <Path d="M20 21a8 8 0 0 0-16 0Z" fill={color} />
    </Svg>
  );
}

const ZERO = BigInt(0);

/**
 * Send from the Tron smart wallet (BittyAccount): the vault's Send page (SendScreen) — the payee
 * chosen on Payees, or Send to anyone with "Save to payees"; a line per token with its Max; Face ID
 * Confirm in the footer with the fee at its top right — over the account.
 *
 * The account pays USDT to anyone (a non-payee within its daily limit) and TRX to a payee only, so
 * those are its two lines. The fee is the relayer's, in USDT from the account in the same batch
 * (account/relay); a payee saved with the payment is added in that batch too, and is paid as a payee
 * once the timelock has passed.
 */
export function AccountSendScreen({anyone = false}: {anyone?: boolean}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const {height: screenHeight} = useWindowDimensions();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const active = useActiveAccount(network);
  const account = active.account;
  const owner = active.wallet;
  const unlocked = useWallet((s) => s.unlocked);
  const native = NATIVE[network];
  const usdt = useMemo(() => knownAssets(network).find((a) => a.symbol === 'USDT'), [network]);
  const bal = useVaultBalances(network);
  const usdtHeld = bal.balances?.tokens.find((x) => usdt && x.address.toLowerCase() === usdt.address.toLowerCase())?.raw ?? ZERO;
  const trxHeld = bal.balances?.native.raw ?? ZERO;

  const [guard, setGuard] = useState<AccountGuard | null>(null);
  const [book, setBook] = useState<WhitelistedRecipient[]>([]);
  useEffect(() => {
    if (!account) return;
    readGuard(network, account).then(setGuard).catch(() => {});
    accountBook(network, account).then(setBook).catch(() => {});
  }, [network, account]);

  const [to, setTo] = useState('');
  const [label, setLabel] = useState<string | undefined>();
  const [saveToBook, setSaveToBook] = useState(false);
  const [lines, setLines] = useState<Line[]>([{sym: 'USDT', amount: '0'}]);
  const picked = useRecipientPick((st) => st.picked);
  const clearPicked = useRecipientPick((st) => st.clear);
  useEffect(() => {
    if (!picked) return;
    setTo(picked.address);
    setLabel(picked.label);
    setSaveToBook(!!picked.addToBook);
    clearPicked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);
  const [draft, setDraft] = useState('');
  const [scanning, setScanning] = useState(false);
  const typeAddress = (v: string) => {
    setDraft(v);
    setTo(parseAddress(network, v) ?? '');
    setLabel(undefined);
  };

  const dec = (sym: Sym) => (sym === 'USDT' ? usdt?.decimals ?? 6 : native.decimals);
  const held = (sym: Sym) => (sym === 'USDT' ? usdtHeld : trxHeld);
  const parse = (v: string, d: number): bigint => {
    try {
      return v && Number(v.replace(',', '.')) > 0 ? parseUnits(v.replace(',', '.') as `${number}`, d) : ZERO;
    } catch {
      return ZERO;
    }
  };
  const entry = to ? book.find((b) => b.recipientAddress.toLowerCase() === to.toLowerCase() && (b.status === WHITELIST_STATUS.payable || b.status === WHITELIST_STATUS.removalQueued)) : undefined;
  const isSelf = !!to && !!account && to.toLowerCase() === account.toLowerCase();
  const funded = !!account && !!to && !isSelf && lines.some((l) => parse(l.amount, dec(l.sym)) > ZERO);

  // The batch: a payee saved with it first, then a call per funded line.
  const sendCalls = useMemo<AccountCall[]>(() => {
    if (!funded || !account) return [];
    const out: AccountCall[] = [];
    const listed = book.some((b) => b.recipientAddress.toLowerCase() === to.toLowerCase());
    if (saveToBook && !listed) out.push(addPayeeCall(account, to as Address));
    for (const l of lines) {
      const amt = parse(l.amount, dec(l.sym));
      if (amt <= ZERO) continue;
      out.push({
        to: account,
        value: ZERO,
        data: encodeFunctionData({abi: ACCOUNT_ABI, functionName: l.sym === 'USDT' ? 'sendUsdt' : 'sendTrx', args: [to as Address, amt]}),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funded, account, to, lines, saveToBook, book]);

  // The relayer's fee for this exact batch, re-asked a little after the last keystroke.
  const [quote, setQuote] = useState<AccountQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    if (!owner || !sendCalls.length) return;
    let live = true;
    const id = setTimeout(() => {
      quoteAccount({network, owner, calls: sendCalls})
        .then((q) => live && setQuote(q))
        .catch((e) => live && setQuoteErr(refusal(e)));
    }, 450);
    return () => {
      live = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, owner, sendCalls]);
  const fee = quote?.fee ?? null;

  /** A relayer refusal in words: the account's own rules first. */
  function refusal(e: unknown): string {
    if (e instanceof AccountRelayError) {
      const known: Record<string, string> = {
        AccountLocked: 'mobile.vault.lock_send_book_only',
        OverDailyLimit: 'mobile.tron.acct_over_limit',
        OverRelayerCap: 'mobile.tron.acct_over_relayer_cap',
        NotAPayee: 'mobile.tron.acct_trx_payee_only',
        'not-activated': 'mobile.tron.acct_not_activated',
        'relayer-unfunded': 'mobile.tron.acct_relayer_busy',
        'relayer-not-configured': 'mobile.tron.acct_relayer_busy',
      };
      const k = known[e.code ?? ''] ?? known[e.reason];
      if (k) return t(k);
    }
    return t('mobile.account.fee_failed');
  }

  /** One line's ceiling: what it holds, less the fee where the fee comes out of it (USDT). */
  const maxFor = (l: Line): string => {
    const own = held(l.sym);
    const left = l.sym === 'USDT' ? own - (fee ?? ZERO) : own;
    return formatUnits(left > ZERO ? left : ZERO, dec(l.sym));
  };
  const patchLine = (k: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === k ? {...l, ...patch} : l)));
  const [picker, setPicker] = useState<{k: number | null} | null>(null);
  const options: Sym[] = ['USDT', 'TRX'];
  const pickable = (k: number | null) => options.filter((o) => !lines.some((l, j) => j !== k && l.sym === o));
  const choose = (k: number | null, sym: Sym) => {
    setLines((ls) => (k == null ? [...ls, {sym, amount: '0'}] : ls.map((l, j) => (j === k ? {sym, amount: '0'} : l))));
    setPicker(null);
  };
  const nameOf = (sym: Sym) => (sym === 'USDT' ? 'USDT' : displaySymbol(native.wrapped));
  const iconOf = (sym: Sym) => (sym === 'USDT' ? 'USDT' : native.wrapped);

  // The account's rules, said before Confirm: TRX only to a payee; to anyone else, the limit and the lock.
  const trxOut = lines.some((l) => l.sym === 'TRX' && Number(l.amount) > 0);
  const trxBlocked = trxOut && !!to && !entry;
  const usdtOut = parse(lines.find((l) => l.sym === 'USDT')?.amount ?? '0', dec('USDT'));
  const lockedSends = !!guard?.locked;
  const leftToday = guard?.left ?? null;
  const overAllowance = !entry && leftToday !== null && usdtOut > leftToday;
  const lockBlocked = lockedSends && funded && !entry;
  const anyOver = lines.some((l) => exceedsMax(l.amount, maxFor(l)));
  const [busy, setBusy] = useState(false);
  const canSubmit = unlocked && !!quote && funded && !anyOver && !trxBlocked && !overAllowance && !lockBlocked && !busy;

  const onSubmit = async () => {
    if (!canSubmit || !quote) return;
    setBusy(true);
    const out = lines.filter((l) => Number(l.amount) > 0);
    const tx = showTx(
      out.length === 1 ? `${t('vault.send')} ${fmtShort(Number(out[0].amount))} ${nameOf(out[0].sym)}` : t('mobile.payments.send_n_payments', {count: out.length}),
      network,
    );
    try {
      const signer = await useWallet.getState().walletSigner();
      const {hash} = await relayAccount({network, signer, quote, calls: [...sendCalls, feeCall(quote)]});
      tx.success(hash);
      bal.refresh();
      if (nav.canGoBack()) nav.goBack();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/cancel/i.test(msg)) tx.done();
      else tx.error(e instanceof AccountRelayError ? refusal(e) : msg);
    } finally {
      setBusy(false);
    }
  };

  const timelock = guard ? BigInt(guard.timelock) : null;
  const fmtUsdt = (v: bigint) => `$${fmtNum(Number(formatUnits(v, dec('USDT'))))}`;
  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {anyone ? (
          <SettingsGroup>
            <View style={styles.addrRow}>
              <TextInput
                style={[styles.addrInput, draft.length > 0 && !parseAddress(network, draft) && styles.addrErr]}
                placeholder={t('mobile.vault.enter_address')}
                placeholderTextColor={c.subtext}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                value={draft}
                onChangeText={typeAddress}
              />
              {/* Typed (or scanned) wrong: cleared in one tap, as the amounts are. */}
              {draft.length > 0 ? <ClearBtn onPress={() => typeAddress('')} /> : null}
              <ScanButton onPress={() => setScanning(true)} />
            </View>
            <View style={styles.saveRow}>
              <View style={styles.toLine}>
                <Text style={styles.saveLabel}>{t('mobile.payments.save_to_payees')}</Text>
                {timelock != null && timelock !== ZERO ? <Text style={styles.toAddrMuted}>{`${t('mobile.payments.whitelist_wait')} ${fmtWait(timelock, t)}`}</Text> : null}
              </View>
              <Switch value={saveToBook && !lockedSends} disabled={lockedSends} onValueChange={setSaveToBook} />
            </View>
          </SettingsGroup>
        ) : (
          <SettingsGroup>
            <Pressable
              style={({pressed}) => [styles.toField, pressed && !to && styles.pressed]}
              disabled={!!to}
              onPress={() => nav.navigate('SelectRecipient')}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.payments.select_recipient')}>
              <AvatarIcon color={c.accent} />
              {to ? (
                <View style={styles.toLine}>
                  {label ? (
                    <Text style={styles.toValue} numberOfLines={1}>
                      {label}
                    </Text>
                  ) : null}
                  <Text style={label ? styles.toAddrMuted : styles.toAddr}>{displayAddress(network, to)}</Text>
                </View>
              ) : (
                <Text style={styles.toPlaceholder} numberOfLines={1}>
                  {t('mobile.payments.select_recipient')}
                </Text>
              )}
              {to ? null : <Text style={styles.chev}>›</Text>}
            </Pressable>
          </SettingsGroup>
        )}

        <SettingsGroup>
          {lines.map((l, k) => {
            const max = maxFor(l);
            const over = exceedsMax(l.amount, max);
            const hasAmount = Number(l.amount) > 0;
            return (
              <View key={k} style={[styles.line, k < lines.length - 1 && styles.lineDivider]}>
                <View style={styles.field}>
                  <Pressable style={styles.assetPill} onPress={() => setPicker({k})}>
                    <TokenIcon symbol={iconOf(l.sym)} size={20} />
                    <Text style={styles.assetSym}>{nameOf(l.sym)}</Text>
                  </Pressable>
                  <TextInput style={[styles.fieldInput, over && styles.inputOver]} keyboardType="decimal-pad" value={l.amount} selectTextOnFocus onChangeText={(v) => patchLine(k, {amount: v})} />
                  {hasAmount ? (
                    <ClearBtn onPress={() => patchLine(k, {amount: '0'})} />
                  ) : Number(max) > 0 ? (
                    <Pressable style={styles.maxBtn} onPress={() => patchLine(k, {amount: max})} hitSlop={8}>
                      <Text style={styles.balInline} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                        {fmtNum(Number(max))}
                      </Text>
                      <Text style={styles.maxBadge}>{t('common.max')}</Text>
                    </Pressable>
                  ) : null}
                </View>
                {over ? <Text style={styles.over}>{t('vault.exceeds_balance')}</Text> : null}
              </View>
            );
          })}
        </SettingsGroup>

        {pickable(null).length ? (
          <SettingsGroup>
            <Pressable style={({pressed}) => [styles.addRow, pressed && styles.pressed]} onPress={() => setPicker({k: null})}>
              <Text style={styles.addToken}>＋ {t('mobile.payments.add_token')}</Text>
            </Pressable>
          </SettingsGroup>
        ) : null}

        {lockBlocked ? (
          <Text style={styles.err}>{t('mobile.vault.lock_send_book_only')}</Text>
        ) : overAllowance && leftToday !== null ? (
          <Text style={styles.err}>{t('mobile.payments.over_send_allowance', {value: fmtUsdt(leftToday)})}</Text>
        ) : trxOut && !entry ? (
          <Text style={trxBlocked ? styles.err : styles.hint}>{t('mobile.payments.whitelisted_only', {tokens: nameOf('TRX')})}</Text>
        ) : null}
        {isSelf ? <Text style={styles.err}>{t('mobile.tron.acct_self')}</Text> : null}
        {quoteErr ? <Text style={styles.err}>{quoteErr}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <ConfirmButton
          onPress={() => void onSubmit()}
          loading={busy}
          disabled={!canSubmit}
          fee={false}
          networkFeeUsd={fee !== null ? Number(formatUnits(fee, dec('USDT'))) : undefined}
          pricing={sendCalls.length > 0 && !quote && !quoteErr}
        />
      </View>

      <Sheet visible={picker != null} title={t('vault.select_asset')} onClose={() => setPicker(null)} height={Math.round(screenHeight * 0.618)}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {picker == null
            ? null
            : pickable(picker.k).map((o) => {
                const on = picker.k != null && lines[picker.k]?.sym === o;
                return (
                  <Pressable key={o} style={styles.pickRow} onPress={() => choose(picker.k, o)}>
                    <TokenIcon symbol={iconOf(o)} size={30} />
                    <View style={styles.pickCol}>
                      <Text style={styles.pickLabel}>{nameOf(o)}</Text>
                      {o === 'TRX' ? <Text style={styles.pickNote}>{t('mobile.tron.acct_trx_payee_only')}</Text> : null}
                    </View>
                    <Text style={styles.pickSub}>{fmtNum(Number(formatUnits(held(o), dec(o))))}</Text>
                    {on ? (
                      <Svg width={18} height={18} viewBox="0 0 24 24">
                        <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      </Svg>
                    ) : null}
                  </Pressable>
                );
              })}
        </ScrollView>
      </Sheet>
      {anyone ? (
        <QrScanner
          visible={scanning}
          onScan={(a) => {
            setScanning(false);
            typeAddress(displayAddress(network, a));
          }}
          onClose={() => setScanning(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

// SendScreen's own styles, as they are there.
const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    scroll: {flex: 1},
    body: {flexGrow: 1, padding: 16, gap: 24, paddingBottom: 16},
    footer: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16},
    addrRow: {flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    addrInput: {flex: 1, minHeight: 56, color: c.text, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15},
    addrErr: {color: c.danger},
    saveRow: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 16},
    saveLabel: {color: c.text, fontSize: 15, fontWeight: '600'},
    toField: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 12, paddingHorizontal: 16},
    pressed: {opacity: 0.6},
    toLine: {flex: 1, gap: 2, minWidth: 0},
    toValue: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    toAddr: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
    toAddrMuted: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums']},
    toPlaceholder: {color: c.subtext, fontSize: 15, flex: 1},
    chev: {color: c.subtext, fontSize: 20, fontWeight: '300'},
    line: {gap: 4, paddingHorizontal: 16, paddingVertical: 8},
    lineDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    field: {flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 8},
    fieldInput: {flex: 1, minWidth: 0, color: c.text, fontSize: 17, paddingVertical: 0},
    maxBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 124},
    balInline: {color: c.subtext, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
    maxBadge: {color: c.accent, backgroundColor: c.accentSoft, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden'},
    assetPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10},
    assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
    over: {color: c.danger, fontSize: 12, paddingBottom: 4},
    inputOver: {color: c.danger},
    hint: {color: c.subtext, fontSize: 12},
    pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    pickCol: {flex: 1},
    pickLabel: {color: c.text, fontSize: 15, fontWeight: '600'},
    pickNote: {color: c.subtext, fontSize: 12, marginTop: 2},
    pickSub: {color: c.subtext, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
    addRow: {minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
    addToken: {color: c.accent, fontSize: 15, fontWeight: '600'},
    err: {color: c.danger, fontSize: 13},
  });

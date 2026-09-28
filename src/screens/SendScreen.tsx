import React, {useEffect, useMemo, useState} from 'react';
import {ActionSheetIOS, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {formatUnits, isAddress, parseUnits, type Address} from 'viem';
import {exceedsMax} from '@/components/AmountInput';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {AssetPicker} from '@/components/AssetPicker';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {ownerVaultAddress, balanceOfSymbol} from '@/vault/read';
import {sendPayment, batchSendPayment, fetchWhitelist, type WhitelistedRecipient} from '@/vault/payments';
import type {Position} from '@/vault/positions';
import {ASSETS} from '@/core/assets';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {displaySymbol, fmtNum} from '@/core/format';

type Line = {sym: string; amount: string};
type Recipient = {to: string; lines: Line[]};

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const newLine = (sym: string): Line => ({sym, amount: ''});
const parse = (v: string, d: number): bigint => {
  try {
    return v && Number(v) > 0 ? parseUnits(v as `${number}`, d) : 0n;
  } catch {
    return 0n;
  }
};

/**
 * Send composer, laid out like the web's: one card per recipient, each with token lines, and a line is
 * a single amount field with the asset pill inside it. The amount may exceed the free balance up to
 * what the asset's Earning (staking) / Lending positions hold: the vault withdraws the shortfall from
 * those first, then transfers the total. Sent as one gasless batch.
 */
export function SendScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const account = useWallet((s) => s.account);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const assets = ASSETS[network];
  const stable = assets.find((a) => a.kind === 'stable');
  const first = assets[0]?.symbol ?? 'USDC';
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const bal = useVaultBalances(network);
  const pos = useVaultPositions(vault, network);

  const [recipients, setRecipients] = useState<Recipient[]>([{to: '', lines: [newLine(first)]}]);
  const [book, setBook] = useState<WhitelistedRecipient[]>([]);
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (vault) fetchWhitelist(vault, network).then(setBook).catch(() => setBook([]));
  }, [vault, network]);

  const meta = (sym: string) => assets.find((a) => a.symbol === sym);
  const stakePos = (sym: string): Position | undefined => pos.positions.find((p) => p.kind === 'staked' && p.symbol === sym);
  const lendPos = (sym: string): Position | undefined => pos.positions.find((p) => p.kind === 'supplied' && p.symbol === sym);

  const patchR = (i: number, patch: Partial<Recipient>) => setRecipients((rs) => rs.map((r, j) => (j === i ? {...r, ...patch} : r)));
  const patchLine = (i: number, k: number, patch: Partial<Line>) =>
    patchR(i, {lines: recipients[i].lines.map((l, j) => (j === k ? {...l, ...patch} : l))});

  const addRecipient = () => setRecipients((rs) => [...rs, {to: '', lines: [newLine(first)]}]);
  const removeRecipient = (i: number) => setRecipients((rs) => rs.filter((_, j) => j !== i));
  const addLine = (i: number) => {
    const used = new Set(recipients[i].lines.map((l) => l.sym));
    const next = assets.find((a) => !used.has(a.symbol));
    if (next) patchR(i, {lines: [...recipients[i].lines, newLine(next.symbol)]});
  };
  const removeLine = (i: number, k: number) => patchR(i, {lines: recipients[i].lines.filter((_, j) => j !== k)});

  // Asset picker: a sheet with icons, opened for one line; the other lines' assets are excluded.
  const [picker, setPicker] = useState<{i: number; k: number} | null>(null);
  const pickAsset = (i: number, k: number) => setPicker({i, k});
  const pickerAssets = picker
    ? assets.filter((a) => !recipients[picker.i]?.lines.some((l, j) => j !== picker.k && l.sym === a.symbol))
    : [];

  const pickRecipient = (i: number) => {
    if (book.length === 0) {
      Alert.alert(t('mobile.payments.book_empty_title'), t('mobile.payments.book_empty_msg'));
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      {title: t('vault.address_book'), options: [...book.map((b) => short(b.recipientAddress)), t('common.cancel')], cancelButtonIndex: book.length},
      (idx) => idx < book.length && patchR(i, {to: book[idx].recipientAddress}),
    );
  };

  // What a symbol can pay out: the vault's free balance plus its Earning and Lending positions.
  const availability = (sym: string) => {
    const d = meta(sym)?.decimals ?? 18;
    const free = parse(balanceOfSymbol(bal.balances, sym), d);
    const sp = stakePos(sym);
    const lp = lendPos(sym);
    const staked = sp ? parse(sp.formatted, d) : 0n;
    const lent = lp ? parse(lp.formatted, d) : 0n;
    return {d, free, staked, lent, total: free + staked + lent, sp, lp};
  };

  // Line → {total (human), withdrawProtocols, withdrawAmounts}. The free balance pays first; what is
  // left comes out of Earning, then Lending. Null if it sends nothing.
  const lineToRow = (l: Line) => {
    const m = meta(l.sym);
    if (!m) return null;
    const a = availability(l.sym);
    const total = parse(l.amount, a.d);
    if (total === 0n) return null;
    let remaining = total > a.free ? total - a.free : 0n;
    const withdrawProtocols: Address[] = [];
    const withdrawAmounts: bigint[] = [];
    const fromStake = remaining > a.staked ? a.staked : remaining;
    if (fromStake > 0n && a.sp) {
      withdrawProtocols.push(a.sp.protocol);
      withdrawAmounts.push(fromStake);
      remaining -= fromStake;
    }
    const fromLend = remaining > a.lent ? a.lent : remaining;
    if (fromLend > 0n && a.lp) {
      withdrawProtocols.push(a.lp.protocol);
      withdrawAmounts.push(fromLend);
      remaining -= fromLend;
    }
    return {asset: m.address as Address, amount: formatUnits(total, a.d), withdrawProtocols, withdrawAmounts, fromPositions: fromStake + fromLend};
  };

  const rows = useMemo(
    () =>
      recipients.flatMap((r) =>
        isAddress(r.to)
          ? r.lines
              .map(lineToRow)
              .filter((x): x is NonNullable<typeof x> => x != null)
              .map((x) => ({recipient: r.to as Address, ...x}))
          : [],
      ),
    [recipients, network, pos.positions],
  );
  const maxFor = (sym: string) => {
    const a = availability(sym);
    return formatUnits(a.total, a.d);
  };
  const anyOver = recipients.some((r) => r.lines.some((l) => exceedsMax(l.amount, maxFor(l.sym))));
  const canSubmit = !!account && !!stable && status !== 'busy' && rows.length > 0 && !anyOver;

  const onSubmit = async () => {
    if (!vault || !stable) return;
    setStatus('busy');
    setErr(null);
    const tx = showTx(
      rows.length === 1
        ? `${t('vault.send')} ${fmtNum(Number(rows[0].amount))} ${displaySymbol(assets.find((a) => a.address === rows[0].asset)?.symbol ?? '')}`
        : t('mobile.payments.send_n_payments', {count: rows.length}),
      network,
    );
    try {
      const acct = await getSigner();
      const h =
        rows.length === 1
          ? await sendPayment({account: acct, vault, network, recipient: rows[0].recipient, asset: rows[0].asset, amount: rows[0].amount, withdrawProtocols: rows[0].withdrawProtocols, withdrawAmounts: rows[0].withdrawAmounts, stableCoin: stable.address})
          : await batchSendPayment({account: acct, vault, network, rows, stableCoin: stable.address});
      tx.success(h);
      setStatus('done');
      setRecipients([{to: '', lines: [newLine(first)]}]);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      tx.error(msg);
      setErr(msg);
      setStatus('error');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* The scroll view is the whole page, so a drag anywhere scrolls; the button holds the bottom. */}
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {recipients.map((r, i) => (
          <View key={i} style={styles.card}>
            <View style={styles.toRow}>
              <TextInput
                style={[styles.toInput, r.to.length > 0 && !isAddress(r.to) && styles.inputErr]}
                placeholder={t('mobile.vault.enter_address')}
                placeholderTextColor={c.subtext}
                autoCapitalize="none"
                autoCorrect={false}
                value={r.to}
                onChangeText={(v) => patchR(i, {to: v})}
              />
              <Pressable style={styles.bookBtn} onPress={() => pickRecipient(i)}>
                <Text style={styles.bookText}>{t('mobile.payments.book')}</Text>
              </Pressable>
              {i > 0 ? (
                <Pressable style={styles.iconBtn} onPress={() => removeRecipient(i)}>
                  <Text style={styles.iconRemove}>✕</Text>
                </Pressable>
              ) : null}
            </View>

            {r.lines.map((l, k) => {
              const av = availability(l.sym);
              const max = maxFor(l.sym);
              const over = exceedsMax(l.amount, max);
              const row = lineToRow(l);
              const sym = displaySymbol(l.sym);
              return (
                <View key={k} style={styles.line}>
                  {/* "Balance: 12.5 USDC  Max", with the remove control for an extra line. */}
                  <View style={styles.lineHead}>
                    <Text style={styles.balance}>
                      {t('vault.balance')}: <Amount v={fmtNum(Number(max))} /> {sym}
                    </Text>
                    <View style={styles.lineHeadRight}>
                      {Number(max) > 0 ? (
                        <Pressable onPress={() => patchLine(i, k, {amount: max})} hitSlop={6}>
                          <Text style={styles.maxText}>{t('common.max')}</Text>
                        </Pressable>
                      ) : null}
                      {r.lines.length > 1 ? (
                        <Pressable onPress={() => removeLine(i, k)} hitSlop={6}>
                          <Text style={styles.iconRemove}>✕</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>

                  {/* The field: amount on the left, the asset pill on the right (tap to change). */}
                  <View style={[styles.field, over && styles.fieldOver]}>
                    <TextInput
                      style={styles.fieldInput}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={c.subtext}
                      value={l.amount}
                      onChangeText={(v) => patchLine(i, k, {amount: v})}
                    />
                    <Pressable style={styles.assetPill} onPress={() => pickAsset(i, k)}>
                      <TokenIcon symbol={l.sym} size={20} />
                      <Text style={styles.assetSym}>{sym}</Text>
                    </Pressable>
                  </View>

                  {over ? (
                    <Text style={styles.over}>{t('vault.exceeds_balance')}</Text>
                  ) : row && row.fromPositions > 0n ? (
                    <Text style={styles.hint}>{t('mobile.payments.from_positions', {amount: fmtNum(Number(formatUnits(row.fromPositions, av.d))), symbol: sym})}</Text>
                  ) : null}
                </View>
              );
            })}

            {r.lines.length < assets.length ? (
              <Pressable onPress={() => addLine(i)}>
                <Text style={styles.addToken}>＋ {t('mobile.payments.add_token')}</Text>
              </Pressable>
            ) : null}
          </View>
        ))}

        <Pressable style={styles.addRecipient} onPress={addRecipient}>
          <Text style={styles.addRecipientText}>＋ {t('vault.add_recipient')}</Text>
        </Pressable>

        {status === 'error' && err ? <Text style={styles.err}>{err}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
      <ConfirmButton onPress={onSubmit} loading={status === 'busy'} disabled={!canSubmit} />
      </View>
      <AssetPicker
        visible={picker != null}
        title={t('vault.asset')}
        assets={pickerAssets}
        selected={picker ? recipients[picker.i]?.lines[picker.k]?.sym : undefined}
        onSelect={(sym) => picker && patchLine(picker.i, picker.k, {...newLine(sym)})}
        onClose={() => setPicker(null)}
      />
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  scroll: {flex: 1},
  body: {flexGrow: 1, padding: 16, gap: 12, paddingBottom: 16},
  footer: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16},
  card: {backgroundColor: c.card, borderRadius: 20, padding: 12, gap: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border},
  toRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  toInput: {flex: 1, height: 44, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, color: c.text, paddingHorizontal: 12, fontSize: 13, fontFamily: 'Menlo'},
  inputErr: {borderColor: c.danger},
  bookBtn: {paddingHorizontal: 12, height: 44, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center'},
  bookText: {color: c.accent, fontSize: 13, fontWeight: '600'},
  iconBtn: {width: 34, height: 44, alignItems: 'center', justifyContent: 'center'},
  iconRemove: {color: c.subtext, fontSize: 16},
  line: {gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  lineHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  lineHeadRight: {flexDirection: 'row', alignItems: 'center', gap: 14},
  balance: {color: c.subtext, fontSize: 12},
  maxText: {color: c.accent, fontSize: 13, fontWeight: '700'},
  field: {flexDirection: 'row', alignItems: 'center', height: 56, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.input, paddingLeft: 16, paddingRight: 8},
  fieldOver: {borderColor: c.danger},
  fieldInput: {flex: 1, color: c.text, fontSize: 18, paddingVertical: 0},
  assetPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10},
  assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
  over: {color: c.danger, fontSize: 12},
  hint: {color: c.subtext, fontSize: 12},
  addToken: {color: c.accent, fontSize: 13, fontWeight: '600'},
  addRecipient: {alignItems: 'center', paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, borderStyle: 'dashed'},
  addRecipientText: {color: c.accent, fontSize: 14, fontWeight: '600'},
  ok: {color: c.success, fontSize: 12, fontFamily: 'Menlo'},
  err: {color: c.danger, fontSize: 13},
});

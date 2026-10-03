import React, {useEffect, useMemo, useState} from 'react';
import {ActionSheetIOS, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {formatUnits, parseUnits, type Address} from 'viem';
import {isPayableAddress, isTokenAddress} from '@/core/asset-catalog';
import {exceedsMax} from '@/components/AmountInput';
import {TokenIcon} from '@/components/TokenIcon';
import Svg, {Circle, Path} from 'react-native-svg';
import {Sheet} from '@/components/Sheet';
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
import {relayGasFor} from '@/vault/fee-quote';
import {FEE_RESERVE} from '@/vault/gasless';

/** Where a line's tokens come from: the vault's free balance, its Sky position, or its Aave supply. */
type Source = 'free' | 'yield' | 'lend';
type Line = {sym: string; source: Source; amount: string};
type Recipient = {to: string; lines: Line[]};

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const lineKey = (l: {sym: string; source: Source}) => `${l.sym}:${l.source}`;
/**
 * A new line starts at 0, not blank.
 *
 * Empty read as half-drawn next to a filled asset pill and a Max badge. A zero is what the row is
 * actually worth until something is typed, and `lineToRow` already drops a zero from the batch, so
 * showing it changes nothing about what is sent. The field selects on focus, so typing replaces
 * the 0 rather than landing after it.
 */
const newLine = (sym: string, source: Source = 'free'): Line => ({sym, source, amount: '0'});
const parse = (v: string, d: number): bigint => {
  try {
    return v && Number(v) > 0 ? parseUnits(v as `${number}`, d) : 0n;
  } catch {
    return 0n;
  }
};

/**
 * Clear what is typed in an amount field.
 *
 * It stands exactly where the Max badge does and only one of the two is ever on screen: an empty
 * field offers Max, a filled one offers this. It takes over from the per-row delete control that
 * used to sit above each line — a row whose amount is empty contributes nothing to the batch, so
 * clearing IS how a token is dropped from a payment, and one ✕ now undoes a mistake instead of
 * destroying a row the user may still want to type into.
 *
 * Drawn rather than typed: the ✕ character renders at whatever weight the system font gives it and
 * sits off its optical centre, which is what made it read as a stray glyph.
 */
function ClearBtn({onPress}: {onPress: () => void}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable style={styles.clearBtn} onPress={onPress} hitSlop={12} accessibilityRole="button">
      <Svg width={11} height={11} viewBox="0 0 24 24">
        <Path d="M6 6l12 12M18 6 6 18" stroke={c.subtext} strokeWidth={3} strokeLinecap="round" fill="none" />
      </Svg>
    </Pressable>
  );
}

/**
 * The one control at the end of a recipient's address row: add another recipient, or drop this one.
 *
 * The first card can never be removed, so it carries the add — which is where the web puts it too,
 * and it means the right-hand end of the row always holds exactly one control rather than a button
 * for the book plus a delete floating above the card.
 */
function RecipientBtn({mode, onPress, label}: {mode: 'add' | 'remove'; onPress: () => void; label: string}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable style={styles.recipBtn} onPress={onPress} hitSlop={12} accessibilityRole="button" accessibilityLabel={label}>
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Path
          d={mode === 'add' ? 'M12 5v14M5 12h14' : 'M6 6l12 12M18 6 6 18'}
          stroke={mode === 'add' ? c.accent : c.subtext}
          strokeWidth={2.2}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    </Pressable>
  );
}

/**
 * The avatar that opens the address book — a mark inside the address field rather than a labelled
 * button beside it. The field is what it acts on, so it belongs in the field; the width it gives
 * back is width the address itself needed.
 *
 * A contact silhouette, not a book: what the control produces is a PERSON to pay, and the avatar is
 * the mark every phone already uses for that. FILLED rather than stroked, because the tile around
 * it is the frame an avatar wants — head and shoulders in solid accent read as a face at 20pt,
 * where two thin outlines inside a small square read as a diagram of one.
 *
 * The head overlaps the shoulder dome by a point, so the two shapes merge into one silhouette
 * instead of a circle floating above an arc.
 */
function AvatarIcon({color}: {color: string}) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Circle cx={12} cy={8} r={4.2} fill={color} />
      <Path d="M20 21a8 8 0 0 0-16 0Z" fill={color} />
    </Svg>
  );
}

/**
 * Send composer, laid out like the web's: one card per recipient, each with token lines, and a line is
 * a single amount field with the asset pill inside it.
 *
 * The pill picks the SOURCE as well as the token — "USDC", "USDC (Yielding)", "USDC (Lending)" — the
 * same way the web's asset dropdown surfaces the earning balance as its own entry. A line drawn from a
 * position withdraws exactly that amount from it and sends it; nothing is pulled from a position the
 * user did not choose. Sent as one gasless batch.
 */
export function SendScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const {height: screenHeight} = useWindowDimensions();
  const unlocked = useWallet((s) => s.unlocked);
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

  // One source of one asset: what it holds and, for a position, the adapter to withdraw from.
  const sourceOf = (sym: string, source: Source): {balance: string; protocol: Address | null} => {
    if (source === 'yield') {
      const p = stakePos(sym);
      return {balance: p?.formatted ?? '0', protocol: p?.protocol ?? null};
    }
    if (source === 'lend') {
      const p = lendPos(sym);
      return {balance: p?.formatted ?? '0', protocol: p?.protocol ?? null};
    }
    return {balance: balanceOfSymbol(bal.balances, sym), protocol: null};
  };
  const sourceLabel = (source: Source) =>
    source === 'yield' ? t('vault.yielding') : source === 'lend' ? t('vault.lending') : t('mobile.payments.from_vault');

  // Every asset/source the vault can actually pay from — the picker's rows.
  const sourceOptions = useMemo(
    () =>
      assets.flatMap((a) =>
        (['free', 'yield', 'lend'] as Source[])
          .map((source) => ({asset: a, source, ...sourceOf(a.symbol, source)}))
          .filter((o) => o.source === 'free' || Number(o.balance) > 0),
      ),
    [assets, bal.balances, pos.positions],
  );

  // What a recipient starts with: EVERY funded source of one token — a stablecoin the vault holds,
  // since that is what people send — so a vault with free, yielding and supplied USDC opens with all
  // three lines ready and nothing to add by hand. Falls back to any funded token, then to a blank
  // line on the first asset.
  const defaultLines = useMemo<Line[]>(() => {
    const funded = sourceOptions.filter((o) => Number(o.balance) > 0);
    const pick = funded.find((o) => o.asset.kind === 'stable') ?? funded[0];
    if (!pick) return [newLine(first)];
    return funded.filter((o) => o.asset.symbol === pick.asset.symbol).map((o) => newLine(o.asset.symbol, o.source));
  }, [sourceOptions, first]);

  // Until the user edits the token lines, every recipient tracks that set.
  //
  // It has to be a flag rather than "does this still look like the blank line": balances arrive
  // before positions, so the first pass sets [USDC], and a guard comparing against the original blank
  // line would then refuse the second pass — which is why the yielding line never appeared.
  const [linesTouched, setLinesTouched] = useState(false);
  useEffect(() => {
    if (linesTouched) return;
    setRecipients((rs) => rs.map((r) => ({...r, lines: defaultLines})));
  }, [defaultLines, linesTouched]);

  const patchR = (i: number, patch: Partial<Recipient>) => setRecipients((rs) => rs.map((r, j) => (j === i ? {...r, ...patch} : r)));

  const addRecipient = () => setRecipients((rs) => [...rs, {to: '', lines: defaultLines}]);

  // One transfer per funded line, plus one withdrawal for each distinct position the batch draws
  // on, so adding a recipient or funding a line from Earn moves the fee line with it.
  const feeGas = useMemo(() => {
    const funded = recipients.flatMap((r) => r.lines.filter((l) => Number(l.amount) > 0));
    const unwinds = new Set(funded.filter((l) => l.source !== 'free').map(lineKey));
    return relayGasFor({transfer: funded.length, withdraw: unwinds.size});
  }, [recipients]);
  const removeRecipient = (i: number) => setRecipients((rs) => rs.filter((_, j) => j !== i));

  const patchLine = (i: number, k: number, patch: Partial<Line>) => {
    setLinesTouched(true);
    patchR(i, {lines: recipients[i].lines.map((l, j) => (j === k ? {...l, ...patch} : l))});
  };
  /** One line's ceiling: what its own source still holds for this recipient. */
  const maxFor = (l: Line, ri: number): string =>
    formatUnits(remaining(l.sym, l.source, ri), meta(l.sym)?.decimals ?? 18);

  /**
   * Source picker — every place the vault can pay from as its own entry, "USDC", "USDC Yielding",
   * "USDC Lending", one flat list across all assets.
   *
   * A position is a token in its own right here rather than a mode of one: it has its own balance,
   * its own row on the card and its own amount, and choosing it is the same act as choosing a
   * different coin. `k` is the line being changed, or null when the row is being added.
   */
  const [picker, setPicker] = useState<{i: number; k: number | null} | null>(null);
  const fundRows = useMemo(() => sourceOptions.filter((o) => Number(o.balance) > 0), [sourceOptions]);
  /** What a recipient has not taken yet, plus whatever the row being changed already shows. */
  const pickableFor = (i: number, k: number | null) =>
    fundRows.filter((o) => {
      const key = `${o.asset.symbol}:${o.source}`;
      return !recipients[i].lines.some((l, j) => j !== k && lineKey(l) === key);
    });
  const choose = (i: number, k: number | null, sym: string, source: Source) => {
    setLinesTouched(true);
    const lines = recipients[i].lines;
    patchR(i, {lines: k == null ? [...lines, newLine(sym, source)] : lines.map((l, j) => (j === k ? newLine(sym, source) : l))});
    setPicker(null);
  };

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

  // Line → {amount, withdrawProtocols, withdrawAmounts}. A position source withdraws exactly what it
  // sends; the free balance withdraws nothing. Null if it sends nothing.
  const lineToRow = (l: Line) => {
    const m = meta(l.sym);
    if (!m) return null;
    const total = parse(l.amount, m.decimals);
    if (total === 0n) return null;
    const {protocol} = sourceOf(l.sym, l.source);
    return {
      asset: m.address as Address,
      amount: formatUnits(total, m.decimals),
      withdrawProtocols: protocol ? [protocol] : [],
      withdrawAmounts: protocol ? [total] : [],
    };
  };

  const rows = useMemo(
    () =>
      recipients.flatMap((r) =>
        isPayableAddress(r.to, network)
          ? r.lines
              .map(lineToRow)
              .filter((x): x is NonNullable<typeof x> => x != null)
              .map((x) => ({recipient: r.to as Address, ...x}))
          : [],
      ),
    [recipients, network, pos.positions],
  );
  /**
   * What ONE line may still draw: its source's balance less everything every other line already
   * claims from that same source.
   *
   * Without the subtraction, Max on the first recipient took the whole balance and the second
   * recipient was offered the same balance again — the composer looked fine and the batch then
   * failed on-chain for want of funds. Counted in base units, not floats, so Max on an 18-decimal
   * token is exact rather than a rounded value that overshoots by a wei.
   *
   * The free balance of the fee coin also holds {FEE_RESERVE} back. The relayer charges the fee
   * AFTER the transfers, so a batch that sends every last unit of the coin it is billed in reverts
   * at the charge with `fee-leg-failed` — the same trap the market order avoids the same way.
   */
  const remaining = (sym: string, source: Source, ri: number): bigint => {
    const d = meta(sym)?.decimals ?? 18;
    const key = `${sym}:${source}`;
    const reserve = source === 'free' && sym === stable?.symbol ? parse(String(FEE_RESERVE[network]), d) : 0n;
    let left = parse(sourceOf(sym, source).balance, d) - reserve;
    // Every OTHER recipient's claim on the same source. A recipient never holds two lines of one
    // source, so skipping its own row is enough to leave its own amount editable.
    recipients.forEach((r, i) => {
      if (i === ri) return;
      r.lines.forEach((o) => {
        if (lineKey(o) === key) left -= parse(o.amount, d);
      });
    });
    return left > 0n ? left : 0n;
  };
  const anyOver = recipients.some((r, i) => r.lines.some((l) => exceedsMax(l.amount, maxFor(l, i))));
  const canSubmit = unlocked && !!stable && status !== 'busy' && rows.length > 0 && !anyOver;

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
      setRecipients([{to: '', lines: defaultLines}]);
      setLinesTouched(false);
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
            {/* The address, as on the web: the book is a mark INSIDE the field, and the one button
                at the end of the row adds the next recipient or drops this one. The card no longer
                carries a delete of its own — there was nothing for a second control to mean. */}
            <View style={styles.toRow}>
              <View style={[styles.toField, r.to.length > 0 && !isPayableAddress(r.to, network) && styles.inputErr]}>
                {/* A tinted tile, not a bare glyph: inside a field an icon on its own reads as
                    decoration — a label for what the field holds — and nobody tries tapping it.
                    The fill gives it an edge, the accent says it does something, and it dims on
                    press like every other button in the app. */}
                <Pressable
                  style={({pressed}) => [styles.bookBtn, pressed && styles.bookBtnOn]}
                  onPress={() => pickRecipient(i)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('vault.address_book')}>
                  <AvatarIcon color={c.accent} />
                </Pressable>
                <TextInput
                  style={styles.toInput}
                  placeholder={t('mobile.vault.enter_address')}
                  placeholderTextColor={c.subtext}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={r.to}
                  onChangeText={(v) => patchR(i, {to: v})}
                />
              </View>
              <RecipientBtn
                mode={i === 0 ? 'add' : 'remove'}
                label={i === 0 ? t('vault.add_recipient') : t('vault.remove')}
                onPress={() => (i === 0 ? addRecipient() : removeRecipient(i))}
              />
            </View>
            {/* Named, not just refused: a well-formed address that the field rejects looks like a
                bug unless the screen says what is wrong with it. */}
            {isTokenAddress(r.to, network) ? (
              <Text style={styles.over}>{t('mobile.payments.token_address_warning')}</Text>
            ) : null}

            {r.lines.map((l, k) => {
              const max = maxFor(l, i);
              const over = exceedsMax(l.amount, max);
              const sym = displaySymbol(l.sym);
              const hasAmount = Number(l.amount) > 0;
              return (
                <View key={k} style={styles.line}>
                  {/* Asset first, amount after it, as on the web: the row reads "what, then how
                      much". The pill picks the token AND the source it comes out of. At the end,
                      exactly one control — what this source still holds with a Max badge while the
                      field is empty, and a clear once something is typed.
                      
                      There is no delete. A row with nothing in its amount is not part of the
                      payment: `lineToRow` returns null for a zero, so the batch is built from the
                      funded rows alone. Clearing the amount IS removing the row, which leaves one
                      control at the end of the bar instead of two that both look like they undo
                      something. */}
                  <View style={[styles.field, over && styles.fieldOver]}>
                    <Pressable style={styles.assetPill} onPress={() => setPicker({i, k})}>
                      <TokenIcon symbol={l.sym} size={20} />
                      <Text style={styles.assetSym}>{sym}</Text>
                      {l.source !== 'free' ? <Text style={styles.assetSource}>{sourceLabel(l.source)}</Text> : null}
                    </Pressable>
                    <TextInput
                      style={styles.fieldInput}
                      keyboardType="decimal-pad"
                      value={l.amount}
                      selectTextOnFocus
                      onChangeText={(v) => patchLine(i, k, {amount: v})}
                    />
                    {hasAmount ? (
                      <ClearBtn onPress={() => patchLine(i, k, {amount: '0'})} />
                    ) : Number(max) > 0 ? (
                      <Pressable style={styles.maxBtn} onPress={() => patchLine(i, k, {amount: max})} hitSlop={8}>
                        <Text style={styles.balInline} numberOfLines={1}>{fmtNum(Number(max))}</Text>
                        {/* `common.max` and NOT `vault.max`: the latter is the literal "Max" in
                            every locale that has it and missing from seven of them, so the badge
                            was English at best. This is the same key the Trade screen's Max pill
                            uses, and it is translated everywhere. */}
                        <Text style={styles.maxBadge}>{t('common.max')}</Text>
                      </Pressable>
                    ) : null}
                  </View>

                  {over ? <Text style={styles.over}>{t('vault.exceeds_balance')}</Text> : null}
                </View>
              );
            })}

            {/* Offered while this recipient still has a token left to take — the same list the
                chooser would show, so the control never opens an empty sheet. Counting lines
                against sources, as this once did, hid it whenever one token filled every funded
                source and left the second token unreachable. */}
            {pickableFor(i, null).length > 0 ? (
              <Pressable onPress={() => setPicker({i, k: null})}>
                <Text style={styles.addToken}>＋ {t('mobile.payments.add_token')}</Text>
              </Pressable>
            ) : null}
          </View>
        ))}

        {status === 'error' && err ? <Text style={styles.err}>{err}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
      <ConfirmButton onPress={onSubmit} disabled={!canSubmit} gas={feeGas} />
      </View>
      {/* One flat list of every place the vault can pay from. Tapping an entry picks it and
          closes — a row carries one source, and its amount is set on the card. */}
      <Sheet
        visible={picker != null}
        title={t('vault.select_asset')}
        onClose={() => setPicker(null)}
        height={Math.round(screenHeight * 0.618)}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {picker == null
            ? null
            : pickableFor(picker.i, picker.k).map((o) => {
                const sym = displaySymbol(o.asset.symbol);
                const key = `${o.asset.symbol}:${o.source}`;
                const line = picker.k == null ? null : recipients[picker.i].lines[picker.k];
                const on = line != null && lineKey(line) === key;
                return (
                  <Pressable key={key} style={styles.pickRow} onPress={() => choose(picker.i, picker.k, o.asset.symbol, o.source)}>
                    <TokenIcon symbol={o.asset.symbol} size={30} />
                    <View style={styles.pickCol}>
                      <Text style={styles.pickLabel}>{o.source === 'free' ? sym : `${sym} ${sourceLabel(o.source)}`}</Text>
                    </View>
                    <Text style={styles.pickSub}>
                      {fmtNum(Number(formatUnits(remaining(o.asset.symbol, o.source, picker.i), o.asset.decimals)))}
                    </Text>
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
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  scroll: {flex: 1},
  body: {flexGrow: 1, padding: 16, gap: 12, paddingBottom: 16},
  footer: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16},
  card: {backgroundColor: c.card, borderRadius: 20, borderCurve: 'continuous', padding: 12, gap: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border},
  toRow: {flexDirection: 'row', alignItems: 'center', gap: 2},
  // The book icon lives in here, so the field is the container and the input is what sits beside it.
  toField: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, borderRadius: 10, backgroundColor: c.input, paddingLeft: 5, paddingRight: 12},
  // Inset by the field's own 5 on every side, so the tile sits in the bar rather than against it.
  // A full circle now that it holds an avatar: that is the shape a face is framed in everywhere
  // else on a phone, and it is what tells the mark apart from the squared controls on the row.
  bookBtn: {width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: c.card},
  bookBtnOn: {opacity: 0.6},
  toInput: {flex: 1, color: c.text, fontSize: 15, fontFamily: 'Menlo', paddingVertical: 0},
  inputErr: {borderWidth: 1, borderColor: c.danger},
  /**
   * Borderless and only as wide as the glyph: it is one mark at the end of the row, not a second
   * field beside the address.
   *
   * 26 rather than 36, because the width it took came straight out of the field next to it — the
   * address is 42 characters of monospace and the amount shares its bar with a pill and a Max
   * badge, so both were paying for whitespace around an 18pt icon. The TOUCH target is unchanged:
   * hitSlop on each control carries it back past 44, which is what the finger actually hits.
   * Full field height, so the mark centres on the field rather than floating beside it.
   */
  recipBtn: {width: 26, height: 44, alignItems: 'center', justifyContent: 'center'},
  clearBtn: {width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.neutralSoft},
  // No rule between rows: the card's own gap separates them, and each field is a filled bar that
  // already reads as its own object.
  line: {gap: 6},
  field: {flexDirection: 'row', alignItems: 'center', height: 56, borderRadius: 12, backgroundColor: c.input, paddingLeft: 8, paddingRight: 8, gap: 8},
  fieldOver: {borderWidth: 1, borderColor: c.danger},
  // minWidth 0 so a long balance beside it cannot push the input past the field's edge.
  fieldInput: {flex: 1, minWidth: 0, color: c.text, fontSize: 17, paddingVertical: 0},
  // Balance and badge are one target: tapping either fills the field, as on the web.
  maxBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 124},
  balInline: {color: c.subtext, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
  maxBadge: {color: c.accent, backgroundColor: c.accentSoft, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden'},
  assetPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10},
  assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
  assetSource: {color: c.subtext, fontSize: 11, fontWeight: '600'},
  over: {color: c.danger, fontSize: 12},
  hint: {color: c.subtext, fontSize: 12},
  // The chooser's rows: FundRow's head metrics, so switching from the list to the sources does
  // not shift anything sideways or vertically.
  pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  pickCol: {flex: 1},
  pickLabel: {color: c.text, fontSize: 15, fontWeight: '600'},
  pickSub: {color: c.subtext, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
  addToken: {color: c.accent, fontSize: 13, fontWeight: '600'},
  ok: {color: c.success, fontSize: 12, fontFamily: 'Menlo'},
  err: {color: c.danger, fontSize: 13},
});

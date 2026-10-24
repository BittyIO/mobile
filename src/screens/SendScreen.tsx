import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {formatUnits, parseUnits, type Address} from 'viem';
import {isPayableAddress} from '@/core/asset-catalog';
import {exceedsMax} from '@/components/AmountInput';
import {useRecipientPick} from '@/core/recipient-pick';
import {TokenIcon} from '@/components/TokenIcon';
import {ClearBtn} from '@/components/ClearBtn';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import Svg, {Circle, Path} from 'react-native-svg';
import {Sheet} from '@/components/Sheet';
import {SettingsGroup} from '@/components/SettingsRow';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {balanceOfSymbol} from '@/vault/read';
import {useActiveVaultAddress} from '@/core/active-vault';
import {fetchWhitelist, sendToWhitelisted, sendWithWhitelist, type WhitelistedRecipient} from '@/vault/payments';
import {useCustomTokens} from '@/vault/custom-tokens';
import {WHITELIST_STATUS} from '@/core/abi';
import type {Position} from '@/vault/positions';

import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {displaySymbol, fmtNum, fmtShort} from '@/core/format';
import {quoteRelayFeeUsd, relayGasFor} from '@/vault/fee-quote';
import {FEE_WETH, reserveHeld, resolveFeeReserve, useWethFeeCoin} from '@/vault/stableCoinAsGas';

import {useAssetCatalog} from '@/core/asset-catalog';

/**
 * Where a line's tokens come from: the vault's free balance, its Sky position, its Aave supply, or
 * the stablecoin reserve — the part of the free balance the Network fee page sets aside for fees,
 * shown as its own line so spending it is a choice the owner sees.
 */
type Source = 'free' | 'yield' | 'lend' | 'reserve';
type Line = {sym: string; source: Source; amount: string};
type Recipient = {
  to: string;
  lines: Line[];
  /** What to show instead of the raw address — a vault's own name, where it has one. */
  label?: string;
  /** Typed in and not yet in the book: the send writes the entry in the same transaction. */
  needsWhitelist?: boolean;
};

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

type Row = {asset: Address; amount: string; withdrawProtocols: Address[]; withdrawAmounts: bigint[]; decimals: number};
/**
 * A coin's free and reserve lines are one balance on chain, so they go out as one transfer: two
 * rows of the same asset with nothing to withdraw are summed into the first.
 */
const mergeFree = (rows: Row[]): Row[] => {
  const out: Row[] = [];
  for (const r of rows) {
    const same = r.withdrawProtocols.length === 0 && out.find((o) => o.asset === r.asset && o.withdrawProtocols.length === 0);
    if (same) same.amount = formatUnits(parseUnits(same.amount, r.decimals) + parseUnits(r.amount, r.decimals), r.decimals);
    else out.push({...r});
  }
  return out;
};
const parse = (v: string, d: number): bigint => {
  try {
    return v && Number(v) > 0 ? parseUnits(v as `${number}`, d) : 0n;
  } catch {
    return 0n;
  }
};


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
 * Send composer: one recipient, with token lines, and a line is a single amount field with the asset
 * pill inside it. One recipient per payment, as the vault's own sends are; several tokens to that
 * recipient go out together.
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
  const assets = useAssetCatalog(network);
  const stable = assets.find((a) => a.kind === 'stable');
  const first = assets[0]?.symbol ?? 'USDC';
  const vault = useActiveVaultAddress(network);

  const bal = useVaultBalances(network);
  const weth = useWethFeeCoin(network, vault);
  const pos = useVaultPositions(vault, network);
  // Tokens pasted in by contract address. A line on one carries the ADDRESS as its `sym` — a pasted
  // token may call itself anything, "USDC" included, so its name never keys or matches anything.
  const custom = useCustomTokens(network, vault);
  const customOf = (sym: string) => custom.tokens.find((x) => x.address.toLowerCase() === sym.toLowerCase());
  /** What a line's token is called on screen. */
  const nameOf = (sym: string) => customOf(sym)?.symbol ?? displaySymbol(sym);
  // The address book, for the id a whitelisted payment is made by.
  const [book, setBook] = useState<WhitelistedRecipient[]>([]);
  useEffect(() => {
    if (vault) fetchWhitelist(vault, network).then(setBook);
  }, [vault, network]);

  const [recipient, setRecipient] = useState<Recipient>({to: '', lines: [newLine(first)]});
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  /**
   * A recipient chosen on the pushed page is left in a one-slot store and the page unwinds.
   *
   * Applied and then cleared, so returning to this screen later does not re-apply the last
   * pick over whatever is there now.
   */
  const picked = useRecipientPick((st) => st.picked);
  const clearPicked = useRecipientPick((st) => st.clear);
  useEffect(() => {
    if (!picked) return;
    patchR({to: picked.address, label: picked.label, needsWhitelist: picked.addToBook});
    clearPicked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const meta = (sym: string): {symbol: string; address: Address; decimals: number; kind: string} | undefined => {
    const x = customOf(sym);
    return x ? {symbol: sym, address: x.address, decimals: x.decimals, kind: 'custom'} : assets.find((a) => a.symbol === sym);
  };
  /**
   * Whether a plain send can carry this token: only an allowed stablecoin can, metered by the daily
   * send allowance. Anything else — ETH, BTC, a stock, a pasted token — the vault pays only to a
   * whitelisted recipient whose timelock has run out.
   */
  const plain = (sym: string) => meta(sym)?.kind === 'stable';
  const stakePos = (sym: string): Position | undefined => pos.positions.find((p) => p.kind === 'staked' && p.symbol === sym);
  const lendPos = (sym: string): Position | undefined => pos.positions.find((p) => p.kind === 'supplied' && p.symbol === sym);

  // One source of one asset: what it holds and, for a position, the adapter to withdraw from.
  const sourceOf = (sym: string, source: Source): {balance: string; protocol: Address | null} => {
    const x = customOf(sym);
    if (x) return {balance: source === 'free' ? x.balance : '0', protocol: null};
    if (source === 'yield') {
      const p = stakePos(sym);
      return {balance: p?.formatted ?? '0', protocol: p?.protocol ?? null};
    }
    if (source === 'lend') {
      const p = lendPos(sym);
      return {balance: p?.formatted ?? '0', protocol: p?.protocol ?? null};
    }
    // The free balance, split: what the reserve sets aside, and the rest. Both are paid from the
    // same balance on chain; the split is only how the card shows it.
    const total = balanceOfSymbol(bal.balances, sym);
    const held = reserveHeld(reserveSize(sym), Number(total));
    const d = meta(sym)?.decimals ?? 18;
    const heldUnits = held > 0 ? parse(held.toFixed(Math.min(d, 6)), d) : 0n;
    const totalUnits = parse(total, d);
    const units = source === 'reserve' ? heldUnits : totalUnits - heldUnits;
    return {balance: formatUnits(units > 0n ? units : 0n, d), protocol: null};
  };
  /** The reserve this coin carries, in tokens: its size when it is the reserve coin, else 0. */
  const reserveSize = (sym: string): number =>
    resolveFeeReserve({
      network,
      vault: bal.vault,
      heldStables: [
        ...assets
          .filter((a) => a.kind === 'stable')
          .map((a) => ({symbol: a.symbol, amount: Number(balanceOfSymbol(bal.balances, a.symbol))})),
        ...(weth ? [{symbol: FEE_WETH, amount: Number(balanceOfSymbol(bal.balances, FEE_WETH) || 0), usd: weth.usd}] : []),
      ],
      spendSymbol: sym,
    }).keep;
  const sourceLabel = (source: Source) =>
    source === 'yield'
      ? t('vault.yielding')
      : source === 'lend'
        ? t('vault.lending')
        : source === 'reserve'
          ? t('mobile.payments.source_reserve')
          : t('mobile.payments.from_vault');

  // Every asset/source the vault can actually pay from — the picker's rows.
  type SourceOption = {asset: {symbol: string; address: Address; decimals: number; kind: string}; source: Source; balance: string; protocol: Address | null};
  const sourceOptions = useMemo<SourceOption[]>(
    () =>
      assets.flatMap((a): SourceOption[] =>
        (['free', 'reserve', 'yield', 'lend'] as Source[])
          .map((source) => ({asset: a, source, ...sourceOf(a.symbol, source)}))
          .filter((o) => o.source === 'free' || Number(o.balance) > 0),
      ).concat(
        custom.tokens.map((x) => ({
          asset: {symbol: x.address, address: x.address, decimals: x.decimals, kind: 'custom'},
          source: 'free',
          balance: x.balance,
          protocol: null,
        })),
      ),
    [assets, bal.balances, pos.positions, custom.tokens],
  );

  // What the recipient starts with: EVERY funded source of one token — a stablecoin the vault holds,
  // since that is what people send — so a vault with free, yielding and supplied USDC opens with all
  // three lines ready and nothing to add by hand. Falls back to any funded token, then to a blank
  // line on the first asset.
  const defaultLines = useMemo<Line[]>(() => {
    const funded = sourceOptions.filter((o) => Number(o.balance) > 0);
    const pick = funded.find((o) => o.asset.kind === 'stable') ?? funded[0];
    if (!pick) return [newLine(first)];
    return funded.filter((o) => o.asset.symbol === pick.asset.symbol).map((o) => newLine(o.asset.symbol, o.source));
  }, [sourceOptions, first]);

  // Until the user edits the token lines, the recipient tracks that set.
  //
  // It has to be a flag rather than "does this still look like the blank line": balances arrive
  // before positions, so the first pass sets [USDC], and a guard comparing against the original blank
  // line would then refuse the second pass — which is why the yielding line never appeared.
  const [linesTouched, setLinesTouched] = useState(false);
  useEffect(() => {
    if (linesTouched) return;
    setRecipient((r) => ({...r, lines: defaultLines}));
  }, [defaultLines, linesTouched]);

  const patchR = (patch: Partial<Recipient>) => setRecipient((r) => ({...r, ...patch}));

  // One transfer per funded line, plus one withdrawal for each distinct position the payment draws
  // on, so funding a line from Earn moves the fee line with it.
  const feeGas = useMemo(() => {
    const funded = recipient.lines.filter((l) => Number(l.amount) > 0);
    const unwinds = new Set(funded.filter((l) => l.source !== 'free').map(lineKey));
    return relayGasFor({transfer: funded.length, withdraw: unwinds.size});
  }, [recipient]);

  const patchLine = (k: number, patch: Partial<Line>) => {
    setLinesTouched(true);
    patchR({lines: recipient.lines.map((l, j) => (j === k ? {...l, ...patch} : l))});
  };
  /** One line's ceiling: what its own source still holds. */
  const maxFor = (l: Line): string => formatUnits(remaining(l.sym, l.source), meta(l.sym)?.decimals ?? 18);

  /**
   * Source picker — every place the vault can pay from as its own entry, "USDC", "USDC Yielding",
   * "USDC Lending", one flat list across all assets.
   *
   * A position is a token in its own right here rather than a mode of one: it has its own balance,
   * its own row on the card and its own amount, and choosing it is the same act as choosing a
   * different coin. `k` is the line being changed, or null when the row is being added.
   */
  const [picker, setPicker] = useState<{k: number | null} | null>(null);
  const fundRows = useMemo(() => sourceOptions.filter((o) => Number(o.balance) > 0), [sourceOptions]);

  // The fee for sending what the card holds: one transfer per line, one withdrawal per position,
  // counted whether or not a line has an amount yet — so filling one with Max does not move the
  // figure Max was taken against. The live quote with half again on top for gas moving before it
  // lands, whole cents up, at least one cent — what the fee coin keeps back (see {remaining}).
  // Priced for every source the vault holds, doubled, it left dollars behind on a one-coin send.
  const cardGas = useMemo(() => {
    const unwinds = new Set(recipient.lines.filter((l) => l.source !== 'free' && l.source !== 'reserve').map(lineKey));
    return relayGasFor({transfer: Math.max(1, recipient.lines.length), withdraw: unwinds.size});
  }, [recipient.lines]);
  const [feeKeep, setFeeKeep] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    setFeeKeep(null);
    quoteRelayFeeUsd(network, cardGas).then((usd) => {
      if (live && usd != null) setFeeKeep(Math.max(0.01, Math.ceil(usd * 1.5 * 100) / 100));
    });
    return () => {
      live = false;
    };
  }, [network, cardGas]);
  /** What the recipient has not taken yet, plus whatever the row being changed already shows. */
  const pickableFor = (k: number | null) =>
    fundRows.filter((o) => {
      const key = `${o.asset.symbol}:${o.source}`;
      return !recipient.lines.some((l, j) => j !== k && lineKey(l) === key);
    });
  const choose = (k: number | null, sym: string, source: Source) => {
    setLinesTouched(true);
    const lines = recipient.lines;
    patchR({lines: k == null ? [...lines, newLine(sym, source)] : lines.map((l, j) => (j === k ? newLine(sym, source) : l))});
    setPicker(null);
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
      decimals: m.decimals,
    };
  };

  const rows = useMemo(
    () =>
      isPayableAddress(recipient.to, network)
        ? mergeFree(recipient.lines.map(lineToRow).filter((x): x is NonNullable<typeof x> => x != null))
        : [],
    [recipient, network, pos.positions],
  );
  /**
   * What ONE line may still draw: its source's balance. The recipient never holds two lines of one
   * source, so no other line claims from it. Counted in base units, not floats, so Max on an
   * 18-decimal token is exact rather than a rounded value that overshoots by a wei.
   *
   * The fee coin keeps back what this very send will be billed: the relayer charges AFTER the
   * transfers, so a batch that sends every last unit of the coin it is billed in reverts at the
   * charge with `fee-leg-failed`. That fee is priced for the card as it stands — every line on it,
   * each position unwound — at half again the live quote, so a gas rise before it lands cannot
   * outgrow it; adding a line re-prices it. It comes out of the reserve line first and
   * the free line after; while the quote is out (or failed), the whole reserve is held.
   */
  const remaining = (sym: string, source: Source): bigint => {
    const d = meta(sym)?.decimals ?? 18;
    const own = parse(sourceOf(sym, source).balance, d);
    if (sym !== stable?.symbol || (source !== 'free' && source !== 'reserve')) return own;
    const held = parse(sourceOf(sym, 'reserve').balance, d);
    const fee = feeKeep == null ? held : parse(feeKeep.toFixed(Math.min(d, 6)), d);
    const left = source === 'reserve' ? own - fee : own - (fee > held ? fee - held : 0n);
    return left > 0n ? left : 0n;
  };
  const anyOver = recipient.lines.some((l) => exceedsMax(l.amount, maxFor(l)));
  // The funded lines a plain send would refuse, by name. Any one of them sends the whole card as a
  // whitelisted payment — stablecoins too, which a whitelisted recipient can be paid in as well.
  const bookOnly = Array.from(new Set(recipient.lines.filter((l) => Number(l.amount) > 0 && !plain(l.sym)).map((l) => nameOf(l.sym))));
  const entry = recipient.to
    ? book.find(
        (b) =>
          b.recipientAddress.toLowerCase() === recipient.to.toLowerCase() &&
          (b.status === undefined || b.status === WHITELIST_STATUS.payable || b.status === WHITELIST_STATUS.removalQueued),
      )
    : undefined;
  const bookBlocked = bookOnly.length > 0 && !!recipient.to && !entry;
  const canSubmit = unlocked && !!stable && status !== 'busy' && rows.length > 0 && !anyOver && !bookBlocked;

  const onSubmit = async () => {
    if (!vault || !stable) return;
    setStatus('busy');
    setErr(null);
    const tx = showTx(
      rows.length === 1
        ? // `fmtShort`, as the lists use: `fmtNum` keeps up to seven decimals under 1, which is right
          // for a balance and too long for a line reporting what was just sent.
          `${t('vault.send')} ${fmtShort(Number(rows[0].amount))} ${nameOf(assets.find((a) => a.address === rows[0].asset)?.symbol ?? rows[0].asset)}`
        : t('mobile.payments.send_n_payments', {count: rows.length}),
      network,
    );
    try {
      const acct = await getSigner();
      const h =
        bookOnly.length > 0 && entry
          ? await sendToWhitelisted({account: acct, vault, network, id: entry.id, rows, stableCoin: stable.address})
          : await sendWithWhitelist({
              account: acct,
              vault,
              network,
              recipient: recipient.to as Address,
              rows,
              addToWhitelist: !!recipient.needsWhitelist,
              stableCoin: stable.address,
            });
      tx.success(h);
      setStatus('done');
      setRecipient({to: '', lines: defaultLines});
      setLinesTouched(false);
      custom.reload();
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
        {/* Grouped like Settings: who, then what, then a way to add more. */}
        <SettingsGroup>
            {/* Chosen, not typed. The common case on this screen is paying somewhere the vault
                has paid before, or one of the owner's own vaults, and both are lists the app
                already holds; typing an address is the exception and lives inside the picker.
                */}
              <Pressable
                style={({pressed}) => [styles.toField, pressed && styles.pressed]}
                onPress={() => nav.navigate('SelectRecipient')}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.payments.select_recipient')}>
                {/* The mark alone, no disc. It was a tinted tile when it was a BUTTON inside a
                    text field and had to look tappable; the whole row is the button now, so the
                    disc was a second target drawn around nothing. */}
                <AvatarIcon color={c.accent} />
                {/* Name AND address: the name is what the user recognises and the address is what
                    actually gets paid, so neither can be the only thing shown. The address is
                    shown in full, wrapping if it must — the bar grows rather than cut it, since
                    a shortened address is one a look-alike can pass for. */}
                {recipient.to ? (
                  <View style={styles.toLine}>
                    {recipient.label ? (
                      <Text style={styles.toValue} numberOfLines={1}>
                        {recipient.label}
                      </Text>
                    ) : null}
                    <Text style={recipient.label ? styles.toAddrMuted : styles.toAddr}>
                      {recipient.to}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.toPlaceholder} numberOfLines={1}>
                    {t('mobile.payments.select_recipient')}
                  </Text>
                )}
                <Text style={styles.chev}>›</Text>
              </Pressable>
        </SettingsGroup>
        <SettingsGroup>
            {recipient.lines.map((l, k) => {
              const max = maxFor(l);
              const over = exceedsMax(l.amount, max);
              const sym = nameOf(l.sym);
              const hasAmount = Number(l.amount) > 0;
              return (
                <View key={k} style={[styles.line, k < recipient.lines.length - 1 && styles.lineDivider]}>
                  {/* Asset first, amount after it, as on the web: the row reads "what, then how
                      much". The pill picks the token AND the source it comes out of. At the end,
                      exactly one control — what this source still holds with a Max badge while the
                      field is empty, and a clear once something is typed.
                      
                      There is no delete. A row with nothing in its amount is not part of the
                      payment: `lineToRow` returns null for a zero, so the batch is built from the
                      funded rows alone. Clearing the amount IS removing the row, which leaves one
                      control at the end of the bar instead of two that both look like they undo
                      something. */}
                  <View style={styles.field}>
                    <Pressable style={styles.assetPill} onPress={() => setPicker({k})}>
                      <TokenIcon symbol={nameOf(l.sym)} size={20} badgeOnly={!!customOf(l.sym)} />
                      <Text style={styles.assetSym}>{sym}</Text>
                      {l.source !== 'free' ? <Text style={styles.assetSource}>{sourceLabel(l.source)}</Text> : null}
                    </Pressable>
                    <TextInput
                      style={[styles.fieldInput, over && styles.inputOver]}
                      keyboardType="decimal-pad"
                      value={l.amount}
                      selectTextOnFocus
                      onChangeText={(v) => patchLine(k, {amount: v})}
                    />
                    {hasAmount ? (
                      <ClearBtn onPress={() => patchLine(k, {amount: '0'})} />
                    ) : Number(max) > 0 ? (
                      <Pressable style={styles.maxBtn} onPress={() => patchLine(k, {amount: max})} hitSlop={8}>
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
        </SettingsGroup>

            {/* Offered while the recipient still has a token left to take — the same list the
                chooser would show, so the control never opens an empty sheet. Counting lines
                against sources, as this once did, hid it whenever one token filled every funded
                source and left the second token unreachable. */}
            {pickableFor(null).length > 0 ? (
              <SettingsGroup>
                <Pressable style={({pressed}) => [styles.addRow, pressed && styles.pressed]} onPress={() => setPicker({k: null})}>
                  <Text style={styles.addToken}>＋ {t('mobile.payments.add_token')}</Text>
                </Pressable>
              </SettingsGroup>
            ) : null}

        {bookOnly.length > 0 ? (
          <Text style={bookBlocked ? styles.err : styles.hint}>
            {t('mobile.payments.whitelisted_only', {tokens: bookOnly.join(', ')})}
          </Text>
        ) : null}
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
            : pickableFor(picker.k).map((o) => {
                const sym = nameOf(o.asset.symbol);
                const pasted = customOf(o.asset.symbol);
                const key = `${o.asset.symbol}:${o.source}`;
                const line = picker.k == null ? null : recipient.lines[picker.k];
                const on = line != null && lineKey(line) === key;
                return (
                  <Pressable key={key} style={styles.pickRow} onPress={() => choose(picker.k, o.asset.symbol, o.source)}>
                    <TokenIcon symbol={sym} size={30} badgeOnly={!!pasted} />
                    <View style={styles.pickCol}>
                      <Text style={styles.pickLabel}>{o.source === 'free' ? sym : `${sym} ${sourceLabel(o.source)}`}</Text>
                      {/* A pasted token is known by its address, not its name: shown in full. */}
                      {pasted ? <Text style={styles.pickAddr}>{pasted.address}</Text> : null}
                    </View>
                    <Text style={styles.pickSub}>
                      {fmtNum(Number(formatUnits(remaining(o.asset.symbol, o.source), o.asset.decimals)))}
                    </Text>
                    {on ? (
                      <Svg width={18} height={18} viewBox="0 0 24 24">
                        <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      </Svg>
                    ) : null}
                  </Pressable>
                );
              })}
          <AddByAddress
            onAdd={async (address) => {
              const x = await custom.add(address);
              if (picker) choose(picker.k, x.address, 'free');
            }}
          />
        </ScrollView>
      </Sheet>

    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  scroll: {flex: 1},
  body: {flexGrow: 1, padding: 16, gap: 24, paddingBottom: 16},
  footer: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16},
  // The whole bar is the button: the mark, the chosen recipient, and a chevron.
  toField: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 12, paddingHorizontal: 16},
  pressed: {opacity: 0.6},
  // Two lines where a vault has a name, one where the address is all there is.
  toLine: {flex: 1, gap: 2, minWidth: 0},
  // The name yields first; the address is the part that must stay whole.
  toValue: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
  toAddr: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
  toAddrMuted: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums']},
  toPlaceholder: {color: c.subtext, fontSize: 15, flex: 1},
  chev: {color: c.subtext, fontSize: 20, fontWeight: '300'},
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
  // One row per token in the group, a hairline between, as a Settings group draws its rows.
  line: {gap: 4, paddingHorizontal: 16, paddingVertical: 8},
  lineDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
  field: {flexDirection: 'row', alignItems: 'center', height: 48, gap: 8},
  // minWidth 0 so a long balance beside it cannot push the input past the field's edge.
  fieldInput: {flex: 1, minWidth: 0, color: c.text, fontSize: 17, paddingVertical: 0},
  // Balance and badge are one target: tapping either fills the field, as on the web.
  maxBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 124},
  balInline: {color: c.subtext, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
  maxBadge: {color: c.accent, backgroundColor: c.accentSoft, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden'},
  assetPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10},
  assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
  assetSource: {color: c.subtext, fontSize: 11, fontWeight: '600'},
  over: {color: c.danger, fontSize: 12, paddingBottom: 4},
  inputOver: {color: c.danger},
  hint: {color: c.subtext, fontSize: 12},
  // The chooser's rows: FundRow's head metrics, so switching from the list to the sources does
  // not shift anything sideways or vertically.
  pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  pickCol: {flex: 1},
  pickLabel: {color: c.text, fontSize: 15, fontWeight: '600'},
  pickAddr: {color: c.subtext, fontSize: 11, fontVariant: ['tabular-nums'], marginTop: 2},
  addAddrRow: {gap: 8, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  addAddrTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
  addAddrBar: {flexDirection: 'row', alignItems: 'center', gap: 8},
  addAddrInput: {flex: 1, minWidth: 0, backgroundColor: c.input, color: c.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, fontVariant: ['tabular-nums']},
  addAddrBtn: {backgroundColor: c.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10},
  addAddrBtnOff: {opacity: 0.5},
  addAddrBtnText: {color: c.onAccent, fontSize: 14, fontWeight: '700'},
  pickSub: {color: c.subtext, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
  addRow: {minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
  addToken: {color: c.accent, fontSize: 15, fontWeight: '600'},
  ok: {color: c.success, fontSize: 12, fontFamily: 'Menlo'},
  err: {color: c.danger, fontSize: 13},
});

/**
 * The picker's last row: a token by contract address, for one the catalog does not list. What it
 * shows is read from the token on chain; a pasted token goes out only to a whitelisted recipient.
 */
function AddByAddress({onAdd}: {onAdd: (address: string) => Promise<void>}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = /^0x[0-9a-fA-F]{40}$/.test(text.trim());
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onAdd(text);
      setText('');
    } catch {
      setErr(t('mobile.payments.token_not_found'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.addAddrRow}>
      <Text style={styles.addAddrTitle}>{t('mobile.payments.token_by_address')}</Text>
      <View style={styles.addAddrBar}>
        <TextInput
          style={styles.addAddrInput}
          value={text}
          onChangeText={(v) => {
            setText(v);
            setErr(null);
          }}
          placeholder="0x…"
          placeholderTextColor={c.subtext}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
        <Pressable style={[styles.addAddrBtn, (!ok || busy) && styles.addAddrBtnOff]} disabled={!ok || busy} onPress={add}>
          <Text style={styles.addAddrBtnText}>{busy ? '…' : t('mobile.payments.token_add')}</Text>
        </Pressable>
      </View>
      {err ? <Text style={styles.err}>{err}</Text> : null}
    </View>
  );
}

import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {RouteProp} from '@react-navigation/native';
import {useNavigation, useRoute} from '@react-navigation/native';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {exceedsMax} from '@/components/AmountInput';
import {ClearBtn} from '@/components/ClearBtn';
import {PercentSlider} from '@/components/PercentSlider';
import {useEndCaret} from '@/components/useEndCaret';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {balanceOfSymbol} from '@/vault/read';
import {depositFromSources, depositToProtocol, withdrawFromProtocol} from '@/vault/actions';
import {parseUnits, type Address} from 'viem';
import {VAULT_DEFI_ABI} from '@/core/abi';
import {encodeVaultCalls, type VaultCall} from '@/vault/relay';
import {estimateRelayGas, relayGasFor} from '@/vault/fee-quote';
import {Sheet} from '@/components/Sheet';
import {FundRow} from '@/components/FundRow';
import {useVaultPositions} from '@/vault/useVaultPositions';

import Svg, {Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {PickerSheet, type PickerItem} from '@/components/AssetPicker';
import {adapterByName} from '@/core/protocols';
import {FEE_WETH, resolveFeeReserve, reserveHeld, useWethFeeCoin} from '@/vault/stableCoinAsGas';
import type {RootStackParamList} from '@/App';
import {FormSheet, FORM_SHEET_BODY} from '@/components/FormSheet';
import {AvailableLine} from '@/components/AvailableLine';
import {useColors, useStyles, type Colors} from '@/theme';
import {displaySymbol, fmtNum, fmtShort, floor6, round6} from '@/core/format';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';
import {activeVaultAddress} from '@/core/active-vault';

/**
 * Deposit / Withdraw. `route.params.mode` picks the action. When protocol+asset are passed (a
 * per-position withdraw from the Earn/Lend list) it targets THAT position; otherwise it's the default
 * Sky stable-coin flow with a coin picker. Signed in-app, gasless.
 */
export function EarnActionScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const {params} = useRoute<RouteProp<RootStackParamList, 'EarnAction'>>();
  const isDeposit = params.mode === 'deposit';
  const specific = !!(params.protocol && params.asset);

  const unlocked = useWallet((s) => s.unlocked);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);

  const catalog = useAssetCatalog(network);
  const stablecoins = catalog.filter((a) => a.kind === 'stable');
  const [coin, setCoin] = useState(stablecoins[0]?.symbol ?? 'USDC');
  /**
   * Where a deposit on a fixed route takes its money from: the vault's free balance ('free') and/or
   * other protocols holding the SAME asset, keyed by adapter address — a tick and an amount each,
   * as the market order's funding sheet has. Positions are withdrawn and the total deposited in one
   * multicall.
   *
   * The asset itself is not a choice. The form was opened from one market's detail page, so it
   * deposits that market's asset; offering the adapter's other assets here answered a question
   * the page had already settled.
   */
  const [fundOn, setFundOn] = useState<Record<string, boolean>>({free: true});
  const [fundAmt, setFundAmt] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState(false);
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const selected = stablecoins.find((s) => s.symbol === coin) ?? stablecoins[0];
  const protocol = specific
    ? (params.protocol as `0x${string}`)
    : adapterByName(network, 'Sky');
  // A fixed route deposits or withdraws exactly the asset it was opened for. See {source}.
  const targetAsset = specific ? (params.asset as `0x${string}`) : selected?.address;
  const targetDecimals = specific ? params.decimals ?? 18 : selected?.decimals ?? 18;
  const targetSymbol = specific ? params.symbol ?? 'token' : coin;
  const feeCoin = selected?.address ?? targetAsset; // relay fee always paid in a stable coin
  const bal = useVaultBalances(network);
  /**
   * The other positions in this asset a deposit can be moved out of: Sky savings and Aave supply,
   * which pay out in the same transaction. Lido is left out — its unstake is a queue, not a payout.
   */
  const pos = useVaultPositions(isDeposit && specific ? bal.vault : null, network);
  const movable = pos.positions.filter(
    (p) =>
      p.asset.toLowerCase() === params.asset?.toLowerCase() &&
      p.protocol.toLowerCase() !== params.protocol?.toLowerCase() &&
      (p.kind === 'supplied' || p.protocolName === 'Sky'),
  );
  const weth = useWethFeeCoin(network, bal.vault);
  /**
   * The float the relayer bills against, held back from a DEPOSIT as the order sheet holds it back
   * from a trade.
   *
   * Earn had the same hole trading had: the fee is charged to a vault stablecoin after the call
   * runs, so putting the last of that coin into Sky or Aave reverts at the charge — and here it
   * would revert having already been signed for a deposit that was perfectly valid. Worse than on
   * the trade screen, in fact, because the money ends up locked in a position the vault then
   * cannot pay to withdraw from.
   *
   * Only ever bites on the coin the float is held in: anything else deposits in full. A withdrawal
   * is untouched — it brings the coin BACK, so there is nothing to protect.
   */
  const reserve = resolveFeeReserve({
    network,
    vault: bal.vault,
    heldStables: [
      ...stablecoins.map((a) => ({
        symbol: a.symbol,
        amount: Number(balanceOfSymbol(bal.balances, a.symbol) || 0),
      })),
      ...(weth ? [{symbol: FEE_WETH, amount: Number(balanceOfSymbol(bal.balances, FEE_WETH) || 0), usd: weth.usd}] : []),
    ],
    spendSymbol: isDeposit ? targetSymbol : undefined,
  });
  const freeBal = isDeposit ? floor6(Number(balanceOfSymbol(bal.balances, targetSymbol) || 0)) : 0;
  /**
   * What there is to deposit of ONE coin: its balance, less the float if it is the coin holding it.
   *
   * Per coin rather than for the one selected, because the sheet compares them — a list where the
   * figure beside USDC is the whole balance and the Max under it is ten dollars short is a list
   * that disagrees with the form it feeds.
   */
  const depositableOf = (symbol: string): number => {
    const held = floor6(Number(balanceOfSymbol(bal.balances, symbol) || 0));
    const keep = reserve.coin?.toUpperCase() === symbol.toUpperCase() ? reserve.size : 0;
    return round6(Math.max(0, held - keep));
  };
  /** A fixed-route deposit draws on several sources; everything else is the plain one-source form. */
  const multi = isDeposit && specific;
  // Floored to at most six places, so a ticked row never names more than the position holds.
  const fundDp = Math.min(targetDecimals, 6);
  const floorDp = (n: number) => Math.floor(n * 10 ** fundDp) / 10 ** fundDp;
  const fundKeys = ['free', ...movable.map((p) => p.protocol as string)];
  const capOf = (key: string): number =>
    key === 'free' ? floorDp(depositableOf(targetSymbol)) : floorDp(Number(movable.find((p) => p.protocol === key)?.formatted ?? 0));
  const picked = (key: string) => (fundOn[key] ? Math.min(Number(fundAmt[key]) || 0, capOf(key)) : 0);
  /** The positions ticked into this deposit — what the multicall will withdraw from. */
  const tickedPositions = movable.filter((p) => fundOn[p.protocol]);
  /** Change one source and restate the amount, so the field and the rows always agree. */
  const applyFunding = (on: Record<string, boolean>, amt: Record<string, string>) => {
    setFundOn(on);
    setFundAmt(amt);
    const total = round6(fundKeys.reduce((n, k) => n + (on[k] ? Math.min(Number(amt[k]) || 0, capOf(k)) : 0), 0));
    setAmount(total > 0 ? String(total) : '');
  };
  /** Tick or untick: ticking brings in everything the source holds, unticking empties it. */
  const toggleFunding = (k: string) => {
    const on = {...fundOn, [k]: !fundOn[k]};
    applyFunding(on, {...fundAmt, [k]: on[k] ? String(capOf(k)) : ''});
  };
  /**
   * What the source sheet offers: on a fixed route the adapter's own assets, otherwise the dollars.
   *
   * Last comes the part of one of them that is NOT on offer — the relayer's float. It is listed
   * whatever asset is selected, because it is what explains the figure beside its own coin, and it
   * is `disabled`, so the sheet draws it dimmed and will not take it as an answer. See
   * {PickerItem}'s note on the same row in the order sheet.
   *
   * The float row is left out where its coin is not in the list at all: staking ether through Lido
   * takes nothing away from a dollar reserve, and a USDC row in that sheet would be answering a
   * question nobody asked.
   */
  const sourceAssets = specific ? catalog.filter((a) => a.address.toLowerCase() === params.asset?.toLowerCase()) : stablecoins;
  const reserveCoin =
    reserve.coin && reserve.size > 0
      ? sourceAssets.find((a) => a.symbol.toUpperCase() === reserve.coin!.toUpperCase())
      : undefined;
  const sourceOptions: PickerItem[] = isDeposit
    ? [
        ...sourceAssets.map((a) => ({
          key: specific ? 'free' : a.symbol,
          label: displaySymbol(a.symbol),
          sub: `${fmtNum(depositableOf(a.symbol))} ${displaySymbol(a.symbol)}`,
          icon: <TokenIcon symbol={a.symbol} size={30} />,
        })),
        ...(reserveCoin
          ? [
              {
                key: 'reserve',
                label: `${displaySymbol(reserveCoin.symbol)} ${t('mobile.trade.fee_reserved')}`,
                // Never more than the coin actually holds — see {reserveHeld}.
                sub: `${fmtNum(
                  reserveHeld(reserve.size, floor6(Number(balanceOfSymbol(bal.balances, reserveCoin.symbol) || 0))),
                )} ${displaySymbol(reserveCoin.symbol)}`,
                icon: <TokenIcon symbol={reserveCoin.symbol} size={30} />,
                disabled: true,
              },
            ]
          : []),
      ]
    : [];
  /** Is there a choice to offer? One asset and no float to name is not a list worth opening. */
  const canPickSource = isDeposit && sourceOptions.length + (multi ? movable.length : 0) > 1;
  /** Re-point the one-source form. The amount goes with it: the ceiling it was typed against has changed. */
  const pickSource = (key: string) => {
    setCoin(key);
    setAmount('');
  };
  // Deposit max = free balance of the coin; withdraw max = the position's amount (passed in params).
  //
  // Six places only when the reserve actually applies: that is the one case where the figure is
  // arithmetic rather than the balance itself, and rounding a token with eighteen decimals to six
  // for no reason would leave dust nobody can deposit.
  // With positions ticked, everything the ticked sources hold: the fee is billed from the free
  // balance, which a withdrawal-and-deposit leaves exactly as it found it.
  const max = isDeposit
    ? multi && tickedPositions.length > 0
      ? String(round6(fundKeys.reduce((n, k) => n + (fundOn[k] ? capOf(k) : 0), 0)))
      : multi && !fundOn.free
      ? '0'
      : reserve.keep > 0
      ? String(round6(Math.max(0, freeBal - reserve.keep)))
      : balanceOfSymbol(bal.balances, targetSymbol)
    : params.max;
  const canSubmit =
    unlocked && !!owner && !!protocol && !!targetAsset && !!feeCoin && Number(amount) > 0 && status !== 'busy' && !exceedsMax(amount, max);

  const nav = useNavigation();
  const amountCaret = useEndCaret(amount);
  const hasMax = max != null && max !== '' && Number(max) > 0;
  const over = exceedsMax(amount, max);
  /** Six places at most, as the order sheet's fields use: enough to be exact, short enough to read. */
  const trim = (n: number): string => (!isFinite(n) || n <= 0 ? '' : String(Number(n < 1 ? n.toPrecision(6) : n.toFixed(6))));
  const pct = hasMax && Number(amount) > 0 ? (Number(amount) / Number(max)) * 100 : 0;
  /**
   * How much each ticked position gives, in raw units.
   *
   * The rows say where the money comes from and the amount says how much; moving a row restates the
   * amount, but the field stays typable, so the two can disagree. Each ticked source gives what its
   * row was set to, in order — the free balance first — and then tops up towards its whole balance
   * if the amount is still short. The free balance's share is simply left in the vault to deposit.
   */
  const planWithdrawals = (): {protocol: `0x${string}`; raw: bigint}[] => {
    const raw = (n: number) => parseUnits(n.toFixed(fundDp), targetDecimals);
    const order = fundKeys.filter((k) => fundOn[k]);
    const caps = order.map((k) => raw(capOf(k)));
    let need = parseUnits(amount, targetDecimals);
    const takes = order.map((k, i) => {
      const t = raw(picked(k)) < need ? raw(picked(k)) : need;
      need -= t;
      return t < caps[i] ? t : caps[i];
    });
    for (let i = 0; i < order.length && need > 0n; i++) {
      const extra = caps[i] - takes[i] < need ? caps[i] - takes[i] : need;
      takes[i] += extra;
      need -= extra;
    }
    return order.flatMap((k, i) => (k !== 'free' && takes[i] > 0n ? [{protocol: k as `0x${string}`, raw: takes[i]}] : []));
  };

  /**
   * The gas the fee line under Confirm is priced from: this exact call simulated, so a first deposit
   * that also clones the adapter shows what it will cost, not what a repeat deposit costs. Until the
   * simulation lands (and where it cannot run) the deposit/withdraw model stands in.
   */
  const plan = (() => {
    try {
      return multi && Number(amount) > 0 ? planWithdrawals() : [];
    } catch {
      return [];
    }
  })();
  const planKey = plan.map((w) => `${w.protocol}:${w.raw}`).join(',');
  const modelGas = relayGasFor({supply: isDeposit ? 1 : 0, withdraw: plan.length + (isDeposit ? 0 : 1)});
  const [feeGas, setFeeGas] = useState<bigint>(modelGas);
  useEffect(() => {
    setFeeGas(modelGas);
    const vault = activeVaultAddress(network);
    if (!vault || !owner || !protocol || !targetAsset || !(Number(amount) > 0)) return;
    let raw: bigint;
    try {
      raw = parseUnits(amount, targetDecimals);
    } catch {
      return;
    }
    const calls: VaultCall[] = [
      ...plan.map((w) => ({abi: VAULT_DEFI_ABI, functionName: 'withdraw', args: [w.protocol, targetAsset, w.raw]})),
      {abi: VAULT_DEFI_ABI, functionName: isDeposit ? 'deposit' : 'withdraw', args: [protocol, targetAsset, raw]},
    ];
    let live = true;
    const id = setTimeout(() => {
      estimateRelayGas(network, owner as Address, vault, encodeVaultCalls(calls), modelGas).then((g) => live && setFeeGas(g));
    }, 400);
    return () => {
      live = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, owner, protocol, targetAsset, targetDecimals, amount, planKey, isDeposit]);

  const onSubmit = async () => {
    if (!unlocked || !owner || !protocol || !targetAsset || !feeCoin) return;
    setStatus('busy');
    setErr(null);
    /**
     * Sign first, then go, then do the work.
     *
     * The dismissal cannot come before the signature. This screen is `presentation: 'modal'` and
     * `getSigner` raises the Face ID prompt, so dismissing first asks iOS to tear down one modal
     * while presenting another — which it drops, leaving the form sitting there with the badge
     * already running. (The same collision is why {WatchlistMenu} waits `DISMISS_MS` before it
     * shares or deletes.)
     *
     * It also reads better: the form stays up while the user authorises, which is what they are
     * authorising, and a cancelled prompt leaves them on the page they can retry from rather than
     * back on the list wondering what happened. Once signed there is nothing left to see here —
     * the badge and a toast carry the rest.
     */
    let tx: ReturnType<typeof showTx> | null = null;
    try {
      const acct = await getSigner();
      // Formatted, not the raw field: see the Trade screen's `payLeg`.
      // "Deposit 100 USDC": what moved and how much, not the form's own title.
      tx = showTx(
        t(isDeposit ? 'mobile.actions.deposit_amount' : 'mobile.actions.withdraw_amount', {
          amount: `${fmtShort(Number(amount))} ${displaySymbol(targetSymbol)}`,
        }),
        network,
      );
      nav.goBack();
      const vault = activeVaultAddress(network)!;
      const withdrawals = multi ? planWithdrawals() : [];
      const h = withdrawals.length
        ? await depositFromSources({
            account: acct,
            vault,
            network,
            protocol,
            asset: targetAsset,
            raw: parseUnits(amount, targetDecimals),
            withdrawals,
            stableCoin: feeCoin,
          })
        : await (isDeposit ? depositToProtocol : withdrawFromProtocol)({
        account: acct,
        vault,
        network,
        protocol,
        asset: targetAsset,
        amount,
        decimals: targetDecimals,
        stableCoin: feeCoin,
      });
      tx.success(h);
      setStatus('done');
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // No `tx` yet means the signature itself failed or was declined: nothing was announced, so
      // there is nothing to take down, and the message belongs on the form the user is still on.
      tx?.error(msg);
      setErr(msg);
      setStatus('error');
    }
  };

  const title = t(isDeposit ? 'mobile.home.deposit_to' : 'mobile.home.withdraw_from', {name: specific ? targetSymbol : 'Sky'});


  return (
    <FormSheet visible onClose={() => nav.goBack()} ownModal={false}>
      {/* Its own scroll: a field, a slider and a button overflow the card on a small screen with a
          keyboard up, where the order sheet's fields do not. */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={FORM_SHEET_BODY}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        {/* What can be moved, above the field that moves it — the same line the order sheet now
            carries. On a deposit it is the vault's balance; on a withdrawal it is what the position
            holds, which the route hands over. */}
        <AvailableLine amount={Number(max ?? 0)} symbol={targetSymbol} onPress={() => setAmount(max!)} />
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('vault.amount')}</Text>
          <View style={styles.fieldRight}>
            <TextInput
              style={[styles.fieldInput, over && styles.fieldInputOver]}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={c.subtext}
              value={amount}
              onChangeText={setAmount}
              {...amountCaret}
            />
            {/* One control, as on the trade and Send rows: Max over an empty field, Clear over a
                filled one. Offering Max beside a number already typed asks the user to work out
                whether it would replace what is there. */}
            {Number(amount) > 0 ? (
              <ClearBtn onPress={() => setAmount('')} />
            ) : hasMax ? (
              <Pressable onPress={() => setAmount(max!)} style={styles.maxPill}>
                <Text style={styles.maxText}>{t('common.max')}</Text>
              </Pressable>
            ) : null}
            {/**
              * The token pill IS the source button, as it is on the order sheet's pay row.
              *
              * It was a field of its own above this one, which made a form with a single number in
              * it look like a form with two: a row reading "Asset   USDC ›" over a row reading
              * "Amount  0 USDC", the asset named twice and only one of them typed into. The trade
              * sheet settled this long ago — the pill at the end of the amount row says what is
              * being moved AND opens the list of where it can come from, so the row is one
              * statement: this much, of that.
              *
              * Inert where there is nothing to choose: a Lido route takes ether and nothing else,
              * and a withdrawal is pinned to the position it is taking apart.
              */}
            {canPickSource ? (
              <Pressable style={styles.symPill} onPress={() => setPicker(true)} hitSlop={6}>
                <TokenIcon symbol={targetSymbol} size={20} />
                <Text style={styles.fieldSym}>{displaySymbol(targetSymbol)}</Text>
                {/* Where it comes from, when not the free balance — as the order sheet's pay pill says. */}
                {tickedPositions.length ? (
                  <Text style={styles.sourceTag}>
                    {[...new Set(tickedPositions.map((p) => t(p.kind === 'supplied' ? 'vault.lending' : 'vault.yielding')))].join(' · ')}
                  </Text>
                ) : null}
                <Svg width={14} height={14} viewBox="0 0 24 24">
                  <Path
                    d="m9 18 6-6-6-6"
                    stroke={c.subtext}
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </Svg>
              </Pressable>
            ) : (
              <View style={styles.symPill}>
                <TokenIcon symbol={targetSymbol} size={20} />
                <Text style={styles.fieldSym}>{displaySymbol(targetSymbol)}</Text>
              </View>
            )}
          </View>
        </View>

        {/* The error stays with the field that caused it, where the order sheet puts its own. */}
        {over ? (
          <Text style={styles.overText}>
            {t('vault.exceeds_balance')} · {fmtNum(Number(max))} {displaySymbol(targetSymbol)}
          </Text>
        ) : null}

        {/* Under the amount, driving it — the same place and the same control as the order sheet's,
            so a percentage of a balance is set the same way wherever one is. */}
        <PercentSlider
          value={pct}
          onChange={(v) => setAmount(v >= 100 ? (max ?? '') : trim((Number(max ?? 0) * v) / 100))}
          disabled={!hasMax}
        />

        {status === 'error' && err ? <Text style={styles.err}>{err}</Text> : null}

        {/* Directly under the field, the way the order sheet puts its confirm under the amount.
            Pinned to the bottom it floated a long way from the thing it confirms, and in a short
            sheet it collided with it. */}
        <ConfirmButton onPress={onSubmit} disabled={!canSubmit} gas={feeGas} style={styles.submit} />
      </ScrollView>
      {/* Inside the form sheet, like the order form's own pickers: presented from outside it, a
          sheet opens behind the one being looked at. */}
      {/* A fixed-route deposit: the market order's funding rows — a tick, quick fractions and an
          amount per source — over the same inert fee-float row. Edits apply as they are made. */}
      <Sheet visible={picker && multi} title={t('vault.asset')} onClose={() => setPicker(false)} done>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {fundKeys.map((k) => {
            const p = movable.find((x) => x.protocol === k);
            return (
              <FundRow
                key={k}
                label={p ? `${displaySymbol(targetSymbol)} ${t(p.kind === 'supplied' ? 'vault.lending' : 'vault.yielding')}` : displaySymbol(targetSymbol)}
                sub={p ? `${fmtNum(capOf(k))} ${displaySymbol(targetSymbol)} · ${p.protocolName}` : `${t('vault.balance')} · ${fmtNum(capOf(k))}`}
                symbol={targetSymbol}
                cap={capOf(k)}
                on={!!fundOn[k]}
                amount={fundAmt[k] ?? ''}
                onToggle={() => toggleFunding(k)}
                onAmount={(v) => applyFunding({...fundOn, [k]: true}, {...fundAmt, [k]: v})}
                onCommit={() => {
                  if (!(Number(fundAmt[k]) > 0) && k !== 'free') applyFunding({...fundOn, [k]: false}, {...fundAmt, [k]: ''});
                }}
              />
            );
          })}
          {reserveCoin ? (
            <FundRow
              inert
              label={`${displaySymbol(reserveCoin.symbol)} ${t('mobile.trade.fee_reserved')}`}
              sub={`${fmtNum(reserveHeld(reserve.size, floor6(Number(balanceOfSymbol(bal.balances, reserveCoin.symbol) || 0))))} ${displaySymbol(reserveCoin.symbol)}`}
              symbol={reserveCoin.symbol}
              cap={0}
              on={false}
              amount=""
              onToggle={() => {}}
              onAmount={() => {}}
              onCommit={() => {}}
            />
          ) : null}
        </ScrollView>
      </Sheet>
      <PickerSheet
        visible={picker && !multi}
        title={t('vault.asset')}
        items={sourceOptions}
        selected={targetSymbol}
        onSelect={pickSource}
        onClose={() => setPicker(false)}
      />
    </FormSheet>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  submit: {marginTop: 6},
  // The order sheet's row, verbatim: label left, figure right, controls after it. See {payField}.
  field: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.input, borderRadius: 12, paddingHorizontal: 14, height: 52},
  fieldLabel: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  fieldRight: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end', marginLeft: 12},
  fieldInput: {flex: 1, textAlign: 'right', color: c.text, fontSize: 17, fontVariant: ['tabular-nums'], padding: 0},
  fieldInputOver: {color: c.danger},
  fieldSym: {color: c.text, fontSize: 14, fontWeight: '700'},
  maxPill: {backgroundColor: c.accentSoft, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3},
  maxText: {color: c.accent, fontSize: 11, fontWeight: '700'},
  // The order sheet's version of this, and now the same thing: a button that opens the source
  // picker. Drawn identically whether or not it is pressable, so a form with one possible source
  // does not look like a different form.
  symPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 16, paddingVertical: 5, paddingHorizontal: 8},
  overText: {color: c.danger, fontSize: 12},
  sourceTag: {color: c.subtext, fontSize: 11, fontWeight: '600'},
  input: {
    height: 44,
    borderRadius: 10,
    backgroundColor: c.input,
    color: c.text,
    paddingHorizontal: 12,
    fontSize: 17,
  },
  hint: {color: c.subtext, fontSize: 13, lineHeight: 18},
  ok: {color: c.success, fontSize: 13, fontFamily: 'Menlo'},
  err: {color: c.danger, fontSize: 13},
});

import React, {useMemo, useState} from 'react';
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
import {ownerVaultAddress, balanceOfSymbol} from '@/vault/read';
import {depositToProtocol, withdrawFromProtocol} from '@/vault/actions';

import Svg, {Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {PickerSheet, type PickerItem} from '@/components/AssetPicker';
import {adapterByName} from '@/core/protocols';
import {resolveFeeReserve, reserveHeld} from '@/vault/gasless';
import type {RootStackParamList} from '@/App';
import {FormSheet, FORM_SHEET_BODY} from '@/components/FormSheet';
import {AvailableLine} from '@/components/AvailableLine';
import {useColors, useStyles, type Colors} from '@/theme';
import {displaySymbol, fmtNum, fmtShort, floor6, round6} from '@/core/format';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';
import {routesForProtocol} from '@/vault/earn-routes';

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
  /**
   * Everything the adapter this form was opened for will take.
   *
   * A deposit arrives here naming ONE route — Aave's USDC, say — but the adapter behind it accepts
   * five, and the form had no way to say so: the asset was a navigation param and the source row
   * was shown only on the coin-picker flow. So the one screen with a balance in front of it could
   * not change which asset that balance was. Same adapter throughout; only the asset moves, which
   * is what the Earn list's own rows are.
   */
  const routes = useMemo(
    () => (specific && params.protocol ? routesForProtocol(network, catalog, params.protocol) : []),
    [specific, params.protocol, network, catalog],
  );
  const [coin, setCoin] = useState(stablecoins[0]?.symbol ?? 'USDC');
  /** The route's asset, by symbol, which the source sheet can change. */
  const [routeSym, setRouteSym] = useState(params.symbol ?? '');
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState(false);
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const selected = stablecoins.find((s) => s.symbol === coin) ?? stablecoins[0];
  const protocol = specific
    ? (params.protocol as `0x${string}`)
    : adapterByName(network, 'Sky');
  /**
   * The route in hand: the one picked, else the one navigated to.
   *
   * A WITHDRAWAL is never re-pointed — it takes a position apart, and the position is for one
   * asset — so it stays on the params whatever is in `routeSym`.
   */
  const route = isDeposit ? routes.find((r) => r.asset.symbol === routeSym) : undefined;
  const targetAsset = specific ? ((route?.asset.address ?? params.asset) as `0x${string}`) : selected?.address;
  const targetDecimals = specific ? route?.asset.decimals ?? params.decimals ?? 18 : selected?.decimals ?? 18;
  const targetSymbol = specific ? route?.asset.symbol ?? params.symbol ?? 'token' : coin;
  const feeCoin = selected?.address ?? targetAsset; // relay fee always paid in a stable coin
  const bal = useVaultBalances(network);
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
    heldStables: stablecoins.map((a) => ({
      symbol: a.symbol,
      amount: Number(balanceOfSymbol(bal.balances, a.symbol) || 0),
    })),
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
  const sourceAssets = specific ? routes.map((r) => r.asset) : stablecoins;
  const reserveCoin =
    reserve.coin && reserve.size > 0
      ? sourceAssets.find((a) => a.symbol.toUpperCase() === reserve.coin!.toUpperCase())
      : undefined;
  const sourceOptions: PickerItem[] = isDeposit
    ? [
        ...sourceAssets.map((a) => ({
          key: a.symbol,
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
  const canPickSource = isDeposit && sourceOptions.length > 1;
  /** Re-point the form. The amount goes with it: the ceiling it was typed against has changed. */
  const pickSource = (key: string) => {
    if (specific) setRouteSym(key);
    else setCoin(key);
    setAmount('');
  };
  // Deposit max = free balance of the coin; withdraw max = the position's amount (passed in params).
  //
  // Six places only when the reserve actually applies: that is the one case where the figure is
  // arithmetic rather than the balance itself, and rounding a token with eighteen decimals to six
  // for no reason would leave dust nobody can deposit.
  const max = isDeposit
    ? reserve.keep > 0
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
      tx = showTx(`${title} · ${fmtShort(Number(amount))} ${displaySymbol(targetSymbol)}`, network);
      nav.goBack();
      const vault = ownerVaultAddress(owner, network);
      const run = isDeposit ? depositToProtocol : withdrawFromProtocol;
      const h = await run({
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
        <ConfirmButton onPress={onSubmit} disabled={!canSubmit} style={styles.submit} />
      </ScrollView>
      {/* Inside the form sheet, like the order form's own pickers: presented from outside it, a
          sheet opens behind the one being looked at. */}
      <PickerSheet
        visible={picker}
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

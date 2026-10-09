import React, {useState} from 'react';
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

import {TokenIcon} from '@/components/TokenIcon';
import {adapterByName} from '@/core/protocols';
import type {RootStackParamList} from '@/App';
import {FormSheet, FORM_SHEET_BODY} from '@/components/FormSheet';
import {AvailableLine} from '@/components/AvailableLine';
import {useColors, useStyles, type Colors} from '@/theme';
import {displaySymbol, fmtNum, fmtShort} from '@/core/format';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';

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

  const stablecoins = useAssetCatalog(network).filter((a) => a.kind === 'stable');
  const [coin, setCoin] = useState(stablecoins[0]?.symbol ?? 'USDC');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const selected = stablecoins.find((s) => s.symbol === coin) ?? stablecoins[0];
  const protocol = specific
    ? (params.protocol as `0x${string}`)
    : adapterByName(network, 'Sky');
  const targetAsset = specific ? (params.asset as `0x${string}`) : selected?.address;
  const targetDecimals = specific ? params.decimals ?? 18 : selected?.decimals ?? 18;
  const targetSymbol = specific ? params.symbol ?? 'token' : coin;
  const feeCoin = selected?.address ?? targetAsset; // relay fee always paid in a stable coin
  const bal = useVaultBalances(network);
  // Deposit max = free balance of the coin; withdraw max = the position's amount (passed in params).
  const max = isDeposit ? balanceOfSymbol(bal.balances, targetSymbol) : params.max;
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
      {/* Its own scroll: the coin chips, a field, a slider and a button overflow the card on a
          small screen with a keyboard up, where the order sheet's fields do not. */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={FORM_SHEET_BODY}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        {!specific ? (
          <View style={styles.coins}>
            {stablecoins.map((sc) => {
              const on = sc.symbol === coin;
              return (
                <Pressable
                  key={sc.symbol}
                  onPress={() => setCoin(sc.symbol)}
                  style={[styles.coin, on && styles.coinOn]}>
                  <TokenIcon symbol={sc.symbol} size={18} />
                  <Text style={[styles.coinText, on && styles.coinTextOn]}>{displaySymbol(sc.symbol)}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

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
            <View style={styles.symPill}>
              <TokenIcon symbol={targetSymbol} size={20} />
              <Text style={styles.fieldSym}>{displaySymbol(targetSymbol)}</Text>
            </View>
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
  // The order sheet's version of this is a BUTTON (it opens the funding-source picker); here the
  // asset is fixed by the route, so it is the same shape without the press.
  symPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 16, paddingVertical: 5, paddingHorizontal: 8},
  overText: {color: c.danger, fontSize: 12},
  coins: {flexDirection: 'row', gap: 10},
  coin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  coinOn: {borderColor: c.accent, backgroundColor: c.accentSoft},
  coinText: {color: c.subtext, fontSize: 15, fontWeight: '600'},
  coinTextOn: {color: c.text},
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

import React, {useCallback, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import {formatUnits, parseUnits, zeroAddress, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {NATIVE, publicClientFor} from '@/core/chain';
import {ASSETS, knownAssets} from '@/core/assets';
import {useNetwork} from '@/core/network-store';
import {useActiveAccount} from '@/core/account-mode';
import {fmtNum} from '@/core/format';
import {accountEnergy, accountStake, type TronEnergy, type TronStake} from '@/tron/client';
import {evmToTron} from '@/tron/address';
import type {TronChain} from '@/tron/config';
import {TRON_STAKE, tronStakeAdapter} from '@/vault/tron-stake';
import {useWallet} from '@/wallet/store';
import {AccountRelayError, feeCall, quoteAccount, relayAccount, type AccountCall, type AccountQuote} from '@/account/relay';
import {stakeCalls, unstakeCalls, withdrawCalls} from '@/account/stake';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {AccountActivateBanner} from '@/components/AccountActivateBanner';
import {useAccountQuote} from '@/account/useAccountWrite';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {EarnRow, EarnTable} from './EarnScreen';

/**
 * Tron's Earn tab, named Energy: on Tron, staking TRX earns energy, not yield, so the tab is that.
 *
 * The same cards and row as Earn (EarnTable, EarnRow): TRX, with today's energy per TRX a day where
 * an APY would be, what is free to stake under it, what is staked at the right, and what is
 * unstaking or ready to withdraw under that. Then the energy itself: what the key gets a day, has
 * used, and has left. Then Stake / Unstake / Withdraw.
 *
 * Who stakes is the account in front. The smart wallet (BittyAccount) stakes its own TRX and lends
 * the energy to the owner key (account/stake), each step a relayed batch with its fee in USDT. The
 * wallet stakes for itself through Earn's own TRON Stake pages (wallet/earn).
 */
const ZERO = BigInt(0);

export function TronEnergyScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const tabBarHeight = useBottomTabBarHeight();
  const headerHeight = useTransparentHeaderInset();
  const network = useNetwork((s) => s.network);
  const active = useActiveAccount(network);
  const smart = active.kind === 'account';
  const owner = active.wallet;
  // Whose TRX is staked: the smart wallet's, or the wallet's own.
  const holder = smart ? active.account : owner;
  const native = NATIVE[network];
  const wtrx = ASSETS[network].find((a) => a.symbol === native.wrapped);
  const usdt = knownAssets(network).find((a) => a.symbol === 'USDT');
  const adapter = tronStakeAdapter(network);

  const [trx, setTrx] = useState<bigint | null>(null);
  const [stake, setStake] = useState<TronStake | null>(null);
  const [energy, setEnergy] = useState<TronEnergy | null>(null);
  // A pull's own spinner: on from the pull until every read is back, as Guard's (onPull).
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<'stake' | 'unstake' | null>(null);
  const [amount, setAmount] = useState('');
  const [confirm, setConfirm] = useState<{title: string; calls: AccountCall[]} | null>(null);
  const [quote, setQuote] = useState<AccountQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!holder || !owner) return;
    const net = network as TronChain;
    // Each on its own: one read failing (TronGrid's rate limit) must not leave the others unknown,
    // which once left Stake doing nothing at all.
    const [b, s, e] = await Promise.allSettled([
      publicClientFor(network).getBalance({address: holder}),
      accountStake(net, evmToTron(holder)),
      // The energy is spent by the key, so it is the key's that is shown.
      accountEnergy(net, evmToTron(owner)),
    ]);
    if (b.status === 'fulfilled') setTrx(b.value);
    if (s.status === 'fulfilled') setStake(s.value);
    if (e.status === 'fulfilled') setEnergy(e.value);
  }, [network, holder, owner]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // The amount sheet's batch, priced as it is typed: the fee on its Confirm, sent without a second
  // sheet (account/useAccountWrite useAccountQuote).
  const typedSun = (() => {
    try {
      return amount ? parseUnits(amount.replace(',', '.'), native.decimals) : null;
    } catch {
      return null;
    }
  })();
  const typedLimit = sheet === 'stake' ? trx : stake ? stake.energySun + stake.delegatedSun : null;
  const typedOk = !!typedSun && typedSun > BigInt(0) && (typedLimit === null || typedSun <= typedLimit) && smart && !!active.account && !!owner;
  const typedCalls =
    typedOk && sheet === 'stake'
      ? stakeCalls(active.account!, owner!, typedSun!)
      : typedOk && sheet === 'unstake' && stake
        ? unstakeCalls(active.account!, owner!, typedSun!, stake.delegatedSun)
        : null;
  const priced = useAccountQuote(typedCalls);

  if (!holder || !owner || !wtrx) return null;
  const units = (sun: bigint) => formatUnits(sun, native.decimals);
  const show = (sun: bigint) => `${fmtNum(Number(units(sun)))} ${native.symbol}`;
  const staked = stake ? stake.energySun + stake.delegatedSun : null;
  const now = Date.now();
  const claimable = (stake?.unfreezing ?? []).filter((u) => u.unlockMs <= now).reduce((n, u) => n + u.amountSun, BigInt(0));
  const unstaking = (stake?.unfreezing ?? []).filter((u) => u.unlockMs > now).reduce((n, u) => n + u.amountSun, BigInt(0));
  const nextBack = (stake?.unfreezing ?? []).filter((u) => u.unlockMs > now).sort((a, b) => a.unlockMs - b.unlockMs)[0];
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  const left = energy ? Math.max(0, energy.limit - energy.used) : null;

  // The wallet's own staking goes through Earn's TRON Stake pages, as it always has.
  const walletRoute = adapter ? {protocol: adapter, asset: wtrx.address, symbol: wtrx.symbol, decimals: wtrx.decimals} : null;
  const openWallet = (mode: 'deposit' | 'withdraw' | 'detail') => {
    if (!walletRoute) return;
    if (mode === 'detail') nav.navigate('EarnDetail', {protocol: walletRoute.protocol, asset: walletRoute.asset, symbol: walletRoute.symbol, name: TRON_STAKE, lend: false});
    else nav.navigate('EarnAction', {mode, ...walletRoute});
  };

  // ── the smart wallet: each step a relayed batch, its fee in USDT ─────────
  // Said as what stops it: not activated yet, the lock, Tron refusing; otherwise the relayer's code.
  const feeError = (k: string) => {
    const known: Record<string, string> = {
      'not-activated': 'mobile.tron.acct_not_activated',
      AccountLocked: 'mobile.vault.lock_send_book_only',
      StakeOpFailed: 'mobile.tron.energy_stake_failed',
      OverRelayerCap: 'mobile.tron.acct_over_relayer_cap',
      'relayer-unfunded': 'mobile.tron.acct_relayer_busy',
      'relayer-not-configured': 'mobile.tron.acct_relayer_busy',
    };
    return known[k] ? t(known[k]) : k ? `${t('mobile.account.fee_failed')} (${k})` : t('mobile.account.fee_failed');
  };
  // The amount sheet turns into the confirm, as one sheet: on iOS a second sheet opened while the
  // first is still closing never shows, which left Continue looking dead.
  const ask = async (title: string, calls: AccountCall[]) => {
    setConfirm({title, calls});
    setQuote(null);
    setQuoteError(null);
    try {
      setQuote(await quoteAccount({network, owner: owner as Address, calls}));
    } catch (e) {
      setQuoteError(feeError(e instanceof AccountRelayError ? (e.code ?? e.reason ?? '') : ''));
    }
  };
  const send = async () => {
    if (!confirm || !quote) return;
    await sendQuoted(confirm.title, confirm.calls, quote);
  };
  const sendQuoted = async (title: string, calls: AccountCall[], q: AccountQuote) => {
    setSending(true);
    const tx = showTx(title, network);
    try {
      const signer = await useWallet.getState().walletSigner();
      const {hash} = await relayAccount({network, signer, quote: q, calls: [...calls, feeCall(q)]});
      tx.success(hash);
      setConfirm(null);
      setSheet(null);
      setTimeout(() => void load(), 4000);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/cancel/i.test(msg)) tx.done();
      else tx.error(msg);
    } finally {
      setSending(false);
    }
  };
  const sun = (() => {
    try {
      return amount ? parseUnits(amount.replace(',', '.'), native.decimals) : null;
    } catch {
      return null;
    }
  })();
  const limit = sheet === 'stake' ? trx : staked;
  const over = sun !== null && limit !== null && sun > limit;
  // Confirm on the amount sheet: what is priced there, sent at once (Face ID by the signer).
  const go = () => {
    if (!sun || over || !typedCalls || !priced.quote) return void 0;
    const title = t(sheet === 'stake' ? 'mobile.tron.energy_stake_n' : 'mobile.tron.energy_unstake_n', {amount: show(sun)});
    void sendQuoted(title, typedCalls, priced.quote);
  };

  const onStake = () => (smart ? (setAmount(''), setSheet('stake')) : openWallet('deposit'));
  const onUnstake = () => (smart ? (setAmount(''), setSheet('unstake')) : openWallet('withdraw'));
  const onWithdraw = () => (smart && active.account ? void ask(t('mobile.tron.energy_withdraw'), withdrawCalls(active.account)) : openWallet('detail'));

  // Earn's row, fed this account's TRX: the staked amount where a position's is.
  const row = {
    route: {protocol: (adapter ?? zeroAddress) as Address, name: TRON_STAKE, asset: wtrx, kind: 'staking' as const},
    pos:
      staked !== null
        ? {protocol: (adapter ?? zeroAddress) as Address, protocolName: TRON_STAKE, category: 'staking' as never, asset: wtrx.address as Address, symbol: wtrx.symbol, decimals: wtrx.decimals, kind: 'staked' as const, raw: staked, formatted: units(staked)}
        : null,
  };

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        contentContainerStyle={[styles.content, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
        contentInset={{top: headerHeight}}
        contentOffset={{x: 0, y: -headerHeight}}
        scrollIndicatorInsets={{top: headerHeight}}
        automaticallyAdjustContentInsets={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
            tintColor={c.text}
            colors={[c.accent]}
          />
        }>
        {/* The smart wallet stakes nothing until it is activated, and only TRX it holds itself. */}
        {smart && active.account ? <AccountActivateBanner network={network} account={active.account} onActivated={() => void load()} /> : null}
        <EarnTable title={t('mobile.tron.energy_stake_title')}>
          <EarnRow
            first
            last
            row={row}
            free={trx !== null ? units(trx) : null}
            amountKnown={staked !== null}
            earned={null}
            dust={false}
            queue={stake ? {unstaking: units(unstaking), claimable: units(claimable)} : null}
            apy={null}
            energyRate={energy?.perTrxPerDay ?? null}
            onOpen={smart ? onStake : () => openWallet('detail')}
          />
        </EarnTable>

        <EarnTable title={t('mobile.tron.energy_key_title')}>
          <Stat first label={t('mobile.tron.energy_a_day')} value={energy ? fmtNum(energy.limit) : '—'} />
          <Stat label={t('mobile.tron.energy_used')} value={energy ? fmtNum(energy.used) : '—'} />
          <Stat label={t('mobile.tron.energy_left')} value={left !== null ? fmtNum(left) : '—'} strong last={!smart && !nextBack} />
          {smart ? <Stat label={t('mobile.tron.energy_to_key')} value={stake ? show(stake.delegatedSun) : '—'} last={!nextBack} /> : null}
          {nextBack ? <Stat label={t('mobile.tron.energy_unstaking')} value={t('mobile.tron.energy_back_at', {time: when(nextBack.unlockMs)})} last /> : null}
        </EarnTable>

        <Text style={styles.help}>{t(smart ? 'mobile.tron.energy_help' : 'mobile.tron.energy_help_wallet')}</Text>

        {/* Earn's pair (EarnDetailScreen): the way out on the left in the grey of a secondary
            button, the way in on the right in the accent. Disabled changes the label only. */}
        <View style={styles.actions}>
          <Pressable style={[styles.action, styles.secondary]} disabled={!staked} onPress={onUnstake} accessibilityRole="button">
            <Text style={[styles.secondaryText, !staked && styles.secondaryTextOff]} numberOfLines={1}>
              {t('mobile.tron.energy_unstake')}
            </Text>
          </Pressable>
          <Pressable style={[styles.action, styles.primary]} onPress={onStake} accessibilityRole="button">
            <Text style={styles.primaryText} numberOfLines={1}>{t('mobile.tron.energy_stake')}</Text>
          </Pressable>
        </View>
        {claimable > BigInt(0) ? (
          <Pressable style={[styles.action, styles.withdraw]} onPress={onWithdraw} accessibilityRole="button">
            <Text style={styles.withdrawText}>
              {t('mobile.tron.energy_withdraw')} · {show(claimable)}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <Sheet
        visible={sheet !== null || !!confirm}
        title={confirm ? confirm.title : t(sheet === 'stake' ? 'mobile.tron.energy_stake' : 'mobile.tron.energy_unstake')}
        onClose={() => {
          setSheet(null);
          setConfirm(null);
        }}>
        {confirm ? (
          <View style={styles.sheetBody}>
            {quoteError ? <Text style={styles.sheetHelp}>{quoteError}</Text> : null}
            <ConfirmButton
              onPress={() => void send()}
              loading={sending}
              disabled={!quote || sending}
              fee={false}
              networkFeeUsd={quote && usdt ? Number(formatUnits(quote.fee, usdt.decimals)) : undefined}
              pricing={!quote && !quoteError}
            />
          </View>
        ) : (
          <View style={styles.sheetBody}>
            <View style={styles.inputCard}>
              <TextInput style={styles.amount} value={amount} onChangeText={setAmount} placeholder="0" placeholderTextColor={c.subtext} keyboardType="decimal-pad" autoFocus />
              <Pressable onPress={() => limit !== null && setAmount(units(limit))} hitSlop={8} style={styles.max} accessibilityRole="button">
                <Text style={styles.maxText}>{t('mobile.account.max')}</Text>
              </Pressable>
            </View>
            {over ? <Text style={styles.error}>{t('mobile.account.not_enough', {symbol: native.symbol})}</Text> : null}
            <Text style={styles.sheetHelp}>{t(sheet === 'stake' ? 'mobile.tron.energy_stake_help' : 'mobile.tron.energy_unstake_help')}</Text>
            {priced.error ? <Text style={styles.error}>{feeError(priced.error)}</Text> : null}
            <ConfirmButton
              onPress={go}
              loading={sending}
              disabled={!sun || over || !priced.quote || sending}
              fee={!!priced.quote}
              networkFeeUsd={priced.quote && usdt ? Number(formatUnits(priced.quote.fee, usdt.decimals)) : undefined}
              pricing={priced.pricing}
            />
          </View>
        )}
      </Sheet>
    </View>
  );
}

/** One line of the energy card: Earn's hairline rows, a label and its figure. */
function Stat({label, value, first, last, strong}: {label: string; value: string; first?: boolean; last?: boolean; strong?: boolean}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.stat, first && styles.statFirst, last && styles.statLast]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, strong && styles.statStrong]}>{value}</Text>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    content: {flexGrow: 1, padding: 16, gap: 20},
    stat: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingVertical: 12},
    statFirst: {borderTopWidth: 0},
    statLast: {paddingBottom: 0},
    statLabel: {color: c.text, fontSize: 15},
    statValue: {color: c.subtext, fontSize: 15, fontVariant: ['tabular-nums']},
    statStrong: {color: c.success, fontWeight: '600'},
    help: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4, marginTop: -8},
    actions: {flexDirection: 'row', gap: 12, marginTop: 8},
    action: {flex: 1, minHeight: 50, paddingVertical: 8, borderRadius: 25, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12},
    primary: {backgroundColor: c.accent},
    primaryText: {color: c.onAccent, fontSize: 17, fontWeight: '700'},
    secondary: {backgroundColor: c.buttonSecondary},
    secondaryText: {color: c.textMuted, fontSize: 17, fontWeight: '700'},
    secondaryTextOff: {color: c.subtext},
    withdraw: {flex: 0, backgroundColor: c.successSoft},
    withdrawText: {color: c.success, fontSize: 16, fontWeight: '700'},
    off: {opacity: 0.5},
    sheetBody: {gap: 12, paddingTop: 8, paddingBottom: 8},
    inputCard: {backgroundColor: c.input, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 10},
    amount: {flex: 1, color: c.text, fontSize: 22, fontWeight: '700', padding: 0},
    max: {backgroundColor: c.accentSoft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6},
    maxText: {color: c.accent, fontSize: 13, fontWeight: '700'},
    sheetHelp: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    error: {color: c.danger, fontSize: 13, paddingHorizontal: 4},
    sheetButton: {minHeight: 48, borderRadius: 24, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center'},
  });

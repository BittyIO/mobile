import React, {useCallback, useEffect, useLayoutEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Svg, {Path} from 'react-native-svg';
import {explorerAddressUrl} from '@/core/chain';
import {formatUnits, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {displayAddress, parseAddress} from '@/core/address';
import {networkLabel, useNetwork} from '@/core/network-store';
import {useActiveAccount, useHiddenWallets} from '@/core/account-mode';
import {useVaults} from '@/core/vault-store';
import {WalletIcon} from '@/components/AccountSwitch';
import {walletRows} from './WalletListScreen';
import {fmtNum, shortAddress} from '@/core/format';
import {
  actOnDeal,
  depositToDeal,
  decided,
  sidesDecided,
  ended,
  escrowToken,
  OUTCOME,
  owedTo,
  readDeal,
  roleOf,
  snapshotOf,
  strayIn,
  rescueFrom,
  type Stray,
  estimateCalls,
  voteCall,
  cancelCall,
  estimateDeposit,
  estimateCancel,
  cancelDeal,
  STATUS,
  type Deal,
  type DealCost,
  type Outcome,
} from '@/escrow/escrow';
import {useEnergyRental} from '@/components/EnergyRental';
import {AddressInput} from '@/components/AddressInput';
import {ClearBtn} from '@/components/ClearBtn';
import {formatNative} from '@/vault/direct';
import {InfoIcon} from '@/components/TradeMenu';
import {OptionRow, SettingsGroup} from '@/components/SettingsRow';
import {NATIVE} from '@/core/chain';
import {usePrices} from '@/vault/usePrices';
import {usdValue} from '@/core/prices';
import {CopyAddress} from '@/components/CopyAddress';
import {Sheet} from '@/components/Sheet';
import {Button, ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {useWallet} from '@/wallet/store';
import {useT} from '@/i18n';
import {MONO, useColors, useStyles, type Colors} from '@/theme';
import {statusKey} from './EscrowScreen';
import {EscrowRule} from '@/components/EscrowRule';

/** A settled deal's status: where the money went. */
const SETTLED_KEY: Record<number, string> = {
  [OUTCOME.ToA]: 'mobile.escrow.settled_to_a',
  [OUTCOME.ToB]: 'mobile.escrow.settled_to_b',
  [OUTCOME.Refund]: 'mobile.escrow.refunded',
};

const OUTCOME_KEY: Record<number, string> = {
  [OUTCOME.ToA]: 'mobile.escrow.to_a',
  [OUTCOME.ToB]: 'mobile.escrow.to_b',
  [OUTCOME.Refund]: 'mobile.escrow.refund',
};

/**
 * One escrow deal: its terms, where it stands, and only what this wallet can do in it now —
 * deposit (A or B, while open), cancel (while open), decide (a voter, while funded and before the
 * end time), settle at the end time (anyone), and withdraw what it is owed, to any address.
 */
/** The header's explorer link: the open-outside mark, as on the in-app browser. A 44 pt target. */
function ExplorerButton({color, onPress}: {color: string; onPress: () => void}) {
  return (
    <Pressable onPress={onPress} hitSlop={10} style={explorerStyles.btn} accessibilityRole="link" accessibilityLabel="Tronscan">
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
        <Path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </Pressable>
  );
}
const explorerStyles = StyleSheet.create({btn: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'}});
// The header's title with the info mark after it.
const titleStyles = StyleSheet.create({row: {flexDirection: 'row', alignItems: 'center', gap: 6}, text: {fontSize: 17, fontWeight: '600'}});

export function EscrowDetailScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {params} = useRoute<RouteProp<RootStackParamList, 'EscrowDetail'>>();
  const network = useNetwork((s) => s.network);
  const me = useActiveAccount(network).wallet as Address | undefined;
  const token = escrowToken(network);
  const escrow = params.escrow as Address;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // The "do not send money here" note, behind an info mark after the title.
  const [aboutOpen, setAboutOpen] = useState(false);
  // Top right: the escrow's address on the network's explorer (Tronscan), in the app's browser.
  useLayoutEffect(() => {
    nav.setOptions({
      headerTitle: () => (
        <View style={titleStyles.row}>
          <Text style={[titleStyles.text, {color: c.text}]}>{t('mobile.escrow.title')}</Text>
          <Pressable onPress={() => setAboutOpen(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('mobile.escrow.about')}>
            <InfoIcon color={c.subtext} size={18} />
          </Pressable>
        </View>
      ),
      headerRight: () => <ExplorerButton color={c.accent} onPress={() => nav.navigate('Browser', {url: explorerAddressUrl(network, escrow)})} />,
    });
  }, [nav, network, escrow, c.accent, c.text, c.subtext, t]);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [owed, setOwed] = useState(BigInt(0));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toText, setToText] = useState('');
  // The withdraw sheet: where to, filled in with this wallet's own address.
  const [withdrawing, setWithdrawing] = useState(false);
  // The rules sheet, from the last row.
  const [rulesOpen, setRulesOpen] = useState(false);
  const [editingTo, setEditingTo] = useState(false);
  const [pickingTo, setPickingTo] = useState(false);
  const vaults = useVaults((s) => s.vaults);
  const hidden = useHiddenWallets((s) => s.hidden);
  const myWallets = useMemo(() => walletRows(vaults, hidden, 'shown'), [vaults, hidden]);

  // An older deal of a reused account: shown as last seen, nothing to do on it.
  const [past, setPast] = useState(false);
  // Money sent to the account by transfer: its owner can send it back (escrow `rescue`).
  const [stray, setStray] = useState<Stray | null>(null);
  const [rescuing, setRescuing] = useState(false);
  const [rescueTo, setRescueTo] = useState('');
  const wantId = params.dealId;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await readDeal(network, escrow);
      const old = wantId !== undefined && wantId !== d.dealId ? snapshotOf(network, escrow, wantId) : null;
      setPast(!!old);
      setDeal(old ?? d);
      setOwed(me && !old ? await owedTo(network, escrow, me) : BigInt(0));
      setStray(old ? null : await strayIn(network, d).catch(() => null));
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [network, escrow, me, wantId]);

  /**
   * "Your choice": a row that opens a sheet of the three outcomes, confirmed there with Face ID, the
   * energy rental and the fee, as every Tron confirm.
   */
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [picked, setPicked] = useState<Outcome | null>(null);
  // Cancel and refund: the red button opens a sheet that confirms it again, with its fee.
  const [cancelOpen, setCancelOpen] = useState(false);
  // Deposit, the same: its button opens a sheet with the amount, the fee and Face ID.
  const [depositOpen, setDepositOpen] = useState(false);
  const [voteCost, setVoteCost] = useState<DealCost | null>(null);
  const [voteCostState, setVoteCostState] = useState<'idle' | 'busy' | 'failed'>('idle');
  // The call the open sheet would send (a choice, or the cancel), estimated for its fee and rental.
  // A choice costs the same whichever outcome, so its fee is estimated as the sheet opens, before
  // one is picked (as "to depositor"; any outcome gives the same).
  const sheetCall = !deal ? null : choiceOpen ? voteCall(escrow, deal.dealId, OUTCOME.ToA) : cancelOpen ? cancelCall(escrow, deal.dealId) : null;
  const sheetKey = depositOpen && deal ? `deposit:${deal.address}#${deal.dealId}` : (sheetCall?.data ?? '');
  useEffect(() => {
    setVoteCost(null);
    if (!sheetKey || !me || !deal) return setVoteCostState('idle');
    setVoteCostState('busy');
    let live = true;
    // A cancel also takes back this wallet's own deposit, so the account can be reused.
    const mine = roleOf(deal, me);
    const paidMine = mine === 'a' ? deal.paidA && deal.amountA > BigInt(0) : mine === 'b' ? deal.paidB && deal.amountB > BigInt(0) : false;
    (depositOpen
      ? estimateDeposit(network, me, deal)
      : cancelOpen && !choiceOpen
        ? estimateCancel(network, me, deal, paidMine)
        : estimateCalls(network, me, [sheetCall!]))
      .then((c2) => live && (setVoteCost(c2), setVoteCostState('idle')))
      .catch(() => live && setVoteCostState('failed'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the call's data names it
  }, [sheetKey, me, network]);
  const voteRental = useEnergyRental({
    network,
    wallet: me,
    energy: voteCost ? Number(voteCost.energy) : null,
    price: voteCost?.price ?? null,
    bandwidth: voteCost?.bandwidth ?? null,
    worst: voteCost?.cost ?? null,
  });
  const prices = usePrices(network, 0, useMemo(() => [NATIVE[network].wrapped], [network]));
  const voteFeeUsd =
    voteRental.shownSun != null ? usdValue(Number(formatUnits(voteRental.shownSun, NATIVE[network].decimals)), NATIVE[network].wrapped, prices) : null;

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!token || !me) return null;
  const fmt = (v: bigint) => `${fmtNum(Number(formatUnits(v, token.decimals)))} ${token.symbol}`;
  const date = (s: number) => new Date(s * 1000).toLocaleString();

  const run = async (label: string, fn: (signer: Awaited<ReturnType<ReturnType<typeof useWallet.getState>['walletSigner']>>) => Promise<{hash: `0x${string}`}>) => {
    const tx = showTx(label, network);
    setBusy(label);
    try {
      const signer = await useWallet.getState().walletSigner();
      const {hash} = await fn(signer);
      tx.success(hash);
      await load();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/cancel/i.test(msg)) tx.done();
      else tx.error(msg);
    } finally {
      setBusy(null);
    }
  };

  if (!deal) {
    return (
      <SafeAreaView style={[styles.container, styles.center]} edges={['bottom']}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={c.subtext} />}
      </SafeAreaView>
    );
  }

  const role = roleOf(deal, me);
  const isEnded = ended(deal);
  const open = deal.status === STATUS.Open;
  const funded = deal.status === STATUS.Funded;
  const myAmount = role === 'a' ? deal.amountA : role === 'b' ? deal.amountB : BigInt(0);
  const iPaid = role === 'a' ? deal.paidA : role === 'b' ? deal.paidB : true;
  // The end time is only a precondition: votes count at any time, but settle no earlier than it.
  const agreed = decided(deal);
  const live = !past;
  const canDeposit = live && open && (role === 'a' || role === 'b') && !iPaid && myAmount > BigInt(0);
  // Nothing deposited yet: a plain cancel (it frees the account), with no refund to speak of.
  const anyPaid = (deal.paidA && deal.amountA > BigInt(0)) || (deal.paidB && deal.amountB > BigInt(0));
  const cancelKey = anyPaid ? 'mobile.escrow.cancel' : 'mobile.escrow.cancel_empty';
  const canCancel = live && open && (role === 'a' || role === 'b');
  const canVote = live && funded && !!role;
  const canFinalize = live && funded && isEnded && agreed !== OUTCOME.None;
  const waiting = funded && !!deal.endTime && !isEnded && agreed !== OUTCOME.None;
  const myVote = role ? deal.votes[role] : OUTCOME.None;
  const toAddr = parseAddress(network, toText);
  const badTo = toText.trim().length > 0 && !toAddr;

  /**
   * One party, as lines: who (and "you") with the address on the right; the amount; where they
   * stand (deposited or waiting; the arbiter, whether it has voted); and the vote, once cast.
   */
  // The arbiter is needed only once both sides have voted, differently, and it has not voted yet.
  const v = deal.votes;
  // Both sides have chosen and that settles nothing (they differ, neither gives all to the other,
  // or both give everything away), and the arbiter has not chosen yet.
  const arbiterNeeded = v.a !== OUTCOME.None && v.b !== OUTCOME.None && sidesDecided(deal) === OUTCOME.None && v.c === OUTCOME.None;
  const party = (label: string, who: Address, amount: bigint | null, paid: boolean | null, vote: Outcome, last = false) => (
    <View style={[styles.party, !last && styles.partyDivider]}>
      <View style={styles.rowBetween}>
        <Text style={styles.partyLabel}>
          {label}
          {who.toLowerCase() === me.toLowerCase() ? ` · ${t('mobile.escrow.you')}` : ''}
        </Text>
        {/* Shortened in the middle, with copy (which copies it in full). */}
        <CopyAddress address={displayAddress(network, who)} label={shortAddress(displayAddress(network, who))} textStyle={styles.mono} iconSize={13} />
      </View>
      {amount !== null ? (
        <View style={styles.rowBetween}>
          <Text style={styles.sub}>{t('mobile.escrow.amount')}</Text>
          <Text style={styles.value}>{fmt(amount)}</Text>
        </View>
      ) : null}
      {/* The arbiter has no status of its own: it is only asked when the two sides disagree. */}
      {paid !== null || arbiterNeeded ? (
        <View style={styles.rowBetween}>
          <Text style={styles.sub}>{t('mobile.escrow.current_status')}</Text>
          <Text style={styles.value}>
            {paid === null ? t('mobile.escrow.arbiter_needed') : t(paid ? 'mobile.escrow.deposited' : 'mobile.escrow.waiting_deposit')}
          </Text>
        </View>
      ) : null}
      {vote !== OUTCOME.None ? (
        <View style={styles.rowBetween}>
          <Text style={styles.sub}>{t('mobile.escrow.vote_label')}</Text>
          <Text style={styles.value}>{t(OUTCOME_KEY[vote])}</Text>
        </View>
      ) : null}
    </View>
  );

  // The app's pill buttons (components/Button), as on every other page.
  const action = (label: string, onPress: () => void, primary = true, key?: string) => (
    <Button key={key ?? label} title={label} variant={primary ? 'primary' : 'secondary'} onPress={onPress} loading={busy === label} disabled={!!busy && busy !== label} />
  );

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        // Under the translucent header, as on the Escrow list: without it the first rows sat behind the bar.
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          {/* The total, and where the deal stands on its right. */}
          <View style={styles.rowBetween}>
            <Text style={styles.total}>{fmt(deal.amountA + deal.amountB)}</Text>
            <Text style={styles.status}>
              {/* Settled says where the money went, in place of the bare "Settled". */}
              {t(deal.status === STATUS.Settled ? SETTLED_KEY[deal.outcome] : statusKey(deal))}
            </Text>
          </View>
          {/* The escrow's address, shortened in the middle, with copy (which copies it in full). */}
          <View style={styles.rowBetween}>
            <Text style={styles.sub}>{t('mobile.escrow.address')}</Text>
            <CopyAddress address={displayAddress(network, deal.address)} label={shortAddress(displayAddress(network, deal.address))} textStyle={styles.mono} iconSize={13} />
          </View>
          {/* The deal's terms, last in its first group: when it can settle, and the fee. */}
          <View style={styles.rowBetween}>
            <Text style={styles.sub}>{t('mobile.escrow.end')}</Text>
            <Text style={styles.value}>
              {deal.endTime ? t(isEnded ? 'mobile.escrow.ended' : 'mobile.escrow.ends', {date: date(deal.endTime)}) : t('mobile.escrow.end_none')}
            </Text>
          </View>
          {waiting ? <Text style={styles.sub}>{t('mobile.escrow.agreed_wait', {outcome: t(OUTCOME_KEY[agreed]), date: date(deal.endTime)})}</Text> : null}
          {/* The arbiter, second last: its address with copy; asked only when the two sides disagree. */}
          <View style={styles.rowBetween}>
            <Text style={styles.sub}>
              {t('mobile.escrow.role_c')}
              {deal.c.toLowerCase() === me.toLowerCase() ? ` · ${t('mobile.escrow.you')}` : ''}
            </Text>
            <CopyAddress address={displayAddress(network, deal.c)} label={shortAddress(displayAddress(network, deal.c))} textStyle={styles.mono} iconSize={13} />
          </View>
          {arbiterNeeded ? <Text style={styles.arbiterNote}>{t('mobile.escrow.arbiter_needed')}</Text> : null}
          {deal.votes.c !== OUTCOME.None ? (
            <View style={styles.rowBetween}>
              <Text style={styles.sub}>{t('mobile.escrow.role_c')} · {t('mobile.escrow.vote_label')}</Text>
              <Text style={styles.value}>{t(OUTCOME_KEY[deal.votes.c])}</Text>
            </View>
          ) : null}
          <View style={styles.rowBetween}>
            <Text style={styles.sub}>{t('mobile.escrow.fee')}</Text>
            <Text style={styles.value}>{deal.feeA === deal.feeB ? t('mobile.escrow.fee_each', {amount: fmt(deal.feeA)}) : `${t('mobile.escrow.role_a')} ${fmt(deal.feeA)} · ${t('mobile.escrow.role_b')} ${fmt(deal.feeB)}`}</Text>
          </View>
        </View>
        {past ? <Text style={[styles.sub, styles.centerText]}>{t('mobile.escrow.past_deal')}</Text> : null}

        {/* The two sides, each its own group; the arbiter is in the first group. */}
        <View style={[styles.card, styles.rows]}>{party(t('mobile.escrow.role_a'), deal.a, deal.amountA, deal.paidA, deal.votes.a, true)}</View>
        <View style={[styles.card, styles.rows]}>{party(t('mobile.escrow.role_b'), deal.b, deal.amountB, deal.paidB, deal.votes.b, true)}</View>

        {/* The account's owner: money sent here by transfer, and the way to send it back. */}
        {stray && stray.owner.toLowerCase() === me.toLowerCase() && (stray.token > BigInt(0) || stray.trx > BigInt(0) || stray.locked) ? (
          <View style={[styles.card, styles.strayCard]}>
            <Text style={styles.strayTitle}>{t('mobile.escrow.stray_title')}</Text>
            {stray.token > BigInt(0) ? (
              <View style={styles.rowBetween}>
                <Text style={styles.sub}>{token.symbol}</Text>
                <Text style={styles.value}>{fmt(stray.token)}</Text>
              </View>
            ) : null}
            {stray.trx > BigInt(0) ? (
              <View style={styles.rowBetween}>
                <Text style={styles.sub}>{NATIVE[network].symbol}</Text>
                <Text style={styles.value}>{`${formatNative(network, stray.trx)} ${NATIVE[network].symbol}`}</Text>
              </View>
            ) : null}
            <Text style={styles.sub}>{t(stray.token > BigInt(0) || stray.trx > BigInt(0) ? 'mobile.escrow.stray_text' : 'mobile.escrow.stray_locked')}</Text>
            {stray.token > BigInt(0) || stray.trx > BigInt(0)
              ? action(t('mobile.escrow.stray_send'), () => {
                  setRescueTo('');
                  setRescuing(true);
                }, false)
              : null}
          </View>
        ) : null}

        {!role ? <Text style={[styles.sub, styles.centerText]}>{t('mobile.escrow.not_a_party')}</Text> : null}

        {/* The rules, last: one row, its details in a sheet. */}
        <Pressable style={({pressed}) => [styles.card, styles.navRow, pressed && styles.pressed]} onPress={() => setRulesOpen(true)} accessibilityRole="button">
          <Text style={styles.navTitle}>{t('mobile.escrow.rule')}</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        {/* Your choice, the last group, as the Rules row: the outcomes and the confirm in a sheet. */}
        {canVote ? (
          <Pressable
            style={({pressed}) => [styles.card, styles.navRow, pressed && styles.pressed]}
            onPress={() => {
              setPicked(myVote !== OUTCOME.None ? myVote : null);
              setChoiceOpen(true);
            }}
            disabled={!!busy}
            accessibilityRole="button">
            <Text style={styles.navTitle}>{t('mobile.escrow.vote')}</Text>
            <View style={styles.navRight}>
              <Text style={myVote !== OUTCOME.None ? styles.navValue : styles.navValueAccent} numberOfLines={1}>
                {myVote !== OUTCOME.None ? t(OUTCOME_KEY[myVote]) : t('mobile.escrow.choose')}
              </Text>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Pressable>
        ) : null}
      </ScrollView>

      <Sheet visible={choiceOpen} title={t('mobile.escrow.vote')} onClose={() => setChoiceOpen(false)}>
        <View style={styles.sheetBody}>
          <SettingsGroup>
            {[OUTCOME.ToA, OUTCOME.ToB, OUTCOME.Refund].map((o, i) => (
              <OptionRow
                key={o}
                title={t(OUTCOME_KEY[o])}
                // Who it pays, by address: the initiator's or the counterparty's (a refund goes to each).
                sub={
                  [
                    o === OUTCOME.ToA ? shortAddress(displayAddress(network, deal.a)) : o === OUTCOME.ToB ? shortAddress(displayAddress(network, deal.b)) : null,
                    myVote === o ? t('mobile.escrow.voted') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
                checked={picked === o}
                onPress={() => setPicked(o)}
                last={i === 2}
              />
            ))}
          </SettingsGroup>
          {voteCostState === 'failed' ? <Text style={[styles.error, styles.inSheet]}>{t('mobile.account.fee_failed')}</Text> : null}
          <ConfirmButton
            onPress={() => {
              if (!picked || !voteCost) return;
              const o = picked;
              const rent = voteRental.renting ? {quote: voteRental.quote!, need: Number(voteCost.energy)} : undefined;
              setChoiceOpen(false);
              void run(t(OUTCOME_KEY[o]), (s2) => actOnDeal({account: s2, network, escrow, dealId: deal.dealId, action: {kind: 'vote', outcome: o}, rent}));
            }}
            loading={voteCostState === 'busy'}
            disabled={!picked || picked === myVote || !voteCost || !voteRental.ok || !!busy}
            pricing={!voteRental.toggle && voteFeeUsd == null}
            rental={voteRental.toggle}
            networkFeeUsd={voteFeeUsd ?? undefined}
          />
        </View>
      </Sheet>

      <Sheet visible={rescuing} title={t('mobile.escrow.stray_send')} onClose={() => setRescuing(false)}>
        <View style={styles.sheetBody}>
          <Text style={styles.sheetLabel}>{t('mobile.escrow.stray_to')}</Text>
          <View style={[styles.inputBox, styles.clearRow]}>
            <AddressInput style={[styles.input, styles.flex]} value={rescueTo} onChangeText={setRescueTo} placeholder={t('mobile.account.to_placeholder')} valid={!!parseAddress(network, rescueTo)} />
            {rescueTo ? <ClearBtn onPress={() => setRescueTo('')} /> : null}
          </View>
          {rescueTo.trim() && !parseAddress(network, rescueTo) ? <Text style={[styles.error, styles.inSheet]}>{t('mobile.account.bad_address', {network: networkLabel(network, t)})}</Text> : null}
          <ConfirmButton
            pricing
            disabled={!parseAddress(network, rescueTo) || !stray || !!busy}
            onPress={() => {
              const to = parseAddress(network, rescueTo);
              if (!to || !stray) return;
              const s0 = stray;
              setRescuing(false);
              // The token first, then TRX: one transaction each.
              void run(t('mobile.escrow.stray_send'), async (sg) => {
                let last: {hash: `0x${string}`} | null = null;
                if (s0.token > BigInt(0)) last = await rescueFrom({account: sg, network, escrow, token: deal.token, to, amount: s0.token});
                if (s0.trx > BigInt(0)) last = await rescueFrom({account: sg, network, escrow, token: null, to, amount: s0.trx});
                if (!last) throw new Error('Nothing to send back');
                return last;
              });
            }}
          />
        </View>
      </Sheet>

      {/* Deposit, confirmed in a sheet: the title says what and where; only Face ID, the fee and the rental under it. */}
      <Sheet
        visible={depositOpen}
        title={t('mobile.escrow.deposit_to', {amount: fmt(myAmount), address: shortAddress(displayAddress(network, deal.address))})}
        onClose={() => setDepositOpen(false)}>
        {/* Nothing between the title and the button: room above it so the two do not touch. */}
        <View style={[styles.sheetBody, styles.confirmOnly]}>
          {voteCostState === 'failed' ? <Text style={[styles.error, styles.inSheet]}>{t('mobile.account.fee_failed')}</Text> : null}
          <ConfirmButton
            onPress={() => {
              if (!voteCost) return;
              const rent = voteRental.renting ? {quote: voteRental.quote!, need: Number(voteCost.energy)} : undefined;
              const label = t('mobile.escrow.deposit', {amount: fmt(myAmount)});
              setDepositOpen(false);
              void run(label, (s2) => depositToDeal({account: s2, network, deal, rent}));
            }}
            loading={voteCostState === 'busy'}
            disabled={!voteCost || !voteRental.ok || !!busy}
            pricing={!voteRental.toggle && voteFeeUsd == null}
            rental={voteRental.toggle}
            networkFeeUsd={voteFeeUsd ?? undefined}
          />
        </View>
      </Sheet>

      {/* Cancel and refund, confirmed a second time: what it does, then Face ID with its fee. */}
      <Sheet visible={cancelOpen} title={t(cancelKey)} onClose={() => setCancelOpen(false)}>
        <View style={styles.sheetBody}>
          <Text style={styles.cancelText}>{t(anyPaid ? 'mobile.escrow.cancel_confirm' : 'mobile.escrow.cancel_empty_confirm')}</Text>
          {voteCostState === 'failed' ? <Text style={[styles.error, styles.inSheet]}>{t('mobile.account.fee_failed')}</Text> : null}
          <ConfirmButton
            color={c.danger}
            onPress={() => {
              if (!voteCost) return;
              const rent = voteRental.renting ? {quote: voteRental.quote!, need: Number(voteCost.energy)} : undefined;
              setCancelOpen(false);
              // Own deposit back at once: owed, it would keep the account from being reused.
              const withdraw = iPaid && myAmount > BigInt(0);
              void run(t(cancelKey), (s2) => cancelDeal({account: s2, network, deal, withdraw, rent}));
            }}
            loading={voteCostState === 'busy'}
            disabled={!voteCost || !voteRental.ok || !!busy}
            pricing={!voteRental.toggle && voteFeeUsd == null}
            rental={voteRental.toggle}
            networkFeeUsd={voteFeeUsd ?? undefined}
          />
        </View>
      </Sheet>

      <Sheet visible={aboutOpen} title={t('mobile.escrow.about')} onClose={() => setAboutOpen(false)}>
        <View style={styles.aboutSheet}>
          <Text style={styles.warnTitle}>{t('mobile.escrow.no_transfer_title')}</Text>
          <Text style={styles.warnText}>{t('mobile.escrow.no_transfer')}</Text>
        </View>
      </Sheet>

      <Sheet visible={rulesOpen} title={t('mobile.escrow.rule')} onClose={() => setRulesOpen(false)}>
        <View style={styles.rulesSheet}>
          <EscrowRule />
        </View>
      </Sheet>

      <Sheet visible={withdrawing} title={t('mobile.escrow.withdraw', {amount: fmt(owed)})} onClose={() => setWithdrawing(false)}>
        {pickingTo ? (
          // This phone's other wallets, in place of the form: a second sheet would open behind this one.
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.sheetBody}>
            <Pressable onPress={() => setPickingTo(false)} hitSlop={8} accessibilityRole="button">
              <Text style={styles.back}>‹ {t('mobile.escrow.withdraw', {amount: fmt(owed)})}</Text>
            </Pressable>
            <View style={styles.inputBox}>
              {myWallets.map((r, i) => (
                <Pressable
                  key={r.address}
                  onPress={() => {
                    setToText(displayAddress(network, r.address));
                    setEditingTo(false);
                    setPickingTo(false);
                  }}
                  style={[styles.pickRow, i < myWallets.length - 1 && styles.pickDivider]}
                  accessibilityRole="button">
                  <Text style={styles.value}>
                    {t('mobile.account.wallet_n', {n: r.number})}
                    {r.address.toLowerCase() === me.toLowerCase() ? ` · ${t('mobile.escrow.you')}` : ''}
                  </Text>
                  <Text style={styles.mono} numberOfLines={1} ellipsizeMode="middle">
                    {displayAddress(network, r.address)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : (
        <View style={styles.sheetBody}>
          <View style={[styles.inputBox, styles.clearRow]}>
            {editingTo || !toAddr ? (
              <TextInput
                style={[styles.input, styles.flex]}
                value={toText}
                onChangeText={setToText}
                onBlur={() => setEditingTo(false)}
                autoFocus={editingTo}
                autoCapitalize="none"
                autoCorrect={false}
              />
            ) : (
              // At rest, the address shortened in the middle (T1234…abcd) so both ends can be checked.
              <Pressable style={styles.flex} onPress={() => setEditingTo(true)} accessibilityRole="button">
                <Text style={styles.input} numberOfLines={1} ellipsizeMode="middle">
                  {toText}
                </Text>
              </Pressable>
            )}
            {toText ? (
              <Pressable
                onPress={() => {
                  setToText('');
                  setEditingTo(true);
                }}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.escrow.clear')}>
                <Text style={styles.clear}>✕</Text>
              </Pressable>
            ) : null}
            {myWallets.length > 1 ? (
              <Pressable onPress={() => setPickingTo(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('mobile.escrow.pick_wallet')}>
                <WalletIcon color={c.accent} size={20} />
              </Pressable>
            ) : null}
          </View>
          {badTo ? <Text style={[styles.error, styles.inSheet]}>{t('mobile.account.bad_address', {network: networkLabel(network, t)})}</Text> : null}
          {toAddr && toAddr.toLowerCase() !== me.toLowerCase() ? <Text style={styles.sub}>{t('mobile.escrow.withdraw_elsewhere')}</Text> : null}
          <ConfirmButton
            pricing
            disabled={!toAddr || !!busy}
            onPress={() => {
              if (!toAddr) return;
              const label = t('mobile.escrow.withdraw', {amount: fmt(owed)});
              setWithdrawing(false);
              void run(label, (s) => actOnDeal({account: s, network, escrow, dealId: deal.dealId, action: {kind: 'claim', to: toAddr}}));
            }}
          />
        </View>
        )}
      </Sheet>

      <View style={styles.footer}>
        {owed > BigInt(0)
          ? action(t('mobile.escrow.withdraw', {amount: fmt(owed)}), () => {
              // Back to this wallet unless changed.
              setToText(displayAddress(network, me));
              setEditingTo(false);
              setPickingTo(false);
              setWithdrawing(true);
            })
          : null}
        {canDeposit ? action(t('mobile.escrow.deposit', {amount: fmt(myAmount)}), () => setDepositOpen(true)) : null}
        {canFinalize ? action(t('mobile.escrow.finalize'), () => run(t('mobile.escrow.finalize'), (s) => actOnDeal({account: s, network, escrow, dealId: deal.dealId, action: {kind: 'finalize'}}))) : null}
        {canCancel ? (
          <Button title={t(cancelKey)} variant="danger" onPress={() => setCancelOpen(true)} loading={busy === t(cancelKey)} disabled={!!busy && busy !== t(cancelKey)} />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    sheetBody: {gap: 10},
    clearRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
    // The app's field colour, so the address reads as something to edit on the sheet's own surface.
    inputBox: {backgroundColor: c.input, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12},
    back: {color: c.accent, fontSize: 15, fontWeight: '600'},
    pickRow: {paddingVertical: 10, gap: 2},
    pickDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    flex: {flex: 1},
    clear: {color: c.subtext, fontSize: 16, fontWeight: '600'},
    // Its own box under the first group, with a group's corners.
    // The about sheet: the "do not send money here" note, at reading size.
    aboutSheet: {gap: 8, paddingHorizontal: 4, paddingBottom: 24},
    warnTitle: {color: c.danger, fontSize: 16, fontWeight: '700'},
    warnText: {color: c.text, fontSize: 15, lineHeight: 22},
    navRight: {flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1},
    arbiterNote: {color: c.accent, fontSize: 13, textAlign: 'right'},
    strayCard: {gap: 8},
    confirmOnly: {paddingTop: 28, paddingBottom: 8},
    cancelText: {color: c.text, fontSize: 15, lineHeight: 22, paddingHorizontal: 4},
    strayTitle: {color: c.danger, fontSize: 15, fontWeight: '700'},
    navValue: {color: c.subtext, fontSize: 15, flexShrink: 1},
    navValueAccent: {color: c.accent, fontSize: 15, fontWeight: '600'},
    container: {flex: 1, backgroundColor: c.bg},
    center: {alignItems: 'center', justifyContent: 'center', padding: 24},
    centerText: {textAlign: 'center'},
    // 20 pt between groups, as on Settings.
    content: {padding: 16, paddingTop: 4, gap: 20, paddingBottom: 24},
    // As a Settings group's label: inset to the card's content, right above its group.
    label: {color: c.subtext, fontSize: 15, fontWeight: '600', paddingHorizontal: 16, marginBottom: -12},
    // A Settings group's shape (SettingsRow `group`).
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, gap: 10},
    // A group of rows: each row carries its own padding, a hairline between.
    rows: {paddingVertical: 0, gap: 0},
    cardInput: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14},
    input: {color: c.text, fontSize: 15, fontFamily: MONO, padding: 0},
    total: {color: c.text, fontSize: 26, fontWeight: '800'},
    status: {color: c.accent, fontSize: 14, fontWeight: '700', flexShrink: 1, textAlign: 'right'},
    party: {gap: 6, paddingVertical: 12},
    // A Settings row: its title, and a chevron for the sheet it opens.
    navRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52},
    navTitle: {color: c.text, fontSize: 16, fontWeight: '500'},
    chevron: {color: c.subtext, fontSize: 22, fontWeight: '300'},
    pressed: {opacity: 0.6},
    rulesSheet: {paddingHorizontal: 4, paddingBottom: 24},
    partyDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    partyLabel: {color: c.text, fontSize: 15, fontWeight: '700'},
    rowBetween: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12},
    value: {color: c.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right'},
    sub: {color: c.subtext, fontSize: 13},
    mono: {color: c.subtext, fontSize: 12, fontFamily: MONO},
    error: {color: c.danger, fontSize: 13, marginHorizontal: 16},
    // In the withdraw sheet, which has its own padding.
    sheetLabel: {color: c.subtext, fontSize: 13, fontWeight: '600', marginLeft: 4},
    inSheet: {marginHorizontal: 4},
    options: {gap: 8},
    footer: {paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 10},
  });

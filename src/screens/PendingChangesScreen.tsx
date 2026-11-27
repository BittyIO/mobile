import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {CategoryTabs} from '@/components/ui';
import {PendingRow} from '@/components/PendingRow';
import {ProgressRing} from '@/components/ProgressRing';
import {QuantumInfoButton, QuantumKeys} from '@/components/QuantumHandover';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {fetchSecurityHistory, fetchTimelockHistory, getPendingChanges, getRiskConfig, updateRiskSettings, type PendingChange, type SecurityHistoryItem, type TimelockHistoryItem} from '@/vault/risk';
import {getStableCoinAsGasConfig, setStableCoinAsGasCoins} from '@/vault/stableCoinAsGas';
import {removeWhitelisted} from '@/vault/payments';
import {cancelPendingAssetManager, getAssetManager} from '@/vault/delegate';
import {cancelOwnershipTransfer} from '@/vault/ownership';
import {useVaultWrite} from '@/components/useVaultWrite';
import {OptionRow, SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {RISK_TITLE, fmtRiskValue} from '@/components/riskFormat';
import {isOpenRiskVersion} from '@/vault/risk';
import {useVaultGate} from '@/vault/gate';
import {valuesInForce, type RiskValues} from '@/core/safety-levels';
import {guardLevelOf, guardShieldOf} from '@/core/new-vault-defaults';
import {GuardShield} from '@/components/GuardShield';
import {PERM_ROWS} from '@/components/useAssetManagerRow';
import {Sheet} from '@/components/Sheet';
import {InfoIcon} from '@/components/TradeMenu';
import {Button} from '@/components/Button';
import Svg, {Circle, Path} from 'react-native-svg';
import {useWallet} from '@/wallet/store';
import {keyPathOf} from '@/wallet/rotation-store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {recipientName, useRecipientNames} from '@/core/recipient-names';
import type {Network} from '@/core/chain';
import type {Address} from 'viem';
import {useAccountWrite} from '@/account/useAccountWrite';
import {accountApplyCalls, accountCancelCalls, accountHistories, accountRiskValues, getAccountPending, type AccountExtra, type AccountPending} from '@/account/guard-evm';
import {cancelQueuedCall, lockCall, unlockCall} from '@/account/guard';
import {shortAddress} from '@/core/format';
import {readGuard} from '@/account/guard';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

type T = ReturnType<typeof useT>['t'];

/**
 * A pending item's title. An address-book entry carries the name given on this device after it —
 * "New whitelisted: Alice" — and the plain title where it has none.
 */
export function pendingTitle(p: PendingChange, t: T, nameOf?: (address: string) => string | undefined): string {
  switch (p.kind) {
    case 'timelock':
    case 'sendDailyAllowance':
    case 'marketTradeDailyLossAllowance':
      return t(RISK_TITLE[p.kind]);
    case 'gasBudgetDaily':
      return t('mobile.vault.pending_gas_budget');
    case 'maxFeePerOp':
      return t('mobile.vault.pending_max_fee');
    case 'newOwner':
      // One of this phrase's one-time keys: quantum-safe keys handing the vault on, not someone else.
      return t(keyPathOf(p.address) ? 'mobile.quantum.pending_title' : 'mobile.vault.pending_new_owner');
    case 'newAssetManager':
      return t('mobile.vault.pending_new_asset_manager');
    case 'whitelistAdd':
    case 'whitelistRemove': {
      const title = t(p.kind === 'whitelistAdd' ? 'mobile.vault.pending_whitelist_add' : 'mobile.vault.pending_whitelist_remove');
      const name = nameOf?.(p.address);
      return name ? t('mobile.vault.pending_named', {title, name}) : title;
    }
  }
}

/**
 * The extra a pending item's row draws, where its title and value cannot say what it is: today only
 * a handover to one of this phrase's one-time keys, which the user did not ask for in so many words
 * — quantum-safe keys queued it with their last operation. The row shows the two keys and what is
 * public about each, with an ⓘ for why (see components/QuantumHandover).
 */
export function pendingExtras(p: PendingChange): {titleRight?: React.ReactNode; detail?: React.ReactNode} {
  if (p.kind !== 'newOwner' || !keyPathOf(p.address)) return {};
  return {titleRight: <QuantumInfoButton />, detail: <QuantumKeys to={p.address} />};
}

/** The name an address-book entry goes by on this device, as the book shows it. */
export function useEntryLabel(network: Network) {
  const names = useRecipientNames((s) => s.names);
  return (address: string) => recipientName(names, network, address);
}

/** A moment in the history, to the minute: a timelock can be under a day, so the date alone is not enough. */
function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
}

/**
 * A pending item's value: for a limit, what it is now → what it changes to ("2 days → 1 day"), or just
 * the new value when the current one could not be read (and in the history, which records only that);
 * otherwise the address it is about.
 */
export function pendingValue(p: PendingChange, t: T): string {
  switch (p.kind) {
    case 'timelock':
    case 'sendDailyAllowance':
    case 'marketTradeDailyLossAllowance': {
      const kind = p.kind;
      const fmt = (v: bigint) => fmtRiskValue(kind, v, t);
      return p.from === undefined ? fmt(p.value) : `${fmt(p.from)} → ${fmt(p.value)}`;
    }
    case 'gasBudgetDaily':
    case 'maxFeePerOp': {
      // Whole dollars, as the contract stores them.
      const fmt = (v: bigint) => `$${Number(v).toLocaleString()}`;
      return p.from === undefined ? fmt(p.value) : `${fmt(p.from)} → ${fmt(p.value)}`;
    }
    default:
      return p.address;
  }
}

/** The history's icons, the pending row's ring size. */
const DONE_RING = 56;

const HISTORY_TABS = ['delays', 'strengthen'] as const;
type HistoryTab = (typeof HISTORY_TABS)[number];

/** A strengthening's title: the number made stricter, the lock raised, or "Cancelled: <what was waiting>". */
function strengthenTitle(s: SecurityHistoryItem, t: T, nameOf: (address: string) => string | undefined): string {
  if (s.kind === 'lock') return t(s.level >= 2 ? 'mobile.vault.forever_lock' : 'mobile.vault.emergency_lock');
  if (s.kind === 'cancel') return t('mobile.vault.history_cancelled', {title: pendingTitle(s.change, t, nameOf)});
  return t(RISK_TITLE[s.kind]);
}

/** Its value: "from → to" for a number, what was waiting for a cancel, nothing for a lock. */
function strengthenValue(s: SecurityHistoryItem, t: T): string {
  if (s.kind === 'lock') return '';
  if (s.kind === 'cancel') return pendingValue(s.change, t);
  return pendingValue({kind: s.kind, from: s.from, value: s.value, at: BigInt(s.at)}, t);
}

/**
 * Overview › Pending — everything the vault has been told to do and has not done yet: a loosened
 * risk number, a handover, an asset-manager grant, an address-book entry maturing or leaving. Each
 * counts down to the second to when it takes effect, because that is the owner's window to lock the
 * vault if they did not ask for it — which "No, it wasn't me" under the list goes straight to.
 *
 * One clock for the page, ticking only while it is in view. When an item comes due the list is read
 * again, so a change that has taken effect leaves it; at most every few seconds, since the chain's
 * clock can trail the phone's and the item may still read as pending for a block or two.
 */
export function PendingChangesScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const nameOf = useEntryLabel(network);
  const [items, setItems] = useState<AccountPending[] | null>(null);
  // The Tron smart wallet (BittyAccount) in front: the same page, its data from the account
  // (account/guard-evm) and each change relayed (account/useAccountWrite). Its extras are what a
  // vault has no kind for: an unlock waiting out the timelock, a batch this phone did not queue.
  const acct = useAccountWrite(() => load());
  const smart = acct.account != null;
  const [extras, setExtras] = useState<AccountExtra[]>([]);
  const [timelock, setTimelock] = useState(0);
  // Whether `timelock` has been read: 0 until then, which would read as no wait at all.
  const [timelockRead, setTimelockRead] = useState(false);
  // The two daily limits, beside the timelock: Guard holds all three.
  const [limits, setLimits] = useState<RiskValues | null>(null);
  const vaultGuardOpen = isOpenRiskVersion(useVaultGate().vaultVersion);
  const guardOpen = smart || vaultGuardOpen;
  const inForce = {
    timelock: BigInt(timelock),
    sendDailyAllowance: limits?.sendDailyAllowance ?? 0n,
    marketTradeDailyLossAllowance: limits?.marketTradeDailyLossAllowance ?? 0n,
  };
  // What already went through: `undefined` while the first read is out, `null` when the server could
  // not say, else the list (empty when nothing has gone through).
  const [history, setHistory] = useState<TimelockHistoryItem[] | null | undefined>(undefined);
  // What made it stricter, at once: the same three states.
  const [strengthened, setStrengthened] = useState<SecurityHistoryItem[] | null | undefined>(undefined);
  const [tab, setTab] = useState<HistoryTab>('delays');
  // The pager under the tabs, as AssetCategoryList's: its width, each page's height, and how far it has scrolled.
  const [pageW, setPageW] = useState(0);
  const [pageH, setPageH] = useState<Partial<Record<HistoryTab, number>>>({});
  const pagerRef = useRef<ScrollView>(null);
  const pagerX = useRef(new Animated.Value(0)).current;
  const pickTab = (k: HistoryTab) => {
    setTab(k);
    pagerRef.current?.scrollTo({x: HISTORY_TABS.indexOf(k) * pageW, animated: true});
  };
  const settleTab = (x: number) => {
    if (pageW <= 0) return;
    const k = HISTORY_TABS[Math.max(0, Math.min(HISTORY_TABS.length - 1, Math.round(x / pageW)))];
    if (k !== tab) setTab(k);
  };
  const heights = HISTORY_TABS.map((k) => pageH[k]);
  const sized = pageW > 0 && heights.every((h) => h != null);
  const tallest = sized ? Math.max(...(heights as number[])) : 0;
  const pagerStyle = sized
    ? {
        height: tallest,
        marginBottom: pagerX.interpolate({
          inputRange: HISTORY_TABS.map((_, i) => i * pageW),
          outputRange: (heights as number[]).map((h) => h - tallest),
          extrapolate: 'clamp' as const,
        }),
      }
    : undefined;
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const lastRead = useRef(0);
  const vw = useVaultWrite(() => load());
  const {run, sheet} = vw;
  const busy = smart ? acct.busy : vw.busy;
  const ready = smart ? acct.ready : vw.ready;

  const load = useCallback(() => {
    if (acct.account) {
      const a = acct.account;
      lastRead.current = Date.now();
      // The level from the account's own reads, at once; what is waiting (from its logs, slower) on
      // its own, so neither holds the other up and a failed one leaves the rest on the page.
      return Promise.all([
        readGuard(network, a)
          .then((guard) => {
            setTimelock(guard.timelock);
            setTimelockRead(true);
            setLimits(accountRiskValues(guard));
          })
          .catch(() => {}),
        getAccountPending(network, a)
          .then(({items: it, extras: ex}) => {
            setItems(it);
            setExtras(ex);
          })
          .catch(() => {
            setItems((cur) => cur ?? []);
            setExtras((cur) => cur);
          }),
        accountHistories(network, a)
          .then(({delays, strengthened: st}) => {
            setHistory(delays);
            setStrengthened(st);
          })
          .catch(() => {
            setHistory(null);
            setStrengthened(null);
          }),
      ]).catch(() => setItems((v) => v ?? []));
    }
    if (!vault) return;
    lastRead.current = Date.now();
    return Promise.all([
      getPendingChanges(vault, network).then(setItems),
      getRiskConfig(vault, network).then((r) => {
        setTimelock(Number(r.timelock));
        setTimelockRead(r.read);
        setLimits(valuesInForce(r));
      }),
      fetchTimelockHistory(vault, network).then(setHistory),
      fetchSecurityHistory(vault, network).then(setStrengthened),
    ]);
  }, [vault, network, acct.account]);

  /**
   * What calls an item off. Every kind waiting out the timelock can be, except a payee's removal —
   * the vault can only queue one or start it over, never take it back.
   *
   * A limit (the timelock, the two allowances, the two fee limits) has no cancel of its own on the
   * vault. It needs none: writing back the value IN FORCE is never a loosening, and anything that is
   * not a loosening applies at once and drops whatever was waiting (TimelockLib._apply). So the
   * cancel is that write, with the value read fresh from the vault rather than from this screen.
   * The two fee limits share one setter, so cancelling either cancels both.
   */
  const cancelFor = (p: AccountPending) => {
    if (acct.account) {
      const calls = accountCancelCalls(acct.account, p);
      if (!calls) return null;
      const title = t(p.kind === 'whitelistAdd' ? 'mobile.vault.cancel_whitelist_add' : 'mobile.vault.cancel_change');
      return () => void acct.run(`cancel-${p.kind}`, title, calls, 'address' in p ? p.address : undefined);
    }
    if (!vault) return null;
    if (p.kind === 'whitelistAdd')
      return () => run(`cancel-${p.kind}`, t('mobile.vault.cancel_whitelist_add'), (b) => removeWhitelisted({...b, id: p.id}), p.address);
    if (p.kind === 'newAssetManager')
      return () =>
        run(
          `cancel-${p.kind}`,
          t('mobile.vault.cancel_pending_manager'),
          async (b) => cancelPendingAssetManager({...b, current: await getAssetManager(vault, network)}),
          p.address,
        );
    // The same call the Ownership page makes: a vault has one handover waiting at most, so there is
    // nothing to name but the vault.
    if (p.kind === 'newOwner')
      return () => run(`cancel-${p.kind}`, t('mobile.vault.cancel_transfer'), (b) => cancelOwnershipTransfer(b), p.address);
    if (p.kind === 'timelock' || p.kind === 'sendDailyAllowance' || p.kind === 'marketTradeDailyLossAllowance') {
      const field = p.kind;
      return () =>
        run(`cancel-${p.kind}`, t('mobile.vault.cancel_change'), async (b) => {
          const r = await getRiskConfig(b.vault, b.network);
          if (!r.read) throw new Error(t('mobile.vault.cancel_change_unread'));
          return updateRiskSettings({...b, changes: {[field]: r[field]}});
        });
    }
    if (p.kind === 'gasBudgetDaily' || p.kind === 'maxFeePerOp')
      return () =>
        run(`cancel-${p.kind}`, t('mobile.vault.cancel_change'), async (b) => {
          const cfg = await getStableCoinAsGasConfig(b.vault, b.network);
          if (!cfg) throw new Error(t('mobile.vault.cancel_change_unread'));
          return setStableCoinAsGasCoins({...b, coins: cfg.stableCoins as Address[], dailyLimit: cfg.dailyLimit, maxFeePerOp: cfg.maxFeePerOp});
        });
    return null;
  };

  const [permsOf, setPermsOf] = useState<number | null>(null);
  /**
   * "No, it wasn't me" opens the two ways to stop what is waiting, each with what it means, and
   * goes straight to the one picked — rather than to the Lock page, where the owner would have to
   * find them. The sheet is a modal, so it is closed first and the push waits for it to go.
   */
  const [notMe, setNotMe] = useState(false);
  const lockWith = (action: 'emergency' | 'forever') => {
    setNotMe(false);
    // The smart wallet has the one lock, applied at once: no page of its own to go to.
    if (acct.account) {
      const a = acct.account;
      return void setTimeout(() => void acct.run('lock', t('mobile.vault.emergency_lock'), [lockCall(a)]), 320);
    }
    setTimeout(() => nav.navigate('VaultLockAction', {action}), 320);
  };
  // Why these wait, behind the ⓘ at the top right rather than as a paragraph over the list.
  const [aboutOpen, setAboutOpen] = useState(false);
  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Pressable onPress={() => setAboutOpen(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('mobile.vault.timelock_page_title')}>
          <InfoIcon color={c.accent} size={22} />
        </Pressable>
      ),
    });
  }, [nav, c, t]);
  const [refreshing, setRefreshing] = useState(false);
  const onPull = () => {
    setRefreshing(true);
    Promise.resolve(load()).finally(() => setRefreshing(false));
  };

  useFocusEffect(
    useCallback(() => {
      load();
      setNow(Math.floor(Date.now() / 1000));
      const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
      return () => clearInterval(id);
    }, [load]),
  );

  // Something came due: read again so it drops out once the chain agrees.
  // A queued batch stays until it is run (Apply), so it is not a reason to read again.
  const anyDue = items?.some((p) => !p.batch && Number(p.at) <= now) ?? false;
  useEffect(() => {
    if (anyDue && Date.now() - lastRead.current > 5_000) load();
  }, [anyDue, now, load]);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}>
      {/* The level first: the three numbers below set in one tap (core/new-vault-defaults). Only on a
          vault born open, where level 0 — no timelock, no limits — is a value the vault takes. */}
      {guardOpen && timelockRead && limits ? (
        <SettingsGroup>
          {/* Just the level in force here; the three to choose from are on a page of their own. */}
          <SettingsRow
            icon="guard"
            leading={<GuardShield level={guardShieldOf(inForce)} size={29} />}
            title={t('mobile.vault.guard_level')}
            // The level under its heading; on the right the number everything below is waiting out.
            sub={t(`mobile.vault.guard_level_${guardLevelOf(inForce)}`)}
            value={`${t(RISK_TITLE.timelock)} ${fmtRiskValue('timelock', inForce.timelock, t)}`}
            onPress={() => nav.navigate('GuardLevel')}
            last
          />
        </SettingsGroup>
      ) : null}
      {items === null || (items.length === 0 && extras.length === 0) ? (
        // An empty card rather than a line floating on its own: the page has the same shape
        // with nothing waiting as with something, and the answer sits where the changes would.
        // Loading is the same card with a spinner in it, as History's.
        <SettingsGroup label={t('mobile.vault.pending_section')}>
          <View style={styles.emptyRow}>
            {items === null ? <ActivityIndicator /> : <Text style={styles.empty}>{t('mobile.vault.pending_none')}</Text>}
          </View>
        </SettingsGroup>
      ) : (
        <>
        {/* Two cards: what is being added or changed, then what is being removed — a removal is
            the one that takes something away, so it is never mixed into the rest. */}
        {[items.filter((p) => p.kind !== 'whitelistRemove'), items.filter((p) => p.kind === 'whitelistRemove')].map((group, g, all) =>
          group.length === 0 ? null : (
            // The section's title goes on whichever card comes first.
            <SettingsGroup key={g} label={all.findIndex((x) => x.length > 0) === g ? t('mobile.vault.pending_section') : undefined}>
              {group.map((p, i) => {
                const cancel = cancelFor(p);
                return (
                  <PendingRow
                    key={`${p.kind}:${'address' in p ? p.address : ''}:${p.at}`}
                    at={Number(p.at)}
                    now={now}
                    timelock={timelock}
                    title={pendingTitle(p, t, nameOf)}
                    value={pendingValue(p, t)}
                    {...pendingExtras(p)}
                    // A new asset manager's permissions are a list, so they open in a sheet rather than crowd the row.
                    onPress={p.kind === 'newAssetManager' ? () => setPermsOf(p.perms) : undefined}
                    onCancel={cancel ?? undefined}
                    onApply={acct.account && p.batch ? () => void acct.run('apply', t('mobile.tron.guard_apply_title', {title: pendingTitle(p, t, nameOf)}), accountApplyCalls(acct.account!, p) ?? []) : undefined}
                    cancelling={busy === `cancel-${p.kind}`}
                    cancelDisabled={!ready || busy !== null}
                    onMatured={() => void load()}
                    last={i === group.length - 1}
                  />
                );
              })}
            </SettingsGroup>
          ),
        )}
        {extras.length && acct.account ? (
          <SettingsGroup label={items.length === 0 ? t('mobile.vault.pending_section') : undefined}>
            {extras.map((x, i) => {
              const a = acct.account!;
              return x.kind === 'unlock' ? (
                <PendingRow
                  key="unlock"
                  at={x.at}
                  now={now}
                  timelock={timelock}
                  title={t('mobile.tron.guard_unlock_pending')}
                  value={t('mobile.tron.guard_unlock_pending_value')}
                  onApply={() => void acct.run('unlock', t('mobile.tron.guard_unlock'), [unlockCall(a)])}
                  onCancel={() => void acct.run('lock', t('mobile.vault.cancel_change'), [lockCall(a)])}
                  cancelling={busy === 'lock'}
                  cancelDisabled={!ready}
                  last={i === extras.length - 1}
                />
              ) : (
                <PendingRow
                  key={x.id}
                  at={x.at}
                  now={now}
                  timelock={timelock}
                  title={t('mobile.tron.guard_unknown_change')}
                  value={shortAddress(x.id)}
                  onCancel={() => void acct.run(`cancel-${x.id}`, t('mobile.vault.cancel_change'), [cancelQueuedCall(a, x.id)])}
                  cancelling={busy === `cancel-${x.id}`}
                  cancelDisabled={!ready}
                  last={i === extras.length - 1}
                />
              );
            })}
          </SettingsGroup>
        ) : null}
        {/* The one thing to do about a change the owner did not ask for: lock before it lands. */}
        <SettingsGroup>
          <Pressable style={({pressed}) => [styles.notMe, pressed && styles.pressed]} onPress={() => setNotMe(true)}>
            <Text style={styles.notMeText}>{t('mobile.vault.pending_not_me')}</Text>
          </Pressable>
        </SettingsGroup>
        </>
      )}
      {/* What went through: the same titles and values, a check where the ring was, and when it was
          requested and took effect. Always there, so the page has the same shape loading, empty or
          full: a spinner while the first read is out, a line when nothing has gone through or the
          read failed, else the rows. A new delegate's permissions open in the same sheet as a
          pending one's. */}
      {/* Two histories behind two tabs: what loosened the smart wallet after waiting out the
          security delay, and what made it stricter — at once, with no wait. */}
      <View style={styles.historyBlock}>
        <CategoryTabs
          tabs={HISTORY_TABS.map((k) => ({key: k, label: t(k === 'delays' ? 'mobile.vault.history_delays' : 'mobile.vault.history_strengthen')}))}
          value={tab}
          onChange={pickTab}
        />
        {/* The two lists side by side, swiped or tapped between as Overview's Assets and Stocks are.
            The pager's height follows the page in view, so a short list does not keep a long one's space. */}
        <View onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
          {pageW > 0 ? (
            <Animated.ScrollView
              ref={pagerRef as never}
              horizontal
              pagingEnabled
              bounces={false}
              showsHorizontalScrollIndicator={false}
              style={pagerStyle}
              scrollEventThrottle={16}
              onScroll={Animated.event([{nativeEvent: {contentOffset: {x: pagerX}}}], {useNativeDriver: false})}
              onMomentumScrollEnd={(e) => settleTab(e.nativeEvent.contentOffset.x)}>
              {HISTORY_TABS.map((k) => (
                <View key={k} style={{width: pageW}}>
                  <View
                    style={styles.page}
                    onLayout={(e) => {
                      // Read the height now: the event is pooled and recycled before an updater runs.
                      const h = e.nativeEvent.layout.height;
                      setPageH((prev) => (prev[k] === h ? prev : {...prev, [k]: h}));
                    }}>
                    <SettingsGroup>
                      {(k === 'delays' ? history : strengthened) === undefined ? (
                        <View style={styles.emptyRow}>
                          <ActivityIndicator />
                        </View>
                      ) : k === 'delays' ? (
                        history === null || !history?.length ? (
                          <View style={styles.emptyRow}>
                            <Text style={styles.empty}>{t(history === null ? 'mobile.vault.history_failed' : 'mobile.vault.history_none')}</Text>
                          </View>
                        ) : (
                          history.slice(0, 50).map((p, i, all) => (
                            <Pressable
                              key={`${p.txHash}:${p.kind}:${p.effectiveAt}`}
                              style={({pressed}) => [styles.done, i < all.length - 1 && styles.doneDivider, pressed && p.kind === 'newAssetManager' && styles.pressed]}
                              onPress={p.kind === 'newAssetManager' ? () => setPermsOf(p.perms) : undefined}
                              disabled={p.kind !== 'newAssetManager'}>
                              {/* The pending row's ring, run all the way round, with the wait it sat out in the middle. */}
                              <ProgressRing done={1} left={p.effectiveAt - p.queuedAt} tint={c.success} />
                              <View style={styles.doneText}>
                                <Text style={styles.doneTitle} numberOfLines={1}>{pendingTitle(p, t, nameOf)}</Text>
                                <Text style={styles.doneValue} numberOfLines={1} ellipsizeMode="middle">{pendingValue(p, t)}</Text>
                                {/* The wait it sat out: when it was requested, and when it took effect. */}
                                <Text style={styles.doneDate}>{t('mobile.vault.history_requested', {date: when(p.queuedAt)})}</Text>
                                <Text style={styles.doneDate}>{t('mobile.vault.history_effective', {date: when(p.effectiveAt)})}</Text>
                              </View>
                            </Pressable>
                          ))
                        )
                      ) : strengthened === null || !strengthened?.length ? (
                        <View style={styles.emptyRow}>
                          <Text style={styles.empty}>{t(strengthened === null ? 'mobile.vault.history_failed' : 'mobile.vault.strengthen_none')}</Text>
                        </View>
                      ) : (
                        strengthened.slice(0, 50).map((s, i, all) => (
                          <View key={`${s.txHash}:${s.kind}:${i}`} style={[styles.done, i < all.length - 1 && styles.doneDivider]}>
                            {/* A bolt, not a ring: nothing was waited out. */}
                            <Svg width={DONE_RING} height={DONE_RING} viewBox="0 0 24 24">
                              <Circle cx={12} cy={12} r={11} fill={c.success} />
                              <Path d="M13 5 7.5 13H12l-1 6 5.5-8H12z" fill="#fff" />
                            </Svg>
                            <View style={styles.doneText}>
                              <Text style={styles.doneTitle} numberOfLines={1}>{strengthenTitle(s, t, nameOf)}</Text>
                              {strengthenValue(s, t) ? (
                                <Text style={styles.doneValue} numberOfLines={1} ellipsizeMode="middle">{strengthenValue(s, t)}</Text>
                              ) : null}
                              <Text style={styles.doneDate}>{t('mobile.vault.history_instant', {date: when(s.at)})}</Text>
                            </View>
                          </View>
                        ))
                      )}
                    </SettingsGroup>
                  </View>
                </View>
              ))}
            </Animated.ScrollView>
          ) : null}
        </View>
      </View>
      {/* Why these wait: the timelock, said without the word. */}
      <Sheet visible={aboutOpen} title={t('mobile.vault.timelock_page_title')} onClose={() => setAboutOpen(false)}>
        <View style={styles.about}>
          <Text style={styles.notMeIntro}>{t('mobile.vault.timelock_intro')}</Text>
        </View>
      </Sheet>
      <Sheet visible={notMe} title={t('mobile.vault.not_me_title')} onClose={() => setNotMe(false)}>
        <View style={styles.notMeBody}>
          <Text style={styles.notMeIntro}>{t('mobile.vault.not_me_intro')}</Text>
          <View style={styles.notMeOption}>
            <Text style={styles.notMeHint}>{t('mobile.vault.emergency_lock_hint')}</Text>
            <Button title={t('mobile.vault.emergency_lock')} onPress={() => lockWith('emergency')} />
          </View>
          {smart ? null : (
            <View style={styles.notMeOption}>
              <Text style={styles.notMeHint}>{t('mobile.vault.forever_lock_hint')}</Text>
              <Button title={t('mobile.vault.forever_lock')} variant="danger" onPress={() => lockWith('forever')} />
            </View>
          )}
        </View>
      </Sheet>
      <Sheet visible={permsOf !== null} title={t('mobile.vault.permissions')} onClose={() => setPermsOf(null)}>
        <SettingsGroup>
          {PERM_ROWS.map((r, i) => (
            <OptionRow key={r.bit} title={t(r.key)} checked={((permsOf ?? 0) & r.bit) !== 0} last={i === PERM_ROWS.length - 1} />
          ))}
        </SettingsGroup>
      </Sheet>
      {sheet}
      {acct.sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    about: {paddingHorizontal: 4, paddingBottom: 24},
    emptyRow: {paddingVertical: 22, paddingHorizontal: 16, alignItems: 'center'},
    empty: {color: c.subtext, fontSize: 15, textAlign: 'center'},
    // Sized to the bar's 44 like the trade menu's: the native bar anchors a custom view by its bottom.
    notMe: {minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
    notMeText: {color: c.danger, fontSize: 16, fontWeight: '600'},
    notMeBody: {gap: 20, paddingTop: 4},
    notMeIntro: {color: c.text, fontSize: 15, lineHeight: 21},
    notMeOption: {gap: 10},
    notMeHint: {color: c.subtext, fontSize: 13, lineHeight: 19},
    pressed: {opacity: 0.6},
    done: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: c.card},
    doneDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    doneText: {flex: 1, gap: 3},
    doneTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
    doneValue: {color: c.subtext, fontSize: 13},
    doneDate: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
    historyBlock: {gap: 8},
    // Each page on its own, its card's top at the page's top: the pager measures this for its height.
    page: {alignSelf: 'flex-start', width: '100%'},
  });

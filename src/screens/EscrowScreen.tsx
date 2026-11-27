import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {formatUnits, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {displayAddress, parseAddress} from '@/core/address';
import {useNetwork} from '@/core/network-store';
import {useActiveAccount} from '@/core/account-mode';
import {fmtNum, shortAddress} from '@/core/format';
import {CopyAddress} from '@/components/CopyAddress';
import {CategoryTabs} from '@/components/ui';

const TABS = ['open', 'finished'] as const;
type Tab = (typeof TABS)[number];
import {dealKey, owedTo, discoverEscrows, fillStartDates, joinedEscrows, myAccounts, rememberJoined, escrowFactory, escrowToken, knownDeals, knownEscrows, readDeal, rememberEscrow, roleOf, STATUS, type Deal} from '@/escrow/escrow';
import {ScanButton} from '@/components/ScanIcon';
import {QrScanner} from '@/components/QrScanner';
import {useT} from '@/i18n';
import {MONO, useColors, useStyles, type Colors} from '@/theme';

/** The status line of a deal, as the list and the detail page show it. */
export function statusKey(d: Deal, over = false): string {
  // A deal its account has moved on from is over, whatever it last showed (or never showed: seen
  // only in its start event).
  if (over && d.status !== STATUS.Settled && d.status !== STATUS.Cancelled) return 'mobile.escrow.status_over';
  if (d.status === STATUS.None) return 'mobile.escrow.status_over';
  if (d.status === STATUS.Open) return 'mobile.escrow.status_open';
  if (d.status === STATUS.Funded) return 'mobile.escrow.status_funded';
  if (d.status === STATUS.Settled) return 'mobile.escrow.status_settled';
  return 'mobile.escrow.status_cancelled';
}

/**
 * Overview › Escrow (the Tron wallet): "Join an escrow" for one someone shared, then History, every
 * deal this wallet is in, newest first. New escrow is the + at the top right.
 */
export function EscrowScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const me = useActiveAccount(network).wallet as Address | undefined;
  const token = escrowToken(network);
  const available = !!escrowFactory(network) && !!token;

  const [deals, setDeals] = useState<Deal[] | null>(null);
  // Each account's current deal number: a row for an older one is a deal that is over.
  const [current, setCurrent] = useState<Record<string, number>>({});
  // History in two: the deals still going (the default), and the finished ones.
  const [tab, setTab] = useState<Tab>('open');
  // Settled or cancelled deals someone has not withdrawn from yet: still Open, not Finished.
  const [unpaid, setUnpaid] = useState<Set<string>>(new Set());
  const pagerRef = useRef<ScrollView>(null);
  const [pageW, setPageW] = useState(0);
  const [loading, setLoading] = useState(false);
  const [openText, setOpenText] = useState('');
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [scanning, setScanning] = useState(false);

  // New escrow: the + at the top right.
  useLayoutEffect(() => {
    if (!available) return;
    nav.setOptions({
      headerRight: () => (
        <Pressable onPress={() => nav.navigate('EscrowCreate')} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('mobile.escrow.new')}>
          <Text style={styles.plus}>＋</Text>
        </Pressable>
      ),
    });
  }, [nav, available, styles, t]);

  const load = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    // One deal at a time, each tried twice: all at once, TronGrid's rate limit failed some reads and
    // their deals dropped out of the list as if they were gone.
    // This phone's own list, and every deal the chain says this wallet is in (made elsewhere, or
    // before a reinstall), remembered so they open quickly next time.
    // Only the wallet's own accounts and ones joined here by address: a deal someone else started
    // naming this wallet is never listed, as that is how a scam would reach the user.
    const mine = me ? await myAccounts(network, me) : [];
    const found = me ? await discoverEscrows(network, me, mine).catch(() => [] as Address[]) : [];
    for (const a of [...found].reverse()) if (!knownEscrows(network).some((k) => k.toLowerCase() === a.toLowerCase())) rememberEscrow(network, a);
    const allowed = new Set([...mine, ...joinedEscrows(network)].map((a) => a.toLowerCase()));
    // Each account's current deal, read fresh (readDeal keeps it); then every deal seen, the older
    // ones in reused accounts as last seen.
    const current: Record<string, number> = {};
    const owing = new Set<string>();
    for (const a of knownEscrows(network)) {
      if (!allowed.has(a.toLowerCase())) continue;
      const d = await readDeal(network, a).catch(() => readDeal(network, a).catch(() => null));
      if (!d) continue;
      current[a.toLowerCase()] = d.dealId;
      // Over on chain, but money still to withdraw: not finished for whoever is owed it.
      if (d.status === STATUS.Settled || d.status === STATUS.Cancelled) {
        const [oa, ob] = await Promise.all([owedTo(network, a, d.a).catch(() => BigInt(0)), owedTo(network, a, d.b).catch(() => BigInt(0))]);
        if (oa + ob > BigInt(0)) owing.add(dealKey(a, d.dealId));
      }
    }
    setUnpaid(owing);
    setCurrent(current);
    // Created dates for deals not seen in the factory's events (joined by address): best effort.
    await fillStartDates(network).catch(() => {});
    setDeals(knownDeals(network).filter((d) => current[d.address.toLowerCase()] !== undefined));
    setLoading(false);
  }, [available, network, me]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const open = async (text: string) => {
    const a = parseAddress(network, text);
    if (!a) return;
    setOpening(true);
    setOpenError(null);
    try {
      await readDeal(network, a);
      rememberEscrow(network, a);
      rememberJoined(network, a);
      setOpenText('');
      nav.navigate('EscrowDetail', {escrow: a});
    } catch {
      setOpenError(t('mobile.escrow.open_bad'));
    } finally {
      setOpening(false);
    }
  };

  // Join as soon as the field holds a whole address, typed, pasted or scanned; no button to press.
  useEffect(() => {
    if (parseAddress(network, openText)) open(openText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openText, network]);

  if (!available) {
    return (
      <SafeAreaView style={[styles.container, styles.center]} edges={['bottom']}>
        <Text style={styles.sub}>{t('mobile.escrow.unavailable')}</Text>
      </SafeAreaView>
    );
  }

  const amt = (v: bigint) => `${fmtNum(Number(formatUnits(v, token.decimals)))} ${token.symbol}`;

  // A deal is finished once settled or cancelled, or when its account has started a newer one.
  const overOf = (d: Deal) => (current[d.address.toLowerCase()] ?? d.dealId) > d.dealId;
  // An older deal its account moved on from is always paid out: the account is only reused then.
  const finished = (d: Deal) =>
    overOf(d) || d.status === STATUS.None || ((d.status === STATUS.Settled || d.status === STATUS.Cancelled) && !unpaid.has(dealKey(d.address, d.dealId)));
  const rowsOf = (k: Tab) => (deals ?? []).filter((d) => (k === 'finished') === finished(d));

  const row = (d: Deal) => {
    const role = me ? roleOf(d, me) : null;
    return (
      <Pressable key={dealKey(d.address, d.dealId)} style={styles.card} onPress={() => nav.navigate('EscrowDetail', {escrow: d.address, dealId: d.dealId})} accessibilityRole="button">
        {/* The amount with the deal's address (copy) on its right, then where it stands (blue) and this wallet's part in it. */}
        <View style={styles.rowBetween}>
          <Text style={styles.title}>{amt(d.amountA + d.amountB)}</Text>
          <CopyAddress address={displayAddress(network, d.address)} label={shortAddress(displayAddress(network, d.address))} textStyle={styles.mono} iconSize={13} />
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.status}>
            {t(statusKey(d, overOf(d)))}
            {unpaid.has(dealKey(d.address, d.dealId)) ? ` · ${t('mobile.escrow.to_withdraw')}` : ''}
          </Text>
          <Text style={styles.sub}>{role ? t(`mobile.escrow.role_${role}`) : '—'}</Text>
        </View>
        {/* Last line: when the deal was created. */}
        {d.startedAt ? (
          <View style={styles.rowBetween}>
            <Text style={styles.sub}>{t('mobile.escrow.created_label')}</Text>
            <Text style={styles.sub}>{new Date(d.startedAt).toLocaleString(undefined, {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  // One tab's page: its rows, or a group holding the empty text, as the app's other empty lists.
  const page = (k: Tab) => {
    const rows = rowsOf(k);
    if (rows.length) return rows.map(row);
    return (
      <View style={[styles.card, styles.emptyCard]}>
        <Text style={[styles.sub, styles.empty]}>{t(deals?.length ? `mobile.escrow.empty_${k}` : 'mobile.escrow.empty')}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
        <Text style={[styles.label, styles.firstLabel]}>{t('mobile.escrow.open')}</Text>
        <View style={styles.card}>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={openText}
              onChangeText={(v) => (setOpenText(v), setOpenError(null))}
              placeholder={t('mobile.escrow.open_placeholder')}
              placeholderTextColor={c.subtext}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!opening}
            />
            {/* A whole address joins by itself: a spinner while it is checked, then its page. */}
            {opening ? <ActivityIndicator color={c.subtext} /> : <ScanButton onPress={() => setScanning(true)} />}
          </View>
        </View>
        {openError ? <Text style={styles.error}>{openError}</Text> : null}

        {/* History in two, as the app's category tabs: Open (still going), then Finished (settled,
            cancelled, or one its account has moved on from). Tap a tab, or swipe the pages. */}
        <View style={styles.tabs}>
          <CategoryTabs
            tabs={TABS.map((k) => ({key: k, label: t(`mobile.escrow.tab_${k}`)}))}
            value={tab}
            onChange={(k) => {
              setTab(k);
              pagerRef.current?.scrollTo({x: TABS.indexOf(k) * pageW, animated: true});
            }}
          />
        </View>
        {deals === null ? (
          <ActivityIndicator color={c.subtext} style={styles.spinner} />
        ) : (
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            onLayout={(e) => setPageW(e.nativeEvent.layout.width)}
            onMomentumScrollEnd={(e) => pageW > 0 && setTab(TABS[Math.round(e.nativeEvent.contentOffset.x / pageW)] ?? 'open')}>
            {TABS.map((k) => (
              <View key={k} style={[styles.page, {width: pageW}]}>
                {page(k)}
              </View>
            ))}
          </ScrollView>
        )}
      </ScrollView>

      {scanning ? (
        <QrScanner
          visible={scanning}
          onScan={(a) => {
            setScanning(false);
            setOpenText(displayAddress(network, a));
          }}
          onClose={() => setScanning(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

export const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    center: {alignItems: 'center', justifyContent: 'center', padding: 24},
    content: {padding: 16, paddingTop: 4, gap: 8, paddingBottom: 32},
    // As a Settings group's label: inset to the card's content, with room above each section.
    label: {color: c.subtext, fontSize: 15, fontWeight: '600', marginTop: 22, paddingHorizontal: 16},
    firstLabel: {marginTop: 8},
    // A Settings group's shape (SettingsRow `group`).
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, gap: 6},
    inputRow: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 28},
    input: {flex: 1, color: c.text, fontSize: 15, fontFamily: MONO, padding: 0},
    plus: {color: c.accent, fontSize: 26, fontWeight: '400'},
    rowBetween: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12},
    // Beside the amount, giving way to it: shortened in the middle when the line is short.
    title: {color: c.text, fontSize: 17, fontWeight: '700'},
    status: {color: c.accent, fontSize: 13, fontWeight: '700'},
    sub: {color: c.subtext, fontSize: 13},
    mono: {color: c.subtext, fontSize: 12, fontFamily: MONO},
    error: {color: c.danger, fontSize: 13, marginHorizontal: 16},
    tabs: {paddingHorizontal: 12, marginTop: 14},
    // One tab's page: its rows, spaced as the screen's groups.
    page: {gap: 8},
    emptyCard: {minHeight: 72, alignItems: 'center', justifyContent: 'center'},
    empty: {textAlign: 'center', fontSize: 15},
    spinner: {marginTop: 16},
  });

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {formatUnits} from 'viem';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {useNetwork} from '@/core/network-store';
import {fmtNum, shortAddress} from '@/core/format';
import {openLink} from '@/core/open-link';
import {Amount} from '@/components/Amount';
import {GasIcon} from '@/components/GasIcon';
import {TokenIcon} from '@/components/TokenIcon';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {useTronWallet} from '@/tron/store';
import {recentTransfers, type TronTransfer} from '@/tron/client';
import {TRON_EXPLORER_TX} from '@/tron/config';

/** Rows drawn per page, as on the vault's History: the next ten come in as the list nears its end. */
const PAGE_SIZE = 10;
/** How far back TronGrid is asked, per token. Paged on the phone, ten at a time. */
const FETCH_LIMIT = 50;

type Tab = 'all' | 'send' | 'receive';

/** The vault History's timestamp: day, month and time, no year, in the reader's own order. */
function fmtDate(ms: number, locale: string): string {
  return new Date(ms).toLocaleString(locale, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}

const human = (raw: bigint, decimals: number) => fmtNum(Number(formatUnits(raw, decimals)));

/**
 * The Tron wallet's history, drawn as the vault's History is: the same category tabs, the same
 * card per transaction — its title, the amount line with who was on the other side, then a footer
 * with the time, the fee, and the link out to the explorer.
 *
 * Only two categories exist here, because a plain wallet only ever sends and receives.
 */
export function TronHistoryScreen() {
  const {t, language} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const net = useNetwork((s) => s.tron) ?? 'tron';
  const address = useTronWallet((s) => s.address);

  const [activity, setActivity] = useState<TronTransfer[] | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('all');
  const [pages, setPages] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!address) return;
    const n = ++seq.current;
    await recentTransfers(net, address, FETCH_LIMIT).then(
      (a) => n === seq.current && setActivity(a),
      () => n === seq.current && setActivity((a) => a ?? null),
    );
  }, [address, net]);

  useEffect(() => {
    setActivity(undefined);
    setTab('all');
  }, [net, address]);
  useEffect(() => setPages(1), [tab, net, address]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // As on the vault's History: a tab only for a category that has something in it, and no strip at
  // all until there are two to choose between.
  const tabs = useMemo(() => {
    const out: {key: Tab; label: string}[] = [{key: 'all', label: t('vault.all')}];
    if (activity?.some((x) => x.direction === 'out')) out.push({key: 'send', label: t('vault.sent')});
    if (activity?.some((x) => x.direction === 'in')) out.push({key: 'receive', label: t('vault.received')});
    return out;
  }, [activity, t]);
  useEffect(() => {
    if (!tabs.some((x) => x.key === tab)) setTab('all');
  }, [tabs, tab]);

  const shown = useMemo(
    () => (activity ?? []).filter((x) => tab === 'all' || (tab === 'send') === (x.direction === 'out')),
    [activity, tab],
  );
  const visible = shown.slice(0, pages * PAGE_SIZE);
  const more = visible.length < shown.length;

  const header =
    tabs.length > 2 ? (
      <View style={styles.tabStrip}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
          {tabs.map((x) => (
            <Pressable key={x.key} style={styles.tab} onPress={() => setTab(x.key)}>
              <Text style={[styles.tabText, tab === x.key && styles.tabTextOn]}>{x.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    ) : null;

  return (
    <FlatList
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      data={activity === null ? [] : visible}
      keyExtractor={(x) => `${x.txID}:${x.symbol}:${x.direction}`}
      initialNumToRender={PAGE_SIZE}
      onEndReached={() => more && setPages((p) => p + 1)}
      onEndReachedThreshold={0.6}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={c.text} colors={[c.accent]} />}
      ListHeaderComponent={header}
      ListEmptyComponent={
        activity === undefined ? (
          <ActivityIndicator color={c.accent} />
        ) : (
          <Text style={styles.note}>{t(activity === null ? 'mobile.tron.activity_failed' : 'mobile.tron.no_activity')}</Text>
        )
      }
      ListFooterComponent={more ? <ActivityIndicator color={c.subtext} /> : null}
      renderItem={({item: x}) => {
        const out = x.direction === 'out';
        return (
          <Pressable style={styles.op} onPress={() => openLink(TRON_EXPLORER_TX[net] + x.txID, 'Tronscan')}>
            <View style={styles.opHeader}>
              <Text style={styles.title}>
                {t(out ? 'vault.sent' : 'vault.received')}
                {x.failed ? <Text style={styles.failed}>{`  ${t('mobile.tron.failed')}`}</Text> : null}
              </Text>
            </View>
            <View style={styles.leg}>
              {x.symbol === 'TRX' ? <NetworkIcon network={net} size={20} /> : <TokenIcon symbol={x.symbol} size={20} />}
              <Text style={[styles.legText, out ? styles.outC : styles.inC]}>
                {out ? '−' : '+'}
                <Amount v={human(x.raw, x.decimals)} /> {x.symbol}
              </Text>
              <View style={styles.counterparty}>
                <Text style={styles.counterpartyText} numberOfLines={1}>
                  {t(out ? 'mobile.home.to_address' : 'mobile.home.from_address', {address: shortAddress(x.counterparty)})}
                </Text>
              </View>
            </View>
            <View style={styles.footer}>
              <View style={styles.meta}>
                <Text style={styles.date}>{fmtDate(x.at, language)}</Text>
                {/* What the send burned, beside the gas mark as on the vault's rows. A transfer
                    covered by staked bandwidth burns nothing, and then there is nothing to show. */}
                {x.fee ? (
                  <>
                    <GasIcon color={c.subtext} size={12} />
                    <Text style={styles.fee}>
                      <Amount v={human(x.fee, 6)} size={12} color={c.subtext} /> TRX
                    </Text>
                  </>
                ) : null}
              </View>
              <Text style={styles.link}>{t('mobile.home.view')} ↗</Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

// The vault History's own measurements, so the two pages read as one.
const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    tabStrip: {marginTop: -4, marginBottom: -8},
    tabRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 20, paddingHorizontal: 4},
    tab: {alignItems: 'center', paddingVertical: 6},
    tabText: {color: c.subtext, fontSize: 15, fontWeight: '600'},
    tabTextOn: {color: c.text, fontWeight: '700'},
    content: {flexGrow: 1, padding: 16, gap: 16, paddingBottom: 32},
    op: {backgroundColor: c.card, borderRadius: 20, padding: 18, gap: 12},
    opHeader: {marginBottom: 10},
    title: {color: c.text, fontSize: 15, fontWeight: '400'},
    failed: {color: c.danger, fontSize: 12, fontWeight: '700'},
    leg: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6},
    legText: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums']},
    outC: {color: c.warning},
    inC: {color: c.success},
    counterparty: {marginLeft: 'auto', flexShrink: 1},
    counterpartyText: {color: c.subtext, fontSize: 13},
    footer: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 10},
    meta: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1},
    date: {color: c.subtext, fontSize: 12},
    fee: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
    link: {color: c.accent, fontSize: 12, fontWeight: '600'},
    note: {color: c.subtext, fontSize: 14, textAlign: 'center', marginTop: 24},
  });

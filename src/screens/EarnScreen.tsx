import {useTransparentHeaderInset} from '@/components/header-inset';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {ProtocolChip} from '@/components/ProtocolIcon';
import {useNetwork} from '@/core/network-store';
import {formatUnits} from 'viem';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {useFlows} from '@/vault/useFlows';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {earnedRaw} from '@/vault/flows';
import {usePrices} from '@/vault/usePrices';
import {usdValue} from '@/core/prices';
import {balanceOfSymbol} from '@/vault/read';
import {getLidoUnstake, NO_UNSTAKE, queuedStakeAdapter, queueUnits, type LidoUnstake} from '@/vault/lido';
import {TRON_STAKE} from '@/vault/tron-stake';
import {useOwnerEnergy} from '@/vault/useOwnerEnergy';
import type {Address} from 'viem';
import {fetchProtocolApy, EMPTY_APY, type ProtocolApy} from '@/vault/apy';
import {stakeRoutes as buildStakeRoutes, lendRoutes as buildLendRoutes, type EarnRoute} from '@/vault/earn-routes';
import {fmtNum, displaySymbol} from '@/core/format';
import type {Position} from '@/vault/positions';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';

const fmt = (v: number | string): string => fmtNum(Number(v));

// A deposit/withdraw route — see {EarnRoute}, which this page and the deposit form share.
type Route = EarnRoute;
type Row = {route: Route; pos: Position | null};

/** A catalog row: asset + protocol, its position amount, and inline Deposit/Withdraw. */
function EarnRow({
  row,
  free,
  amountKnown,
  earned,
  dust,
  queue,
  apy,
  energyRate,
  protocolName,
  first,
  last,
  onOpen,
}: {
  row: Row;
  first: boolean;
  last: boolean;
  /** The vault's free balance of the asset; null while it loads. */
  free: string | null;
  /** Whether the position read has landed; its amount shows as a dash until it has. */
  amountKnown: boolean;
  earned: string | null;
  /** Worth under a cent: the residue a withdrawal leaves, shown as "< 0.01" rather than its digits. */
  dust: boolean;
  /**
   * Lido's withdrawal queue for this row, in ETH: what is still unstaking and what is ready to
   * claim. Neither is in the position any more, nor in the balance until claimed, so without it a
   * withdrawal made the row's money vanish for days. Null for every other route.
   */
  queue: {unstaking: string; claimable: string} | null;
  apy: number | null;
  /** TRON Stake pays energy, not yield: today's energy a day per staked TRX, shown where the APY is. */
  energyRate?: number | null;
  /** Shown as a small logo after the APY when the section mixes protocols (Sky / Lido). */
  protocolName?: string;
  /** Opens this position's own page, where the actions and the explanations live. */
  onOpen: () => void;
}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {asset} = row.route;
  const amount = row.pos?.formatted ?? '0';
  return (
    <View style={[styles.trWrap, first && styles.trFirst, last && styles.trLast]}>
      {/* The whole row opens the position's own page. It used to expand in place into a strip
          holding a toggle and two buttons, which left no room to say what Auto-Yield does or
          what the rate has been doing — and no room at all once the words were not English. */}
      <Pressable style={styles.trTop} onPress={onOpen}>
        <View style={styles.assetCell}>
          <TokenIcon symbol={asset.symbol} size={30} />
          <View style={styles.assetText}>
            <View style={styles.symLine}>
              <Text style={styles.sym}>{displaySymbol(asset.symbol)}</Text>
              {apy != null ? (
                <View style={styles.apyPill}>
                  <Text style={styles.apyText}>{t('mobile.earn.apy_rate', {rate: apy.toFixed(2)})}</Text>
                </View>
              ) : null}
              {energyRate != null && energyRate > 0 ? (
                <View style={styles.apyPill}>
                  <Text style={styles.apyText}>{t('mobile.earn.energy_rate', {rate: energyRate.toFixed(1)})}</Text>
                </View>
              ) : null}
              {protocolName ? <ProtocolChip name={protocolName} size={14} /> : null}
            </View>
            <Text style={styles.rowSub}>{free != null ? <Amount v={fmt(free)} size={13} color={c.subtext} /> : '—'}</Text>
          </View>
        </View>
        <View style={styles.amtCol}>
          <Text style={styles.amt}>{!amountKnown ? '—' : dust ? '< 0.01' : <Amount v={fmt(amount)} size={15} />}</Text>
          {earned && Number(earned) > 0 ? <Text style={styles.earned}>+ <Amount v={fmt(earned)} size={12} color={c.success} /></Text> : null}
          {queue && Number(queue.unstaking) > 0 ? (
            <Text style={styles.queued}>
              {t('vault.unstaking')} <Amount v={fmt(queue.unstaking)} size={12} color={c.subtext} />
            </Text>
          ) : null}
          {queue && Number(queue.claimable) > 0 ? (
            <Text style={[styles.queued, {color: c.success}]}>
              {t('vault.claimable')} <Amount v={fmt(queue.claimable)} size={12} color={c.success} />
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

/** The card the rows sit in, the same one as the Overview asset list. No column header: the section
 *  title already says what the amount is, and the first row draws no line above itself. */
/** A section card with its title inside as the header row (the Overview's Assets card pattern). */
function EarnTable({
  title,
  afterTitle,
  right,
  children,
}: {
  title?: string;
  /** Sits right after the title text. */
  afterTitle?: React.ReactNode;
  /** Pushed to the card's right edge (the protocol logo). */
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.tableCard}>
      {title ? (
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{title}</Text>
          {afterTitle ?? null}
          <View style={styles.secSpacer} />
          {right ?? null}
        </View>
      ) : null}
      <View style={styles.list}>{children}</View>
    </View>
  );
}

export function EarnScreen() {
  const tabBarHeight = useBottomTabBarHeight();
  // Off, the rows say what the money is doing — yielding, lending — and not who with.
  const headerHeight = useTransparentHeaderInset();
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const assets = useAssetCatalog(network);
  const bal = useVaultBalances(network);
  const pos = useVaultPositions(bal.vault, network);
  // The staking queue (Lido's, or TRON Stake's unstake), read from the chain as the Overview and the
  // detail page do. Re-read whenever the positions do, so an unstake or a claim shows here without a
  // second pull.
  const lidoAdapter = queuedStakeAdapter(network)?.protocol ?? null;
  const [lidoQueue, setLidoQueue] = useState<{key: string; v: LidoUnstake} | null>(null);
  const queueKey = bal.vault && lidoAdapter ? `${network}:${bal.vault.toLowerCase()}` : '';
  useEffect(() => {
    if (!bal.vault || !lidoAdapter) return;
    let live = true;
    const key = `${network}:${bal.vault.toLowerCase()}`;
    getLidoUnstake(bal.vault as Address, lidoAdapter, network)
      .then((v) => live && setLidoQueue({key, v}))
      .catch(() => live && setLidoQueue((q) => (q?.key === key ? q : {key, v: NO_UNSTAKE})));
    return () => {
      live = false;
    };
  }, [bal.vault, network, lidoAdapter, pos.positions]);
  const queueFor = (route: Route): {unstaking: string; claimable: string} | null => {
    if (!lidoAdapter || route.protocol.toLowerCase() !== lidoAdapter.toLowerCase()) return null;
    if (!lidoQueue || lidoQueue.key !== queueKey) return null;
    const units = queueUnits(network);
    return {unstaking: formatUnits(lidoQueue.v.unstaking, units), claimable: formatUnits(lidoQueue.v.claimable, units)};
  };
  // TRON Stake's rate: energy, read with the positions so a pull refreshes it too.
  const energy = useOwnerEnergy(network, pos.positions);
  const flows = useFlows(bal.vault, network);
  const prices = usePrices(network, 0, useMemo(() => assets.map((a) => a.symbol), [assets]));
  // Auto-Yield routes: lowercased asset address → configured protocol (zero = off).
  const [apy, setApy] = useState<ProtocolApy>(EMPTY_APY);

  // Route catalog: which adapters accept which assets — see {earn-routes}, which the deposit form
  // reads too. Rows render from these so the whole menu shows by default.
  const stakeRoutes = useMemo<Route[]>(() => buildStakeRoutes(network, assets), [network, assets]);
  const lendRoutes = useMemo<Route[]>(() => buildLendRoutes(network, assets), [network, assets]);

  // The protocols behind each section, shown at the right of its header.
  const lendNames = useMemo(() => Array.from(new Set(lendRoutes.map((r) => r.name))), [lendRoutes]);

  const apyFor = (r: Route): number | null =>
    apy.protocolApy.get(r.protocol.toLowerCase()) ?? apy.assetApy.get(r.asset.address.toLowerCase()) ?? null;

  // A market paying nothing is not worth a row, unless the vault already holds a position there (it
  // still needs the Withdraw button). An APY that has not loaded yet is unknown, not zero, so it stays.
  // "Nothing" includes dust: Aave's cbBTC on Base pays under 0.01%, which is 0 to a depositor.
  const MIN_APY = 0.05;
  const rowsFor = (routes: Route[]): Row[] =>
    routes
      .map((route) => ({
        route,
        pos:
          pos.positions.find(
            (p) => p.protocol.toLowerCase() === route.protocol.toLowerCase() && p.asset.toLowerCase() === route.asset.address.toLowerCase(),
          ) ?? null,
      }))
      .filter((row) => {
        const a = apyFor(row.route);
        const q = queueFor(row.route);
        const queued = !!q && (Number(q.unstaking) > 0 || Number(q.claimable) > 0);
        return a === null || a >= MIN_APY || Number(row.pos?.formatted ?? '0') > 0 || queued;
      })
      /**
       * Stablecoins lead every section, as they do on the Overview.
       *
       * The order was whatever the route catalog happened to build: Lido's WETH before Sky's USDC
       * under Flexible Yield, and the asset list's own order under Flexible Lend, which puts WETH
       * and WBTC above both dollars. Earning on a dollar is the thing almost everyone is here for,
       * and it was the row furthest down. `sort` is stable, so within each group the catalog order
       * is untouched.
       */
      .sort((x, y) => Number(y.route.asset.kind === 'stable') - Number(x.route.asset.kind === 'stable'));

  /**
   * Earned, on a position still worth more than a dollar.
   *
   * A withdrawal never quite empties a position — interest accrues between the read and the call —
   * so a route the owner has left still holds dust, and the lifetime earned beside a balance of
   * nothing reads as money still at work. The lifetime total lives on the detail page instead.
   * Unpriced is unknown, and shows nothing until the price arrives (a dollar is a dollar).
   */
  const MIN_EARNED_ROW_USD = 1;
  const valueOf = (row: Row): number | null => {
    const amount = Number(row.pos?.formatted ?? 0);
    return row.route.asset.kind === 'stable' ? amount : usdValue(amount, row.route.asset.symbol, prices);
  };
  /** Under a cent, and under 0.01 of the token too, so "< 0.01" is true of the amount it replaces. */
  const isDust = (row: Row): boolean => {
    const v = valueOf(row);
    const amount = Number(row.pos?.formatted ?? 0);
    return v != null && v > 0 && v < 0.01 && amount < 0.01;
  };
  const earnedFor = (row: Row): string | null => {
    const p = row.pos;
    if (!p || !flows.flows) return null;
    const value = valueOf(row);
    if (value == null || value <= MIN_EARNED_ROW_USD) return null;
    const raw = earnedRaw(p, flows.flows);
    return raw != null ? formatUnits(raw, p.decimals) : null;
  };
  // Null while the balances are still loading — the row shows a dash rather than 0.
  const freeFor = (symbol: string): string | null => (bal.balances ? balanceOfSymbol(bal.balances, symbol) : null);







  // Live APY: Aave per lend asset, Sky/Lido per staking adapter. Re-read on network/route change,
  // and on a pull — `apyTick` is what a pull bumps, since the rates move on their own.
  const [apyTick, setApyTick] = useState(0);
  const [apyLoading, setApyLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setApyLoading(true);
    fetchProtocolApy({
      network,
      aaveAssets: lendRoutes.map((r) => r.asset.address),
      skyProtocols: [...new Set(stakeRoutes.filter((r) => r.name === 'Sky').map((r) => r.protocol))],
      lidoProtocols: [...new Set(stakeRoutes.filter((r) => r.name === 'Lido').map((r) => r.protocol))],
    })
      .then((a) => live && setApy(a))
      .catch(() => {})
      .finally(() => live && setApyLoading(false));
    return () => {
      live = false;
    };
  }, [network, stakeRoutes, lendRoutes, apyTick]);

  // APY for a row: Sky/Lido set a single per-adapter rate; Aave a per-asset rate. Check the per-adapter
  // one FIRST — an asset like USDC is both a Sky and an Aave market, so a Sky row must not grab Aave's rate.
  // Owner: route this asset's idle balance into `r.protocol` (on), or clear it (off). One route per asset,
  // so turning one on turns any other off — the contract stores a single route per asset.

  // The pull spinner belongs to a pull only, never to the first load.
  const anyLoading = pos.loading || apyLoading;
  const [pulled, setPulled] = useState(false);
  const refreshing = pulled && anyLoading;
  const onRefresh = useCallback(() => {
    /**
     * Nothing to refresh means nothing to spin for.
     *
     * `refreshing` is `pulled && anyLoading`, and the flag is cleared by an effect watching
     * `anyLoading` fall. With no vault yet the hooks below start no load at all, so `anyLoading`
     * never moves, the effect never runs, and `pulled` stays armed — after which the NEXT load,
     * whenever it came, wore a pull spinner the user never asked for and kept it until it finished.
     *
     * The rates are the exception: they belong to the markets, not to a vault, so a pull re-reads
     * them with or without one.
     */
    setApyTick((n) => n + 1);
    setPulled(true);
    if (!bal.vault) return;
    pos.refresh();
    flows.refresh();
  }, [pos, flows, bal.vault]);
  useEffect(() => {
    if (!anyLoading) setPulled(false);
  }, [anyLoading]);

  const renderRows = (routes: Route[], empty: string, showProtocol = false, lend = false) => {
    const rows = rowsFor(routes);
    if (rows.length === 0) return <Text style={styles.empty}>{empty}</Text>;
    return rows.map((row, i) => {
      const key = `${row.route.protocol}-${row.route.asset.address}`;
      return (
      <EarnRow
        key={key}
        first={i === 0}
        last={i === rows.length - 1}
        row={row}
        free={freeFor(row.route.asset.symbol)}
        amountKnown={!pos.loading || pos.positions.length > 0}
        earned={earnedFor(row)}
        dust={isDust(row)}
        queue={queueFor(row.route)}
        apy={apyFor(row.route)}
        energyRate={row.route.name === TRON_STAKE ? energy?.perTrxPerDay ?? null : undefined}
        protocolName={showProtocol ? row.route.name : undefined}
        onOpen={() =>
          nav.navigate('EarnDetail', {
            protocol: row.route.protocol,
            asset: row.route.asset.address,
            symbol: row.route.asset.symbol,
            name: row.route.name,
            lend,
          })
        }
      />
      );
    });
  };

  return (
    <>
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical
      style={styles.container}
      // The bar is translucent and the list runs under it, so the bottom padding has to be the
      // bar's real height or the last row can never be scrolled clear of it.
      contentContainerStyle={[styles.content, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
      contentInset={{top: headerHeight}}
      contentOffset={{x: 0, y: -headerHeight}}
      scrollIndicatorInsets={{top: headerHeight}}
      automaticallyAdjustContentInsets={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text} colors={[c.accent]} />}>
      {/* Flexible Yield: Sky and Lido share it, so each row carries its protocol after the APY. */}
      <View style={styles.section}>
        <EarnTable title={t('vault.flexible_yield')}>
          {renderRows(stakeRoutes, t('mobile.earn.no_yield_markets'), true)}
        </EarnTable>
      </View>

      {/* Flexible Lend: one protocol, named in the header. */}
      <View style={styles.section}>
        <EarnTable title={t('vault.flexible_lend')} right={lendNames[0] ? <ProtocolChip name={lendNames[0]} size={16} /> : undefined}>
          {renderRows(lendRoutes, t('mobile.earn.no_lend_markets'), false, true)}
        </EarnTable>
      </View>

    </ScrollView>


    </>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  // paddingBottom is set inline from the tab bar's height; see the ScrollView.
  content: {flexGrow: 1, padding: 16, gap: 20},
  section: {gap: 0},
  empty: {color: c.subtext, fontSize: 13, paddingTop: 12, paddingBottom: 4},
  // solid card matching the Overview/Trade surfaces (c.card), header row + hairline-separated rows.
  // Same card as the Overview asset list: the card carries the padding, the header sits inside it,
  // and every row draws a hairline on its top edge (one under the header, one between rows, none
  // trailing the last).
  /**
   * 20 at the top, 16 everywhere else.
   *
   * Both tabs open with 8pt of page padding under the header, so the first line of text sits at
   * 8 + the card's own top padding. The Overview's hero pads 20 and this card padded 16, which
   * put "Flexible Yield" four points higher than "Total value" on the tab next to it — not
   * enough to look deliberate, just enough to look wrong. The sides stay at 16, which is what
   * every other card in the app uses; only the hero is inset further.
   */
  tableCard: {backgroundColor: c.card, borderRadius: 20, padding: 16, paddingTop: 20, gap: 6},
  cardHeader: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
  cardTitle: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  list: {gap: 0},
  trWrap: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingVertical: 12, gap: 10},
  // The card's own padding frames the list, so the first row adds no top padding and the last no
  // bottom padding: the space above the first row equals the space below the last.
  trFirst: {borderTopWidth: 0},
  trLast: {paddingBottom: 0},
  trTop: {flexDirection: 'row', alignItems: 'center'},
  assetCell: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1},
  assetText: {gap: 2},
  symLine: {flexDirection: 'row', alignItems: 'center', gap: 8},
  apyPill: {backgroundColor: c.successSoft, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2},
  apyText: {color: c.success, fontSize: 12, fontWeight: '700'},
  sym: {color: c.text, fontSize: 15, fontWeight: '600'},
  rowSub: {color: c.subtext, fontSize: 13, marginTop: 2},
  amtCol: {alignItems: 'flex-end', minWidth: 64},
  queued: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 1},
  amt: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
  earned: {color: c.success, fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 1},
  secSpacer: {flex: 1},
});

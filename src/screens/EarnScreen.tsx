import {useHeaderHeight} from '@react-navigation/elements';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {ProtocolChip} from '@/components/ProtocolIcon';
import {useDefiDetails} from '@/core/defi-details';
import {useNetwork} from '@/core/network-store';
import {formatUnits, type Address} from 'viem';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {useVaultLp} from '@/vault/useVaultLp';
import {useFlows} from '@/vault/useFlows';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {earnedRaw} from '@/vault/flows';
import {balanceOfSymbol} from '@/vault/read';
import {fetchProtocolApy, EMPTY_APY, type ProtocolApy} from '@/vault/apy';
import {ASSETS, type Asset} from '@/core/assets';
import {fmtNum, displaySymbol} from '@/core/format';
import {adapterByName} from '@/core/protocols';
import type {Position} from '@/vault/positions';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

const fmt = (v: number | string): string => fmtNum(Number(v));

// A deposit/withdraw route: a yield/lend adapter paired with an asset it accepts. The rows below are
// synthesized from these so every supported asset shows by default — the first deposit opts the vault in.
// `kind` picks the ledger the flow is written to: staking routes go to stake-flows, lending
// routes to supply-flows, and the two endpoints name their directions differently.
type Route = {protocol: Address; name: string; asset: Asset; kind: 'staking' | 'lending'};
type Row = {route: Route; pos: Position | null};

/** A catalog row: asset + protocol, its position amount, and inline Deposit/Withdraw. */
function EarnRow({
  row,
  free,
  amountKnown,
  earned,
  apy,
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
  apy: number | null;
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
              {protocolName ? <ProtocolChip name={protocolName} size={14} /> : null}
            </View>
            <Text style={styles.rowSub}>{free != null ? <Amount v={fmt(free)} size={13} color={c.subtext} /> : '—'}</Text>
          </View>
        </View>
        <View style={styles.amtCol}>
          <Text style={styles.amt}>{amountKnown ? <Amount v={fmt(amount)} size={15} /> : '—'}</Text>
          {earned && Number(earned) > 0 ? <Text style={styles.earned}>+ <Amount v={fmt(earned)} size={12} color={c.success} /></Text> : null}
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
  /** Sits right after the title text (the Market Maker "+"). */
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
  const defiDetails = useDefiDetails((s) => s.show);
  const headerHeight = useHeaderHeight();
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const assets = ASSETS[network];
  const bal = useVaultBalances(network);
  const pos = useVaultPositions(bal.vault, network);
  const lp = useVaultLp(bal.vault, network);
  const flows = useFlows(bal.vault, network);
  // Auto-Yield routes: lowercased asset address → configured protocol (zero = off).
  const [apy, setApy] = useState<ProtocolApy>(EMPTY_APY);

  // Route catalog: which adapters accept which assets. Lido stakes ETH (WETH); Sky is USDC savings;
  // Aave supplies the blue-chip reserves. Rows render from these so the whole menu shows by default.
  const stakeRoutes = useMemo<Route[]>(() => {
    const out: Route[] = [];
    const lido = adapterByName(network, 'Lido');
    if (lido) assets.filter((a) => a.symbol === 'WETH').forEach((asset) => out.push({protocol: lido, name: 'Lido', asset, kind: 'staking'}));
    const sky = adapterByName(network, 'Sky');
    // The Sky adapter takes USDC only (it swaps through the PSM into sUSDS); every other
    // stablecoin reverts with InvalidAsset, so it gets no row.
    if (sky) assets.filter((a) => a.symbol === 'USDC').forEach((asset) => out.push({protocol: sky, name: 'Sky', asset, kind: 'staking'}));
    return out;
  }, [network, assets]);

  const lendRoutes = useMemo<Route[]>(() => {
    const aave = adapterByName(network, 'Aave V3');
    if (!aave) return [];
    const supported = ['WETH', 'WBTC', 'cbBTC', 'USDC', 'USDT'];
    return assets.filter((a) => supported.includes(a.symbol)).map((asset) => ({protocol: aave, name: 'Aave V3', asset, kind: 'lending' as const}));
  }, [network, assets]);

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
        return a === null || a >= MIN_APY || Number(row.pos?.formatted ?? '0') > 0;
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

  const earnedFor = (p: Position | null): string | null => {
    if (!p || !flows.flows) return null;
    const raw = earnedRaw(p, flows.flows);
    return raw != null ? formatUnits(raw, p.decimals) : null;
  };
  // Null while the balances are still loading — the row shows a dash rather than 0.
  const freeFor = (symbol: string): string | null => (bal.balances ? balanceOfSymbol(bal.balances, symbol) : null);







  // Live APY: Aave per lend asset, Sky/Lido per staking adapter. Re-read on network/route change.
  useEffect(() => {
    let live = true;
    fetchProtocolApy({
      network,
      aaveAssets: lendRoutes.map((r) => r.asset.address),
      skyProtocols: [...new Set(stakeRoutes.filter((r) => r.name === 'Sky').map((r) => r.protocol))],
      lidoProtocols: [...new Set(stakeRoutes.filter((r) => r.name === 'Lido').map((r) => r.protocol))],
    })
      .then((a) => live && setApy(a))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [network, stakeRoutes, lendRoutes]);

  // APY for a row: Sky/Lido set a single per-adapter rate; Aave a per-asset rate. Check the per-adapter
  // one FIRST — an asset like USDC is both a Sky and an Aave market, so a Sky row must not grab Aave's rate.
  // Owner: route this asset's idle balance into `r.protocol` (on), or clear it (off). One route per asset,
  // so turning one on turns any other off — the contract stores a single route per asset.

  // The pull spinner belongs to a pull only, never to the first load.
  const anyLoading = pos.loading || lp.loading;
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
     */
    if (!bal.vault) return;
    setPulled(true);
    pos.refresh();
    lp.refresh();
  }, [pos, lp, bal.vault]);
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
        earned={earnedFor(row.pos)}
        apy={apyFor(row.route)}
        protocolName={showProtocol && defiDetails ? row.route.name : undefined}
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
        <EarnTable title={t('vault.flexible_lend')} right={defiDetails && lendNames[0] ? <ProtocolChip name={lendNames[0]} size={16} /> : undefined}>
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
  tableCard: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 6},
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
  amt: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
  earned: {color: c.success, fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 1},
  secSpacer: {flex: 1},
});

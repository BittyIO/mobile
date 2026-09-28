import {useHeaderHeight} from '@react-navigation/elements';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Animated, InputAccessoryView, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {Pill} from '@/components/ui';
import {AmountInput, exceedsMax} from '@/components/AmountInput';
import {TokenIcon} from '@/components/TokenIcon';
import {PendingSwitch} from '@/components/PendingSwitch';
import {Amount} from '@/components/Amount';
import {ConfirmButton} from '@/components/Button';
import {showTx, ToastHost} from '@/components/Toast';
import {useSlideUp} from '@/components/useSlideUp';
import {ProtocolChip} from '@/components/ProtocolIcon';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {formatUnits, type Address} from 'viem';
import type {Signer} from '@/wallet/signer';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {useVaultLp} from '@/vault/useVaultLp';
import {useFlows} from '@/vault/useFlows';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {earnedRaw} from '@/vault/flows';
import {removeLp, claimLpFees} from '@/vault/lp-actions';
import {depositToProtocol, withdrawFromProtocol} from '@/vault/actions';
import {balanceOfSymbol} from '@/vault/read';
import {publicClientFor} from '@/core/chain';
import {getAutoYields, setAutoYield} from '@/vault/autoyield';
import {fetchProtocolApy, EMPTY_APY, type ProtocolApy} from '@/vault/apy';
import {zeroAddress} from 'viem';
import {ASSETS, type Asset} from '@/core/assets';
import {fmtNum, displaySymbol} from '@/core/format';
import {adapterByName} from '@/core/protocols';
import type {Position} from '@/vault/positions';
import type {LpPosition} from '@/vault/lp';
import Svg, {Path} from 'react-native-svg';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

const fmt = (v: number | string): string => fmtNum(Number(v));
const KB_ID = 'earn-amount-kb'; // links the amount field to its keyboard Done bar

// A deposit/withdraw route: a yield/lend adapter paired with an asset it accepts. The rows below are
// synthesized from these so every supported asset shows by default — the first deposit opts the vault in.
type Route = {protocol: Address; name: string; asset: Asset};
type Row = {route: Route; pos: Position | null};

/** A catalog row: asset + protocol, its position amount, and inline Deposit/Withdraw. */
function EarnRow({
  row,
  free,
  earned,
  apy,
  protocolName,
  autoLabel,
  depositLabel,
  autoOn,
  autoBusy,
  expanded,
  first,
  last,
  onToggle,
  onToggleAuto,
  onDeposit,
  onWithdraw,
}: {
  row: Row;
  first: boolean;
  last: boolean;
  free: string;
  earned: string | null;
  apy: number | null;
  /** Shown as a small logo after the APY when the section mixes protocols (Sky / Lido). */
  protocolName?: string;
  /** "Auto-Yield" on a yield row, "Auto-Supply" on a lending one. */
  autoLabel: string;
  depositLabel: string;
  autoOn: boolean;
  autoBusy: boolean;
  // The actions (Auto-Yield switch, Deposit / Withdraw) stay folded under the row until it is
  // tapped, so the table reads as a list first and a control panel only for the row in hand.
  expanded: boolean;
  onToggle: () => void;
  onToggleAuto: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {asset} = row.route;
  const amount = row.pos?.formatted ?? '0';
  const hasPos = Number(amount) > 0;
  return (
    <View style={[styles.trWrap, first && styles.trFirst, last && styles.trLast]}>
      <Pressable style={styles.trTop} onPress={onToggle}>
        <View style={styles.assetCell}>
          <TokenIcon symbol={asset.symbol} />
          <View style={styles.assetText}>
            <View style={styles.symLine}>
              <Text style={styles.sym}>{displaySymbol(asset.symbol)}</Text>
              {apy != null ? (
                <View style={styles.apyPill}>
                  <Text style={styles.apyText}>{apy.toFixed(2)}% APY</Text>
                </View>
              ) : null}
              {protocolName ? <ProtocolChip name={protocolName} size={14} /> : null}
            </View>
            <Text style={styles.rowSub}><Amount v={fmt(free)} size={13} color={c.subtext} /></Text>
          </View>
        </View>
        <View style={styles.amtCol}>
          <Text style={styles.amt}><Amount v={fmt(amount)} size={15} /></Text>
          {earned && Number(earned) > 0 ? <Text style={styles.earned}>+ <Amount v={fmt(earned)} size={12} color={c.success} /></Text> : null}
        </View>
      </Pressable>
      {/* Auto-Yield toggle inline with the action buttons — one row, left → right. Tapping the empty
          space of this area folds the row back up, as tapping the row itself does; the switch and the
          buttons keep their own taps. */}
      {expanded ? (
      <Pressable style={styles.actions} onPress={onToggle}>
        <View style={styles.autoInline}>
          <Text style={styles.autoToggleLabel}>{autoLabel}</Text>
          <PendingSwitch
            value={autoOn}
            pending={autoBusy}
            onValueChange={onToggleAuto}
          />
        </View>
        <View style={styles.btnGroup}>
          <Pressable style={styles.depBtn} onPress={onDeposit}>
            <Text style={styles.priText}>{depositLabel}</Text>
          </Pressable>
          {hasPos ? (
            <Pressable style={styles.wdBtn} onPress={onWithdraw}>
              <Text style={styles.secText}>{t('vault.withdraw')}</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
      ) : null}
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
  const headerHeight = useHeaderHeight();
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  // Rows with their actions open. Each row toggles on its own; opening one leaves the others as they are.
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const assets = ASSETS[network];
  const account = useWallet((s) => s.account);
  const getSigner = useWallet((s) => s.signer);
  const bal = useVaultBalances(network);
  const pos = useVaultPositions(bal.vault, network);
  const lp = useVaultLp(bal.vault, network);
  const flows = useFlows(bal.vault, network);
  const [lpBusy, setLpBusy] = useState<string | null>(null);
  // Auto-Yield routes: lowercased asset address → configured protocol (zero = off).
  const [autoMap, setAutoMap] = useState<Map<string, string>>(new Map());
  const [autoBusy, setAutoBusy] = useState<string | null>(null);
  const [autoNonce, setAutoNonce] = useState(0);
  const [apy, setApy] = useState<ProtocolApy>(EMPTY_APY);

  // Route catalog: which adapters accept which assets. Lido stakes ETH (WETH); Sky is USDC savings;
  // Aave supplies the blue-chip reserves. Rows render from these so the whole menu shows by default.
  const stakeRoutes = useMemo<Route[]>(() => {
    const out: Route[] = [];
    const lido = adapterByName(network, 'Lido');
    if (lido) assets.filter((a) => a.symbol === 'WETH').forEach((asset) => out.push({protocol: lido, name: 'Lido', asset}));
    const sky = adapterByName(network, 'Sky');
    // The Sky adapter takes USDC only (it swaps through the PSM into sUSDS); every other
    // stablecoin reverts with InvalidAsset, so it gets no row.
    if (sky) assets.filter((a) => a.symbol === 'USDC').forEach((asset) => out.push({protocol: sky, name: 'Sky', asset}));
    return out;
  }, [network, assets]);

  const lendRoutes = useMemo<Route[]>(() => {
    const aave = adapterByName(network, 'Aave V3');
    if (!aave) return [];
    const supported = ['WETH', 'WBTC', 'cbBTC', 'USDC', 'USDT'];
    return assets.filter((a) => supported.includes(a.symbol)).map((asset) => ({protocol: aave, name: 'Aave V3', asset}));
  }, [network, assets]);

  // The protocols behind each section, shown at the right of its header.
  const lendNames = useMemo(() => Array.from(new Set(lendRoutes.map((r) => r.name))), [lendRoutes]);
  const ammNames = useMemo(() => (adapterByName(network, 'Uniswap V3') ? ['Uniswap V3'] : []), [network]);

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
      });

  const earnedFor = (p: Position | null): string | null => {
    if (!p || !flows.flows) return null;
    const raw = earnedRaw(p, flows.flows);
    return raw != null ? formatUnits(raw, p.decimals) : null;
  };
  const freeFor = (symbol: string): string => (bal.balances ? balanceOfSymbol(bal.balances, symbol) : '0');

  // Deposit / Withdraw happen in a compact bottom sheet (below), not a full-screen page.
  const [act, setAct] = useState<{mode: 'deposit' | 'withdraw'; route: Route; max: string; verb: string} | null>(null);
  const [actAmount, setActAmount] = useState('');
  const [actBusy, setActBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);

  const openDeposit = (r: Route, verb: string) => {
    setAct({mode: 'deposit', route: r, max: freeFor(r.asset.symbol), verb});
    setActAmount('');
    setActErr(null);
  };
  const openWithdraw = (r: Route, p: Position) => {
    setAct({mode: 'withdraw', route: r, max: p.formatted, verb: t('vault.withdraw')});
    setActAmount('');
    setActErr(null);
  };

  // Fee stablecoin: prefer one the vault holds that isn't the asset being deposited.
  const pickFeeCoin = (excludeAddr?: string): Address => {
    const held = assets.filter((a) => a.kind === 'stable' && Number(balanceOfSymbol(bal.balances, a.symbol)) > 0);
    const ex = excludeAddr?.toLowerCase();
    return ((held.find((s) => s.address.toLowerCase() !== ex) ?? held[0] ?? stable)?.address ?? '') as Address;
  };

  const onActionSubmit = async () => {
    if (!act || !account || !bal.vault) return;
    if (!(Number(actAmount) > 0)) {
      setActErr(t('vault.enter_amount'));
      return;
    }
    if (exceedsMax(actAmount, act.max)) {
      setActErr(t('vault.insufficient_balance', {token: displaySymbol(act.route.asset.symbol)}));
      return;
    }
    setActBusy(true);
    setActErr(null);
    const tx = showTx(`${act.verb} ${fmt(actAmount)} ${displaySymbol(act.route.asset.symbol)}`, network);
    try {
      const acct = await getSigner();
      const run = act.mode === 'deposit' ? depositToProtocol : withdrawFromProtocol;
      const hash = await run({
        account: acct,
        vault: bal.vault,
        network,
        protocol: act.route.protocol,
        asset: act.route.asset.address,
        amount: actAmount,
        decimals: act.route.asset.decimals,
        stableCoin: pickFeeCoin(act.route.asset.address),
      });
      tx.success(hash);
      setAct(null);
      pos.refresh();
      bal.refresh();
      // The relay returns on submit, not on mine — so the immediate read is still pre-tx. Refresh again
      // once it's mined so the deposited balance actually updates.
      publicClientFor(network)
        .waitForTransactionReceipt({hash: hash as `0x${string}`})
        .then(() => {
          pos.refresh();
          bal.refresh();
        })
        .catch(() => {});
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      tx.error(msg);
      setActErr(msg);
    } finally {
      setActBusy(false);
    }
  };

  const runLp = async (tokenId: string, title: string, build: (a: Signer) => Promise<string>) => {
    if (!account || !bal.vault) return;
    setLpBusy(tokenId);
    const tx = showTx(title, network);
    try {
      const acct = await getSigner();
      tx.success(await build(acct));
      lp.refresh();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setLpBusy(null);
    }
  };

  const stable = assets.find((a) => a.kind === 'stable');
  const pairLabel = (p: LpPosition) => `${displaySymbol(p.symbol0)}/${displaySymbol(p.symbol1)}`;
  const onRemoveLp = (p: LpPosition) =>
    stable &&
    runLp(p.tokenId, `${t('vault.remove_liquidity')} ${pairLabel(p)}`, (a) =>
      removeLp({account: a, vault: bal.vault!, network, tokenId: p.tokenId, liquidity: p.liquidity, stableCoin: stable.address}),
    );
  const onClaimLp = (p: LpPosition) =>
    stable &&
    runLp(p.tokenId, `${t('vault.claim_fees')} ${pairLabel(p)}`, (a) =>
      claimLpFees({account: a, vault: bal.vault!, network, tokenId: p.tokenId, stableCoin: stable.address}),
    );

  // Load each asset's configured auto-yield route; re-read after a toggle.
  useEffect(() => {
    if (!bal.vault) return;
    const addrs = [...new Set([...stakeRoutes, ...lendRoutes].map((r) => r.asset.address))] as Address[];
    if (addrs.length === 0) return;
    let live = true;
    getAutoYields(bal.vault, network, addrs)
      .then((m) => live && setAutoMap(new Map(m)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bal.vault, network, stakeRoutes, lendRoutes, autoNonce]);

  const isAutoOn = (r: Route): boolean =>
    (autoMap.get(r.asset.address.toLowerCase()) ?? '').toLowerCase() === r.protocol.toLowerCase();

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
  const toggleAuto = async (r: Route) => {
    if (!account || !bal.vault || !stable) return;
    const addr = r.asset.address.toLowerCase();
    const on = isAutoOn(r);
    setAutoBusy(addr);
    const tx = showTx(
      t(on ? 'mobile.actions.auto_yield_off' : 'mobile.actions.auto_yield_set', {token: displaySymbol(r.asset.symbol)}),
      network,
    );
    try {
      const acct = await getSigner();
      const hash = await setAutoYield({account: acct, vault: bal.vault, network, asset: r.asset.address, protocol: on ? zeroAddress : r.protocol, stableCoin: stable.address});
      tx.success(hash);
      setAutoMap((prev) => new Map(prev).set(addr, on ? zeroAddress : r.protocol));
      setAutoNonce((n) => n + 1);
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setAutoBusy(null);
    }
  };

  // The pull spinner belongs to a pull only, never to the first load.
  const anyLoading = pos.loading || lp.loading;
  const [pulled, setPulled] = useState(false);
  const refreshing = pulled && anyLoading;
  const actSlide = useSlideUp(act != null);
  const onRefresh = useCallback(() => {
    setPulled(true);
    pos.refresh();
    lp.refresh();
  }, [pos, lp]);
  useEffect(() => {
    if (!anyLoading) setPulled(false);
  }, [anyLoading]);

  const renderRows = (routes: Route[], depositLabel: string, empty: string, showProtocol = false, lend = false) => {
    const rows = rowsFor(routes);
    if (rows.length === 0) return <Text style={styles.empty}>{empty}</Text>;
    return rows.map((row, i) => {
      const key = `${row.route.protocol}-${row.route.asset.address}`;
      return (
      <EarnRow
        key={key}
        first={i === 0}
        last={i === rows.length - 1}
        expanded={openRows.has(key)}
        onToggle={() =>
          setOpenRows((cur) => {
            const next = new Set(cur);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
        row={row}
        free={freeFor(row.route.asset.symbol)}
        earned={earnedFor(row.pos)}
        apy={apyFor(row.route)}
        protocolName={showProtocol ? row.route.name : undefined}
        autoLabel={t(lend ? 'mobile.earn.auto_supply' : 'mobile.earn.auto_yield')}
        depositLabel={depositLabel}
        autoOn={isAutoOn(row.route)}
        autoBusy={autoBusy === row.route.asset.address.toLowerCase()}
        onToggleAuto={() => toggleAuto(row.route)}
        onDeposit={() => openDeposit(row.route, depositLabel)}
        onWithdraw={() => row.pos && openWithdraw(row.route, row.pos)}
      />
      );
    });
  };

  return (
    <>
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical
      style={styles.container}
      contentContainerStyle={[styles.content, {paddingTop: 8}]}
      contentInset={{top: headerHeight}}
      contentOffset={{x: 0, y: -headerHeight}}
      scrollIndicatorInsets={{top: headerHeight}}
      automaticallyAdjustContentInsets={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text} colors={[c.accent]} />}>
      {/* Flexible Yield: Sky and Lido share it, so each row carries its protocol after the APY. */}
      <View style={styles.section}>
        <EarnTable title={t('vault.flexible_yield')}>
          {renderRows(stakeRoutes, t('vault.deposit'), t('mobile.earn.no_yield_markets'), true)}
        </EarnTable>
      </View>

      {/* Flexible Lend: one protocol, named in the header. */}
      <View style={styles.section}>
        <EarnTable title={t('vault.flexible_lend')} right={lendNames[0] ? <ProtocolChip name={lendNames[0]} size={16} /> : undefined}>
          {renderRows(lendRoutes, t('vault.supply'), t('mobile.earn.no_lend_markets'), false, true)}
        </EarnTable>
      </View>

      {/* Market Maker: the same card as the two above; "+" adds a position. */}
      <View style={styles.section}>
        <EarnTable
          title={t('vault.market_maker')}
          afterTitle={
            <Pressable onPress={() => nav.navigate('AddLiquidity')} hitSlop={10} accessibilityLabel={t('mobile.earn.add')}>
              <Svg width={18} height={18} viewBox="0 0 24 24">
                <Path d="M12 5v14M5 12h14" stroke={c.accent} strokeWidth={2.2} strokeLinecap="round" />
              </Svg>
            </Pressable>
          }
          right={ammNames[0] ? <ProtocolChip name={ammNames[0]} size={16} /> : undefined}>
          {lp.loading && lp.lp.length === 0 ? (
            <ActivityIndicator color={c.accent} style={styles.pad} />
          ) : lp.lp.length === 0 ? (
            <Text style={styles.empty}>{t('mobile.earn.no_lp')}</Text>
          ) : (
            lp.lp.map((p, i) => {
              const hasFees = p.feesOwed0 > 0 || p.feesOwed1 > 0;
              return (
                <View key={p.tokenId} style={[styles.lpCell, i === 0 && styles.lpFirst, i === lp.lp.length - 1 && styles.lpLast]}>
                  <View style={styles.lpTop}>
                    <View style={styles.pairLine}>
                      <Text style={styles.sym}>
                        {displaySymbol(p.symbol0)}/{displaySymbol(p.symbol1)}
                      </Text>
                      <View style={styles.protoPill}>
                        <Text style={styles.protoPillText}>{(p.fee / 10000).toFixed(2)}%</Text>
                      </View>
                      <Pill label={p.inRange ? t('vault.in_range') : t('vault.out_of_range')} tone={p.inRange ? 'green' : 'amber'} />
                    </View>
                    <Text style={styles.lpAmt}>
                      <Amount v={fmt(p.amount0)} /> {displaySymbol(p.symbol0)} + <Amount v={fmt(p.amount1)} /> {displaySymbol(p.symbol1)}
                    </Text>
                  </View>
                  <Text style={styles.lpFees}>
                    {t('mobile.earn.fees')} <Amount v={fmt(p.feesOwed0)} /> {displaySymbol(p.symbol0)} + <Amount v={fmt(p.feesOwed1)} /> {displaySymbol(p.symbol1)}
                  </Text>
                  <View style={styles.rowBtns}>
                    <Pressable disabled={lpBusy === p.tokenId || !hasFees} onPress={() => onClaimLp(p)} style={[styles.priBtn, (!hasFees || lpBusy === p.tokenId) && styles.dim]}>
                      <Text style={styles.priText}>{lpBusy === p.tokenId ? '…' : t('vault.claim_fees')}</Text>
                    </Pressable>
                    <Pressable disabled={lpBusy === p.tokenId} onPress={() => onRemoveLp(p)} style={[styles.dangerBtn, lpBusy === p.tokenId && styles.dim]}>
                      <Text style={styles.dangerText}>{t('vault.remove')}</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}
        </EarnTable>
      </View>
    </ScrollView>

      {/* Deposit / Withdraw bottom sheet */}
      <Modal transparent visible={act != null} animationType="none" onRequestClose={() => !actBusy && setAct(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => !actBusy && setAct(null)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Animated.View style={actSlide}>
            <Pressable style={styles.sheet} onPress={() => Keyboard.dismiss()}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{act ? `${act.verb} ${displaySymbol(act.route.asset.symbol)}` : ''}</Text>
                <Pressable onPress={() => !actBusy && setAct(null)} hitSlop={10}>
                  <Text style={styles.sheetClose}>✕</Text>
                </Pressable>
              </View>
              <AmountInput
                value={actAmount}
                onChangeText={setActAmount}
                placeholder={t('mobile.earn.amount_in', {symbol: displaySymbol(act?.route.asset.symbol)})}
                max={act?.max}
                maxLabel={act ? t('mobile.earn.available', {amount: fmt(act.max), symbol: displaySymbol(act.route.asset.symbol)}) : undefined}
                inputAccessoryViewID={KB_ID}
              />
              {actErr ? <Text style={styles.actErr}>{actErr}</Text> : null}
              <ConfirmButton onPress={onActionSubmit} loading={actBusy} disabled={!act || !account || !bal.vault || !(Number(actAmount) > 0) || exceedsMax(actAmount, act.max)} />
            </Pressable>
            </Animated.View>
          </KeyboardAvoidingView>
          <ToastHost />
        </Pressable>
        <InputAccessoryView nativeID={KB_ID}>
          <View style={styles.kbBar}>
            <Pressable onPress={() => Keyboard.dismiss()} hitSlop={8}>
              <Text style={styles.kbDone}>{t('vault.done')}</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      </Modal>
    </>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  content: {flexGrow: 1, padding: 16, gap: 20, paddingBottom: 32},
  section: {gap: 0},
  pad: {paddingVertical: 20},
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
  apyText: {color: c.success, fontSize: 10, fontWeight: '700'},
  sym: {color: c.text, fontSize: 15, fontWeight: '600'},
  rowSub: {color: c.subtext, fontSize: 13, marginTop: 2},
  protoPill: {backgroundColor: c.card, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2},
  protoPillText: {color: c.textMuted, fontSize: 10, fontWeight: '600'},
  amtCol: {alignItems: 'flex-end', minWidth: 64},
  amt: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
  amtLabel: {color: c.subtext, fontSize: 10, marginTop: 1},
  earned: {color: c.success, fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 1},
  rowBtns: {flexDirection: 'row', gap: 8},
  priBtn: {flex: 1, backgroundColor: c.accent, borderRadius: 8, paddingVertical: 9, alignItems: 'center'},
  priText: {color: c.onAccent, fontSize: 13, fontWeight: '700'},
  secBtn: {flex: 1, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 9, alignItems: 'center'},
  secText: {color: c.textMuted, fontSize: 13, fontWeight: '700'},
  dangerBtn: {flex: 1, borderWidth: 1, borderColor: c.danger, borderRadius: 8, paddingVertical: 9, alignItems: 'center'},
  dangerText: {color: c.danger, fontSize: 13, fontWeight: '700'},
  dim: {opacity: 0.4},
  lpCell: {paddingVertical: 12, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  lpFirst: {borderTopWidth: 0},
  lpLast: {paddingBottom: 0},
  lpTop: {gap: 6},
  pairLine: {flexDirection: 'row', alignItems: 'center', gap: 8},
  lpAmt: {color: c.text, fontSize: 13, fontVariant: ['tabular-nums']},
  lpFees: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
  secSpacer: {flex: 1},
  // Deposit/Withdraw bottom sheet
  sheetBackdrop: {flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end'},
  sheet: {backgroundColor: c.elevated, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 34, gap: 14},
  sheetHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  sheetTitle: {color: c.text, fontSize: 18, fontWeight: '700'},
  sheetClose: {color: c.subtext, fontSize: 18},
  hint: {color: c.subtext, fontSize: 12, lineHeight: 17},
  actErr: {color: c.danger, fontSize: 13},
  kbBar: {backgroundColor: c.elevated, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'flex-end'},
  kbDone: {color: c.accent, fontSize: 16, fontWeight: '700'},
  actions: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  autoInline: {flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1},
  autoToggleLabel: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  autoSwitch: {transform: [{scaleX: 0.8}, {scaleY: 0.8}]},
  btnGroup: {flexDirection: 'row', gap: 8},
  depBtn: {backgroundColor: c.accent, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16, alignItems: 'center'},
  wdBtn: {backgroundColor: c.buttonSecondary, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, alignItems: 'center'},
});

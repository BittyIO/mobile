import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {formatUnits, parseUnits, type Address, type Hex} from 'viem';
import Svg, {Path} from 'react-native-svg';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {TokenIcon} from '@/components/TokenIcon';
import {SettingsGroup} from '@/components/SettingsRow';
import {Sheet} from '@/components/Sheet';
import {ConfirmButton} from '@/components/Button';
import {ClearBtn} from '@/components/ClearBtn';
import {FundRow} from '@/components/FundRow';
import {AvailableLine} from '@/components/AvailableLine';
import {useConfirmAction} from '@/components/ConfirmAction';
import {showTx} from '@/components/Toast';
import {FIT} from '@/core/text-scale';
import {isTestnet, NATIVE, type Network} from '@/core/chain';
import {networkLabel, useNetwork, useNetworks} from '@/core/network-store';
import {useAssetCatalog} from '@/core/asset-catalog';
import {knownAssets} from '@/core/assets';
import {availableVaultUpgrade, plannedVaultUpgrade} from '@/vault/auto-upgrade';
import {ProtocolChip} from '@/components/ProtocolIcon';
import {useActiveVaultAddress} from '@/core/active-vault';
import {asShown, displaySymbol, fmtNum, shortAddress} from '@/core/format';
import {useWallet} from '@/wallet/store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {usePrices} from '@/vault/usePrices';
import {worthShowing} from '@/core/prices';
import {isQueuedStake} from '@/vault/lido';
import {balanceOfSymbol} from '@/vault/read';
import {relayGasFor} from '@/vault/fee-quote';
import {useFeeFloor} from '@/vault/useFeeFloor';
import {feeCoinForSpend, feeWeth, reserveHeld, resolveFeeReserve, useWethFeeCoin} from '@/vault/stableCoinAsGas';
import {gateReasonKey, useCapability} from '@/vault/gate';
import {versionAtLeast} from '@/vault/capabilities';
import {runningVaultVersion} from '@/vault/vault-abi';
import {CopyButton} from '@/components/CopyButton';
import {
  BRIDGE_FEE_BPS,
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_SINCE,
  BridgeQuoteError,
  acrossServes,
  bridgeFromVault,
  bridgeOriginOwner,
  bridgeRecipient,
  loadBridge,
  quoteBridge,
  readBridgeSettings,
  routeId,
  forgetBridge,
  setBridgeEnabled,
  type BridgeInfo,
  type BridgeQuote,
  type BridgeRoute,
} from '@/vault/bridge';

/** Gas for a bridge, for the fee line: the unwrap or approval, the adapter's clone, the deposit. */
const BRIDGE_GAS = relayGasFor({swap: 1});
/** Floored to six places at most, so a ticked row never names more than its source holds. */
const floor6 = (n: number) => Math.floor(n * 1e6) / 1e6;
const SWITCH_GAS = relayGasFor({});

/**
 * The Bridge tab: move an asset from the vault in front to the owner's own vault on another
 * network (see vault/bridge). From is the network in the header; To, the asset and the amount are
 * chosen here, and Across's quote — what arrives, what it costs, how long — is read before anything
 * is signed.
 *
 * The bridge is off on every vault until the owner turns it on, which waits out the timelock: the
 * page says so and offers the switch instead of the form until it is on.
 */
export function BridgeScreen() {
  const {t} = useT();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const headerHeight = useTransparentHeaderInset();
  // A pushed page now, not a tab: the home indicator is all there is to clear at the bottom.
  const tabBarHeight = useSafeAreaInsets().bottom;
  const {height: screenHeight} = useWindowDimensions();
  const network = useNetwork((s) => s.network);
  const setNetwork = useNetwork((s) => s.setNetwork);
  const listed = useNetworks();
  const vault = useActiveVaultAddress(network);
  const owner = useWallet((s) => s.address);
  const getSigner = useWallet((s) => s.signer);
  const assets = useAssetCatalog(network);
  const bal = useVaultBalances(network);
  const pos = useVaultPositions(vault, network);
  const gate = useCapability('bridge');
  const enableGate = useCapability('enableBridge');
  const {ask, sheet} = useConfirmAction();
  const label = (n: Network) => networkLabel(n, t);

  // What the chain holds: the adapter and its routes, the vault's release, and its switch.
  // 'failed': the chain could not be read; shown as such and asked again on the next visit.
  const [info, setInfo] = useState<BridgeInfo | null | undefined | 'failed'>(undefined);
  /**
   * The network `info` was read for. A network switch (a flip, a From pick) keeps the screen up
   * with the form as it was while the new network's routes load: only the very first read waits
   * behind a spinner.
   */
  const [infoNet, setInfoNet] = useState<Network | null>(null);
  const [reload, setReload] = useState(0);
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const [settings, setSettings] = useState<{enabled: boolean; enableAt: number; read: boolean} | undefined>(undefined);
  const assetKey = assets.map((a) => a.address).join(',');
  useEffect(() => {
    if (!assets.length) return;
    let live = true;
    loadBridge(network, assets)
      .then((i) => {
        if (!live) return;
        setInfo(i);
        setInfoNet(network);
      })
      .catch(() => {
        if (!live) return;
        setInfo('failed');
        setInfoNet(network);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, assetKey, reload]);
  // Coming back to the tab asks again (answered from cache once it has succeeded).
  useFocusEffect(useCallback(() => setReload((n) => n + 1), []));
  const fresh = infoNet === network;
  const bi = fresh && info && info !== 'failed' ? info : null;
  const readVault = useCallback(() => {
    if (!vault) return;
    let live = true;
    runningVaultVersion(vault, network).then((v) => live && setVersion(v));
    /**
     * The bridge is on unless the owner turned it off (the vault stores "off", so a vault that never
     * touched it reads as on). One that cannot answer — not activated yet, or on a release before
     * the bridge, which the bridge's own write upgrades — is on as well.
     */
    readBridgeSettings(vault, network).then((s) => live && setSettings(s ? {...s, read: true} : {enabled: true, enableAt: 0, read: false}));
    return () => {
      live = false;
    };
  }, [vault, network]);
  // A different vault is a different account: that one does wait. A network switch keeps the old
  // answers on screen until the new ones land.
  useEffect(() => {
    setVersion(undefined);
    setSettings(undefined);
  }, [vault]);
  useFocusEffect(readVault);

  /**
   * Pull to refresh, as on Trade: the guard's routes read again (a route added since launch shows),
   * the vault's bridge switch and release, its balances, and the quote. The spinner clears on its own.
   */
  const [pulled, setPulled] = useState(false);
  const onPull = () => {
    setPulled(true);
    forgetBridge(network);
    setReload((n) => n + 1);
    readVault();
    bal.refresh();
    setQuoteNonce((n) => n + 1);
    setTimeout(() => setPulled(false), 1200);
  };

  // The form: where to, what, how much.
  const [to, setTo] = useState<Network | null>(null);
  const [assetAddr, setAssetAddr] = useState<string | null>(null);
  /** The From or To network, or the coin and where it comes from. */
  const [picker, setPicker] = useState<'from' | 'to' | 'source' | null>(null);
  const destinations = useMemo(() => Array.from(new Set((bi?.routes ?? []).map((r) => r.to))), [bi]);
  /**
   * Where To should land once the network switch below has loaded its routes: the network just
   * left, after a flip or after picking To's network as From. Kept until the routes are in, since
   * they arrive empty first.
   */
  const nextTo = useRef<Network | null>(null);
  useEffect(() => {
    if (!fresh) return;
    const want = nextTo.current;
    nextTo.current = null;
    if (!destinations.length) return setTo(want);
    const next = want && destinations.includes(want) ? want : destinations[0];
    setTo(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinations, fresh]);
  /**
   * From is the network in front, so picking it switches the app's network, as the header does.
   * Offered: this network and where it bridges to; with no routes read, the listed networks of the
   * same kind (mainnets with mainnets, testnets with testnets).
   */
  // Every vault network the picker lists, not only those this one bridges to: BSC and Robinhood send
  // where Ethereum, Base and Arbitrum do not yet receive.
  const fromChoices = listed.filter((n) => acrossServes(n) && isTestnet(n) === isTestnet(network));
  const pickFrom = (n: Network) => {
    if (n === network) return;
    const next = n === to ? network : to;
    nextTo.current = next;
    setTo(next);
    // A new From is a new balance: the amount starts over, so the balance and MAX are back in its place,
    // and the coin is the default again for what that network's vault holds.
    userPicked.current = false;
    resetFunding();
    setAmount('');
    setQuote(null);
    setNetwork(n);
  };
  const flip = () => to && pickFrom(to);
  const routesTo = useMemo(() => (bi?.routes ?? []).filter((r) => r.to === to), [bi, to]);
  /** As every other screen names it: the vault's WETH is WETH, even where it crosses as ETH. */
  const symOf = (r: BridgeRoute) => displaySymbol(r.asset.symbol);
  const lastSym = useRef<string | null>(null);
  /** Set once the owner picks a coin; a new From network forgets it. Until then the default can move as balances load. */
  const userPicked = useRef(false);
  /**
   * The default coin: the first one the vault holds, in this order — USDC, USDT, any other
   * stablecoin, then ETH last. Holding none of them, USDC (or whatever comes first in that order).
   */
  useEffect(() => {
    if (!fresh || !routesTo.length) return;
    const valid = routesTo.some((r) => routeId(r) === assetAddr);
    if (valid && userPicked.current) return;
    const rank = (r: BridgeRoute) => {
      const sym = r.asset.symbol.toUpperCase();
      if (sym === 'USDC') return 0;
      if (sym === 'USDT') return 1;
      if (r.asset.kind === 'stable') return 2;
      return 3;
    };
    const ordered = [...routesTo].sort((a, b) => rank(a) - rank(b));
    // Held free or in a yielding or lending position: either can be bridged.
    const has = (r: BridgeRoute) => worthOf(r, totalOf(r));
    const pick = ordered.find(has) ?? ordered[0];
    if (routeId(pick) !== assetAddr) {
      setAssetAddr(routeId(pick));
      resetFunding();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routesTo, assetAddr, fresh, bal.balances, pos.positions]);
  const route: BridgeRoute | undefined = routesTo.find((r) => routeId(r) === assetAddr);
  // A balance under a cent (0.000074 USDT, ETH dust a withdrawal left) gets no line and no row.
  const prices = usePrices(network, 0, useMemo(() => routesTo.map((r) => r.asset.symbol), [routesTo]));
  const worthOf = (r: BridgeRoute, n: number) => worthShowing(n, r.asset.symbol, prices, r.asset.kind === 'stable');
  /**
   * The positions of a coin a bridge can draw on. Not Lido's: its withdrawal is a queue that pays
   * out days later, so there is nothing there to bridge in the same transaction.
   */
  const movableFor = (r: BridgeRoute) =>
    pos.positions.filter(
      (p) => p.asset.toLowerCase() === r.asset.address.toLowerCase() && !isQueuedStake(p.protocolName) && worthOf(r, Number(p.formatted)),
    );
  const movable = route ? movableFor(route) : [];
  const positionTag = (kind: string) => t(kind === 'supplied' ? 'vault.lending' : 'vault.yielding');
  /**
   * Where the coin comes from, as on Trade's market order: a tick per source and how much of it to
   * take. The sources are the free balance ('free'), each yielding or lending position (keyed by its
   * adapter), and the fee reserve ('reserve'). One coin per bridge, so every source is the same coin;
   * the positions are withdrawn in the same multicall as the bridge, and what crosses is the total.
   *
   * The free balance's ceiling has the fee reserve taken off it, as Trade's does, so Max leaves the
   * float for later fees. Unlike Trade, the reserve is a source of its own: ticking it takes the
   * float too, all but what THIS bridge will be billed, so a vault can be emptied to the other side.
   */
  const [fundOn, setFundOn] = useState<Record<string, boolean>>({free: true});
  const [fundAmt, setFundAmt] = useState<Record<string, string>>({});
  /** The amount field as typed; the rows hold how it is split. */
  const [amountText, setAmountText] = useState('');
  /** Until a tick is changed, the ticks follow the coin's funded sources as balances and positions load. */
  const fundTouched = useRef(false);
  const freeOf = (r: BridgeRoute) => Number(balanceOfSymbol(bal.balances, r.asset.symbol) || 0);
  /** The free balance, when it is more than dust. */
  const freeWorth = (r: BridgeRoute) => worthOf(r, freeOf(r));
  /** What the free balance plus every position of a coin holds, for the coin list. */
  const totalOf = (r: BridgeRoute) => freeOf(r) + movableFor(r).reduce((n, p) => n + Number(p.formatted), 0);
  if (route) lastSym.current = symOf(route);
  /** The coin's name, kept on screen while a switched-to network's routes load. */
  const shownSym = route ? symOf(route) : lastSym.current;
  /**
   * What arrives on the other side, which is not always what leaves: Robinhood has no USDC, so its
   * USDG crosses to Base as Base's USDC. Named from the destination's own asset list by the route's
   * output token; a token that list does not have keeps the coin's own name.
   */
  const outSymOf = (r: BridgeRoute) => {
    const out = knownAssets(r.to).find((a) => a.address.toLowerCase() === r.outputToken.toLowerCase());
    return out ? displaySymbol(out.symbol) : symOf(r);
  };
  const lastOutSym = useRef<string | null>(null);
  if (route) lastOutSym.current = outSymOf(route);
  const shownOutSym = route ? outSymOf(route) : lastOutSym.current;

  const decOf = (r: BridgeRoute) => (r.native ? NATIVE[network].decimals : r.asset.decimals);
  const dec = route ? decOf(route) : 18;
  const toRaw = (v: string) => {
    if (!route || !v) return 0n;
    try {
      return parseUnits(v.replace(',', '.') as `${number}`, decOf(route));
    } catch {
      return 0n;
    }
  };
  const numRaw = (n: number) => (route && n > 0 ? toRaw(n.toFixed(dec)) : 0n);
  const fmtCap = (x: bigint) => formatUnits(x, dec);
  const big = (x: bigint) => (x > 0n ? x : 0n);

  /**
   * The fee float, worked out as Trade and Send do: held back only in its own coin, and never below
   * what this operation will be billed ({useFeeFloor}). Nothing of this coin is held back when the
   * vault pays its fees in another one.
   */
  const feeFloor = useFeeFloor(network);
  const weth = useWethFeeCoin(network, vault);
  const reserve = resolveFeeReserve({
    network,
    vault,
    heldStables: [
      ...assets.filter((a) => a.kind === 'stable').map((a) => ({symbol: a.symbol, amount: Number(balanceOfSymbol(bal.balances, a.symbol) || 0)})),
      ...(weth ? [{symbol: feeWeth(network), amount: Number(balanceOfSymbol(bal.balances, feeWeth(network)) || 0), usd: weth.usd}] : []),
    ],
    spendSymbol: route?.asset.symbol,
    floorUsd: feeFloor,
  });
  const freeRaw = route ? toRaw(balanceOfSymbol(bal.balances, route.asset.symbol) || '0') : 0n;
  const keepRaw = numRaw(reserve.keep);
  /** What the float actually holds of the free balance: never more than there is. */
  const heldRaw = keepRaw < freeRaw ? keepRaw : freeRaw;
  /** This bridge's own fee, in the coin: what stays behind even when the reserve is taken. */
  const coinUsd = reserve.coin?.toUpperCase() === feeWeth(network) ? weth?.usd ?? 0 : 1;
  const feeNowRaw = reserve.keep > 0 && coinUsd > 0 ? numRaw(feeFloor / coinUsd) : 0n;
  const posOf = (key: string) => movable.find((p) => p.protocol === key);
  /** The most each source can put in, in the coin's smallest unit. */
  const capRaw = (key: string): bigint =>
    !route ? 0n : key === 'free' ? big(freeRaw - keepRaw) : key === 'reserve' ? big(heldRaw - feeNowRaw) : toRaw(posOf(key)?.formatted ?? '0');
  /** Every source of this coin, in the order a typed amount fills them: free, the positions, the reserve last. */
  const sourceKeys = route ? ['free', ...movable.map((p) => p.protocol as string), ...(heldRaw > 0n ? ['reserve'] : [])] : ['free'];
  const sourceKey = sourceKeys.join(',');
  /** Ticked to begin with: the free balance, or the positions when the free balance is only dust. */
  const defaultOn = (): Record<string, boolean> => {
    if (!route) return {free: true};
    const freeFirst = freeWorth(route) || !movable.length;
    return Object.fromEntries(sourceKeys.filter((k) => k !== 'reserve').map((k) => [k, k === 'free' ? freeFirst : !freeFirst]));
  };
  useEffect(() => {
    if (fundTouched.current) return;
    setFundOn(defaultOn());
    setFundAmt({});
    setAmountText('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, assetAddr]);
  /** Back to the coin's own sources, empty: a new coin or a new From network. */
  const resetFunding = () => {
    fundTouched.current = false;
    setFundOn(defaultOn());
    setFundAmt({});
    setAmountText('');
  };
  const setAmount = (v: string) => {
    if (v !== '') return;
    setFundAmt({});
    setAmountText('');
  };
  const ticked = sourceKeys.filter((k) => fundOn[k]);
  /** A row's amount, never past what its source holds. */
  const rowOf = (on: Record<string, boolean>, amt: Record<string, string>, k: string) => {
    if (!on[k]) return 0n;
    const x = toRaw(amt[k] ?? '');
    const cap = capRaw(k);
    return x > cap ? cap : x;
  };
  /** What the ticked sources hold together: the figure Available names and Max fills. */
  const availRaw = ticked.reduce((n, k) => n + capRaw(k), 0n);
  /** A row changed: the field restates the rows' total, so the two always agree. */
  const applyRows = (on: Record<string, boolean>, amt: Record<string, string>) => {
    fundTouched.current = true;
    setFundOn(on);
    setFundAmt(amt);
    const total = sourceKeys.reduce((n, k) => n + rowOf(on, amt, k), 0n);
    setAmountText(total > 0n ? fmtCap(total) : '');
  };
  /** The field was typed in: the amount is split over the ticked sources in order, each up to what it holds. */
  const typeAmount = (v: string) => {
    fundTouched.current = true;
    setAmountText(v);
    let left = toRaw(v);
    const amt: Record<string, string> = {};
    for (const k of ticked) {
      const cap = capRaw(k);
      const take = left < cap ? left : cap;
      amt[k] = take > 0n ? fmtCap(take) : '';
      left -= take;
    }
    setFundAmt(amt);
  };
  /** Max: every ticked source in full. */
  const maxAll = () => applyRows(fundOn, Object.fromEntries(ticked.map((k) => [k, fmtCap(capRaw(k))])));
  /** Tick or untick a source: ticking brings all of it in, unticking takes it out. */
  const toggleSource = (k: string) => {
    const on = {...fundOn, [k]: !fundOn[k]};
    applyRows(on, {...fundAmt, [k]: on[k] ? fmtCap(capRaw(k)) : ''});
  };
  /** What crosses: the amount in the field. */
  const raw = toRaw(amountText);
  const amount = route && raw > 0n ? formatUnits(raw, dec) : '';
  /** More than the ticked sources hold, or rows that no longer add up to the field (a balance moved). */
  const over = raw > availRaw || (raw > 0n && ticked.reduce((n, k) => n + rowOf(fundOn, fundAmt, k), 0n) !== raw);
  /** The positions drawn on: each withdraws exactly its row. The free balance and the reserve are in the vault already. */
  const plan = movable.flatMap((p) => {
    const x = rowOf(fundOn, fundAmt, p.protocol as string);
    return x > 0n ? [{protocol: p.protocol as Address, raw: x}] : [];
  });
  const planKey = plan.map((w) => `${w.protocol}:${w.raw}`).join(',');
  /** The float's coin, when it is another than this one: billed, pinned, as on Trade. */
  const pinnedFee = route ? feeCoinForSpend(network, reserve.coin, route.asset.symbol) : null;

  // Where it lands, and Across's quote for it — re-asked shortly after the amount stops changing.
  const [recipient, setRecipient] = useState<Address | null>(null);
  useEffect(() => {
    setRecipient(null);
    if (!bi || !to || !vault || !owner) return;
    let live = true;
    bridgeRecipient(network, bi.adapter, vault, to, owner as Address)
      .then((r) => live && setRecipient(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bi, to, vault, owner, network]);
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [quoteErr, setQuoteErr] = useState<BridgeQuoteError | null>(null);
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    // Quoted over the balance too, so what an amount would bring is seen before there is enough; Confirm stays off.
    if (!route || !recipient || raw <= 0n) return;
    let live = true;
    setQuoting(true);
    const timer = setTimeout(() => {
      quoteBridge(network, route, raw, recipient, bridgeOriginOwner(network, route.to, owner as Address))
        .then((q) => live && setQuote(q))
        .catch((e) => live && setQuoteErr(e instanceof BridgeQuoteError ? e : new BridgeQuoteError('quote_failed')))
        .finally(() => live && setQuoting(false));
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
      setQuoting(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, recipient, raw, network, quoteNonce, planKey]);

  // The coin the relayer bills.
  const stables = assets.filter((a) => a.kind === 'stable');
  const billFor = (r: BridgeRoute) => {
    // The float is in another coin: that one, pinned past the fee-coin order (see {pinnedFee}).
    if (pinnedFee) return {coin: pinnedFee, pin: true};
    // The float is held back in this very coin, so this coin still has the fee after the bridge.
    if (keepRaw > 0n) return {coin: r.asset.address, pin: r.asset.address !== stables[0]?.address};
    const other = stables.find((a) => a.address !== r.asset.address);
    return {coin: (other ?? stables[0])?.address, pin: !!other && other.address !== stables[0]?.address};
  };

  const doBridge = async (upgradeVault = false) => {
    if (!bi || !route || !quote || !vault) return;
    const bill = billFor(route);
    if (!bill.coin) return;
    const tx = showTx(`${t('mobile.bridge.tab')} ${fmtNum(Number(amount))} ${symOf(route)} → ${label(route.to)}`, network);
    try {
      const account = await getSigner();
      const withdrawals = plan;
      const hash = await bridgeFromVault({account, vault, network, adapter: bi.adapter, route, quote, stableCoin: bill.coin, pinFee: bill.pin, upgradeVault, withdrawals});
      tx.success(hash);
      setAmount('');
      resetFunding();
      bal.refresh();
      if (withdrawals.length) pos.refresh();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    }
  };

  const toggle = (enabled: boolean) => {
    if (!vault || !stables[0]) return;
    ask({
      title: t(enabled ? 'mobile.bridge.turn_on' : 'mobile.bridge.turn_off'),
      message: t(enabled ? 'mobile.bridge.turn_on_confirm' : 'mobile.bridge.turn_off_confirm'),
      gas: SWITCH_GAS,
      run: async () => {
        const tx = showTx(t(enabled ? 'mobile.bridge.turn_on' : 'mobile.bridge.turn_off'), network);
        try {
          const account = await getSigner();
          tx.success(await setBridgeEnabled({account, vault, network, enabled, stableCoin: stables[0].address}));
          // Read once the relayer has had a moment to land it.
          setTimeout(readVault, 6000);
        } catch (e) {
          tx.error(String((e as Error)?.message ?? e));
        }
      },
    });
  };

  /** One withdrawal per position drawn on rides in front of the bridge, in the one multicall. */
  const bridgeGas = plan.length ? relayGasFor({swap: 1, withdraw: plan.length}) : BRIDGE_GAS;

  /** The button is the confirmation (Face ID and the fee are on it), as on Send and Trade. */
  const confirm = () => {
    if (!route || !quote || !recipient) return;
    // Auto upgrade off and the release has no bridge: one question, then one transaction.
    if (askUpgrade && offered) {
      ask({
        title: t('mobile.bridge.upgrade_ask_title'),
        message: t('mobile.bridge.upgrade_ask_body', {from: version ?? '—', to: offered}),
        gas: bridgeGas,
        run: () => doBridge(true),
      });
      return;
    }
    void doBridge();
  };

  // The header's height is the scroll's inset, not padding (as on Trade): so the pull's spinner shows under the bar.
  const pad = {paddingTop: 8, paddingBottom: tabBarHeight + 16};
  // Not scrolled, so the bar's height is padding here.
  const padStill = {paddingTop: headerHeight + 8, paddingBottom: tabBarHeight + 16};
  const message = (text: string) => (
    <View style={[styles.empty, padStill]}>
      <NetworkIcon network={network} size={56} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );

  if ((info === undefined && !infoNet) || (vault && (version === undefined || settings === undefined))) {
    return (
      <View style={[styles.empty, padStill]}>
        <ActivityIndicator color={c.subtext} />
      </View>
    );
  }
  /**
   * A vault on a release before the bridge still gets the whole screen: turning the bridge on is a
   * write, and Auto upgrade puts the upgrade in front of it in the same transaction. Only when no
   * such upgrade is due (Auto upgrade off, or 1.1.0 not offered yet) does it ask for one first.
   */
  const behind = !!version && !versionAtLeast(version, BRIDGE_SINCE);
  /**
   * As every other write: when Auto upgrade has an upgrade due for this vault, it rides in front of
   * the bridge in the same transaction, whatever the release number says. A vault on an earlier
   * build of the same release (the first 1.1.0 kept the bridge off until turned on) is brought to
   * the current one, which has it on, and bridges in that one transaction.
   */
  const ridesTo = vault ? plannedVaultUpgrade(vault, network) : null;
  const upgradeRides = !!ridesTo && versionAtLeast(ridesTo, BRIDGE_SINCE);
  /**
   * Auto upgrade off: the owner upgrades from Settings first. Needed when the release has no bridge,
   * or when a newer build is on offer and this one reads the bridge off (the first 1.1.0 build).
   */
  const offered = vault ? availableVaultUpgrade(vault, network) : null;
  const upgradeYourself = !upgradeRides && (behind || (!!offered && settings?.enabled === false));
  /**
   * Auto upgrade off, and a release with the bridge on offer: nothing to say on the screen. The
   * confirm asks, and a yes upgrades the vault and bridges in one transaction. Only when no such
   * release is offered (the plan not read yet) is the user sent to Settings.
   */
  const askUpgrade = upgradeYourself && !!offered && versionAtLeast(offered, BRIDGE_SINCE);
  const stuck = upgradeYourself && !askUpgrade;

  const fillTime = (s: number) => (s < 90 ? t('mobile.bridge.seconds', {n: Math.max(1, Math.round(s))}) : t('mobile.bridge.minutes', {n: Math.round(s / 60)}));
  const fmtRaw = (x: bigint) => fmtNum(Number(formatUnits(x, dec)));
  const errText = quoteErr
    ? t(`mobile.bridge.${quoteErr.key}`, {
        min: quoteErr.params.min ? fmtRaw(BigInt(quoteErr.params.min)) : '',
        max: quoteErr.params.max ? fmtRaw(BigInt(quoteErr.params.max)) : '',
        symbol: route ? symOf(route) : '',
      })
    : null;
  // Off as the vault reads now, but an upgrade rides in front: the build it lands on decides, and it has the bridge on.
  const on = !!settings?.enabled || upgradeRides || askUpgrade || stuck;
  // The daily loss limit at $0 refuses a bridge (its cost counts against the limit): say so in the
  // bridge's words, not the market trade's the shared reason is named for.
  const lossOff = !gate.allowed && gate.reason === 'market_trade_off';
  const blocked = gate.allowed ? null : lossOff ? 'loss_off' : t(gateReasonKey(gate)!);
  // "Daily loss limit" in the sentence is a link to its own page in Risk settings.
  const lossOffLine = () => {
    const limit = t('mobile.vault.market_trade_loss_allowance');
    const [before, after = ''] = t('mobile.bridge.loss_off', {limit: '\u0000'}).split('\u0000');
    return (
      <Text style={styles.note}>
        {before}
        <Text style={styles.link} onPress={() => nav.navigate('VaultRiskValue', {field: 'marketTradeDailyLossAllowance'})} suppressHighlighting>
          {limit}
        </Text>
        {after}
      </Text>
    );
  };
  // The form shows either way, as the Trade tab does; this says why it has nothing to offer.
  const emptyNote = fresh && info === 'failed' ? t('mobile.bridge.load_failed') : null;

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.body, pad]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentInset={{top: headerHeight}}
        contentOffset={{x: 0, y: -headerHeight}}
        scrollIndicatorInsets={{top: headerHeight}}
        automaticallyAdjustContentInsets={false}
        refreshControl={<RefreshControl refreshing={pulled} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}>
        {/* From: the network in front (picking another switches the app's), what to send, how much. */}
        {/* The protocol behind it, as Trade carries Uniswap's: the mark on the right, tapped to say what it is. */}
        {/* From: a header as Earn's cards have (the network to pick, the protocol on the right), then
            the asset and amount laid out as on Send. Picking another network switches the app's. */}
        <SettingsGroup>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{t('mobile.bridge.from')}</Text>
            {/* Picked here or in the header's switcher: both are the app's network. */}
            <NetPill network={network} name={label(network)} onPress={() => setPicker('from')} styles={styles} />
            {/* The vault it leaves, after its network. */}
            {vault ? <VaultAddr address={vault} styles={styles} /> : null}
          </View>
          {/* Trade's field: what the ticked sources hold above it (tapped, it is Max), the amount, Max
              or clear, and the coin's pill, which opens where it comes from. */}
          <View style={[styles.line, styles.lineTop]}>
            {shownSym ? <AvailableLine amount={Number(fmtCap(availRaw))} symbol={shownSym} onPress={maxAll} /> : null}
            <View style={styles.field}>
              <Pressable style={styles.assetPill} onPress={() => setPicker('source')} accessibilityRole="button">
                {shownSym ? <TokenIcon symbol={shownSym} size={20} /> : null}
                <Text style={styles.assetSym}>{shownSym ?? '—'}</Text>
              </Pressable>
              <TextInput
                style={[styles.input, over && styles.inputOver]}
                keyboardType="decimal-pad"
                value={amountText}
                placeholder="0"
                placeholderTextColor={c.subtext}
                onChangeText={typeAmount}
              />
              {Number(amountText) > 0 ? (
                <ClearBtn onPress={() => setAmount('')} />
              ) : availRaw > 0n ? (
                <Pressable style={styles.maxBtn} onPress={maxAll} hitSlop={8}>
                  <Text style={styles.maxBadge}>{t('common.max')}</Text>
                </Pressable>
              ) : null}
            </View>
            {over ? <Text style={styles.err}>{t('vault.exceeds_balance')}</Text> : null}
          </View>
        </SettingsGroup>

        {/* The same arrow as Trade's, with room around it: swaps From and To. */}
        <Pressable onPress={flip} disabled={!to} hitSlop={8} style={[styles.flipBtn, !to && styles.dim]} accessibilityRole="button" accessibilityLabel={t('mobile.trade.swap_sides')}>
          <Svg width={18} height={18} viewBox="0 0 24 24">
            <Path d="M12 5v14M6 13l6 6 6-6" stroke={c.text} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </Pressable>

        {/* To: the owner's vault on the other network, and about what arrives there, in the same layout. */}
        <SettingsGroup>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{t('mobile.bridge.to')}</Text>
            <NetPill network={to} name={to ? label(to) : t('mobile.bridge.choose_destination')} onPress={() => setPicker('to')} styles={styles} />
            {/* The owner's vault there, where it arrives. */}
            {to && recipient ? <VaultAddr address={recipient} styles={styles} /> : null}
            <View style={styles.spacer} />
            {quote?.fillSeconds ? (
              <Text {...FIT} style={styles.arrival}>
                {t('mobile.bridge.arrival_time')} <Text style={styles.arrivalValue}>{fillTime(quote.fillSeconds)}</Text>
              </Text>
            ) : null}
          </View>
          <View style={styles.line}>
            <View style={styles.field}>
              {/* The coin that arrives (picked on From, so plain, not a pill, so it does not look tappable). */}
              <View style={styles.assetStatic}>
                {shownOutSym ? <TokenIcon symbol={shownOutSym} size={20} /> : null}
                <Text style={styles.assetSym}>{shownOutSym ?? '—'}</Text>
              </View>
              <Text {...FIT} style={[styles.receiveAmount, !quote && styles.receiveEmpty]}>
                {quote && route ? `≈ ${fmtRaw(quote.received)}` : '0'}
              </Text>
              {quoting ? <ActivityIndicator size="small" color={c.subtext} /> : null}
            </View>
          </View>
        </SettingsGroup>

        {emptyNote ? <Text style={styles.hint}>{emptyNote}</Text> : null}
        {errText ? <Text style={styles.err}>{errText}</Text> : null}


        {/* Never a note about upgrading: the upgrade goes in front of the bridge, in its transaction
            (Auto upgrade) or after one question on Confirm. Until the release on offer is read,
            Confirm waits. */}
        {lossOff ? lossOffLine() : blocked ? <Text style={styles.err}>{blocked}</Text> : null}

        {!on && !stuck ? (
          // Off: what the bridge is, and the switch — or when a turn-on already asked for applies.
          <SettingsGroup>
            <View style={styles.offCard}>
              <Text style={styles.offText}>{t('mobile.bridge.off_body')}</Text>
              {settings?.enableAt ? (
                <Text style={styles.enabling}>{t('mobile.bridge.enabling', {date: new Date(settings.enableAt * 1000).toLocaleString()})}</Text>
              ) : enableGate.allowed ? (
                <Pressable style={({pressed}) => [styles.primary, pressed && styles.pressed]} onPress={() => toggle(true)}>
                  <Text style={styles.primaryText}>{t('mobile.bridge.turn_on')}</Text>
                </Pressable>
              ) : (
                <Text style={styles.err}>{t(gateReasonKey(enableGate)!)}</Text>
              )}
            </View>
          </SettingsGroup>
        ) : null}

        {on ? (
          <View style={styles.footer}>
            {/* Who carries it, then Bitty's fee, both as Trade's lines: the label left, the value right. */}
            <View style={styles.feeLine}>
              <Text style={styles.feeLabel}>{t('mobile.bridge.protocol')}</Text>
              <ProtocolChip name={BRIDGE_PROTOCOL_NAME} size={16} />
            </View>
            <View style={styles.feeLine}>
              <Text style={styles.feeLabel}>
                {t('mobile.bridge.bitty_fee')} <Text style={styles.feeValue}>{BRIDGE_FEE_BPS / 100}%</Text>
              </Text>
              {quote && route && quote.fee > 0n ? <Text style={styles.feeValue}>{`${fmtRaw(quote.fee)} ${symOf(route)}`}</Text> : null}
            </View>
            <ConfirmButton onPress={confirm} disabled={!quote || over || !!blocked || stuck} gas={bridgeGas} locked={!gate.allowed && gate.reason !== 'market_trade_off'} />
          </View>
        ) : null}
      </ScrollView>

      <Sheet
        visible={picker != null}
        title={t(picker === 'from' ? 'mobile.bridge.from' : picker === 'to' ? 'mobile.bridge.to' : 'vault.select_asset')}
        onClose={() => setPicker(null)}
        // The sources apply as they are ticked, so closing confirms, as on Trade; and taller, for the fractions and the keyboard.
        done={picker === 'source'}
        height={Math.round(screenHeight * (picker === 'source' ? 0.8 : 0.5))}>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {picker === 'from'
            ? fromChoices.map((n) => (
                <Pressable key={n} style={styles.pickRow} onPress={() => (pickFrom(n), setPicker(null))}>
                  <NetworkIcon network={n} size={30} />
                  <Text style={styles.pickLabel}>{label(n)}</Text>
                  {n === network ? <Check color={c.accent} /> : null}
                </Pressable>
              ))
            : picker === 'to'
            ? destinations.map((n) => (
                <Pressable key={n} style={styles.pickRow} onPress={() => (setTo(n), setPicker(null))}>
                  <NetworkIcon network={n} size={30} />
                  <Text style={styles.pickLabel}>{label(n)}</Text>
                  {n === to ? <Check color={c.accent} /> : null}
                </Pressable>
              ))
            : picker === 'source' && route
            ? (
                <>
                  {/* Where it comes from, as Trade's funding sheet: a tick per source, the fractions and
                      the amount under a ticked one. The reserve is the last row and, unlike Trade's,
                      can be ticked: all of it but this bridge's own fee then crosses too. */}
                  {sourceKeys.map((key) => {
                    const p = posOf(key);
                    const cap = Number(fmtCap(capRaw(key)));
                    const sym = symOf(route);
                    const label = key === 'free' ? sym : key === 'reserve' ? `${sym} ${t('mobile.trade.fee_reserved')}` : `${sym} ${p ? positionTag(p.kind) : ''}`;
                    const sub = key === 'free' ? `${t('vault.balance')} · ${fmtNum(cap)}` : `${fmtNum(cap)} ${sym}`;
                    if (key !== 'free' && key !== 'reserve' && !(cap > 0)) return null;
                    return (
                      <FundRow
                        key={key}
                        label={label}
                        sub={sub}
                        symbol={route.asset.symbol}
                        cap={cap}
                        on={!!fundOn[key]}
                        amount={fundAmt[key] ?? ''}
                        inert={key === 'reserve' && !(cap > 0)}
                        onToggle={() => toggleSource(key)}
                        onAmount={(v) => applyRows({...fundOn, [key]: true}, {...fundAmt, [key]: v})}
                        onCommit={() => {
                          // Edited down to nothing: the source is out, so its tick goes with it.
                          if (!(Number(fundAmt[key]) > 0)) applyRows({...fundOn, [key]: false}, {...fundAmt, [key]: ''});
                        }}
                      />
                    );
                  })}
                  {/* The other coins: one crosses per bridge, so picking one starts the card over on it. */}
                  {routesTo
                    .filter((r) => routeId(r) !== assetAddr)
                    .map((r) => (
                      <Pressable
                        key={routeId(r)}
                        style={styles.pickRow}
                        onPress={() => {
                          userPicked.current = true;
                          fundTouched.current = false;
                          setAssetAddr(routeId(r));
                          setPicker(null);
                        }}>
                        <TokenIcon symbol={symOf(r)} size={30} />
                        <Text style={styles.pickLabel}>{symOf(r)}</Text>
                        <Text style={styles.pickSub}>{fmtNum(totalOf(r))}</Text>
                      </Pressable>
                    ))}
                </>
              )
            : null}
        </ScrollView>
      </Sheet>
      {sheet}
    </View>
  );
}

function Check({color}: {color: string}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path d="M20 6 9 17l-5-5" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** A vault's address after its network, shortened, and its copy button, which copies it in full. */
function VaultAddr({address, styles}: {address: Address; styles: ReturnType<typeof makeStyles>}) {
  return (
    <View style={styles.vaultAddrLine}>
      <Text style={styles.vaultAddr} numberOfLines={1}>
        {shortAddress(asShown(address))}
      </Text>
      <CopyButton address={address} size={12} />
    </View>
  );
}

/** A card header's network: its icon and name in a pill, tapped to pick another. */
function NetPill({network, name, onPress, styles}: {network: Network | null; name: string; onPress?: () => void; styles: ReturnType<typeof makeStyles>}) {
  // No onPress: shown, not chosen here, so no pill to tap.
  if (!onPress) {
    return (
      <View style={styles.netStatic}>
        {network ? <NetworkIcon network={network} size={18} /> : null}
        <Text {...FIT} style={styles.netName}>{name}</Text>
      </View>
    );
  }
  return (
    <Pressable onPress={onPress} hitSlop={6} style={({pressed}) => [styles.netPill, pressed && styles.pressed]} accessibilityRole="button">
      {network ? <NetworkIcon network={network} size={18} /> : null}
      <Text {...FIT} style={styles.netName}>{name}</Text>
    </Pressable>
  );
}

function QuoteRow({label, value, strong, mono, styles}: {label: string; value: string; strong?: boolean; mono?: boolean; styles: ReturnType<typeof makeStyles>}) {
  return (
    <View style={styles.quoteRow}>
      <Text style={styles.quoteLabel}>{label}</Text>
      <Text {...FIT} style={[styles.quoteValue, strong && styles.quoteStrong, mono && styles.mono]}>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    scroll: {flex: 1},
    body: {paddingHorizontal: 16, gap: 20},
    empty: {flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 14},
    emptyText: {color: c.text, fontSize: 17, fontWeight: '600', textAlign: 'center'},
    row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 52, paddingHorizontal: 16, gap: 12},
    rowTop: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    rowLabel: {color: c.subtext, fontSize: 15},
    rowValue: {flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1},
    value: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    chev: {color: c.subtext, fontSize: 20, fontWeight: '300'},
    pressed: {opacity: 0.6},
    dim: {opacity: 0.4},
    // Between the two cards with room on either side (the body's 20pt gap, less 8).
    flipBtn: {alignSelf: 'center', width: 36, height: 36, borderRadius: 18, backgroundColor: c.input, borderWidth: 3, borderColor: c.bg, alignItems: 'center', justifyContent: 'center', marginVertical: -8},
    offCard: {padding: 16, gap: 14},
    offText: {color: c.text, fontSize: 15, lineHeight: 21},
    enabling: {color: c.accent, fontSize: 15, fontWeight: '600'},
    primary: {backgroundColor: c.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center'},
    primaryText: {color: '#fff', fontSize: 16, fontWeight: '700'},
    line: {gap: 4, paddingHorizontal: 16, paddingVertical: 8},
    field: {flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 8},
    input: {flex: 1, minWidth: 0, color: c.text, fontSize: 17, paddingVertical: 0},
    inputOver: {color: c.danger},
    maxBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 124},
    maxBadge: {color: c.accent, backgroundColor: c.accentSoft, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden'},
    netStatic: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, paddingVertical: 5},
    assetStatic: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7},
    assetPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10},
    assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
    // As Send's pay pill names its source.
    // Send's: a hairline between the card's lines, and the Add row under them.
    lineTop: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    // Trade's venue and fee lines, in its sizes.
    caption: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 4, marginBottom: -12},
    captionText: {flexShrink: 1, color: c.subtext, fontSize: 13},
    captionNet: {color: c.text, fontWeight: '600'},
    venue: {flexDirection: 'row', alignItems: 'center', gap: 6},
    venueLabel: {color: c.subtext, fontSize: 13},
    feeLine: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 4},
    feeLabel: {color: c.subtext, fontSize: 13},
    feeValue: {color: c.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
    inputRight: {textAlign: 'right', fontWeight: '600'},
    fieldTall: {height: undefined, minHeight: 60, paddingVertical: 6},
    amountCol: {flex: 1, minWidth: 0, alignItems: 'flex-end', gap: 4},
    amountTop: {flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'stretch'},
    // The network's pill, as the asset's: the shape says it can be tapped.
    // Earn's card header: the title, then what it is about, a hairline under it.
    cardHead: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    cardTitle: {color: c.subtext, fontSize: 13, fontWeight: '600'},
    vaultAddrLine: {flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1},
    vaultAddr: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
    spacer: {flex: 1},
    arrival: {color: c.subtext, fontSize: 13, flexShrink: 1},
    arrivalValue: {color: c.text, fontWeight: '600'},
    netPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 14, paddingVertical: 4, paddingHorizontal: 8, flexShrink: 1},
    netName: {color: c.text, fontSize: 13, fontWeight: '600', flexShrink: 1},
    netBtn: {flexDirection: 'row', alignItems: 'center', backgroundColor: c.neutralSoft, borderRadius: 18, padding: 4},
    netBlank: {width: 26, height: 26, borderRadius: 13, backgroundColor: c.border},
    receiveRight: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, minWidth: 0},
    receiveAmount: {flex: 1, minWidth: 0, color: c.text, fontSize: 17, fontVariant: ['tabular-nums']},
    receiveEmpty: {color: c.subtext, fontWeight: '400'},
    quoteRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, paddingHorizontal: 16, gap: 12},
    quoteLabel: {color: c.subtext, fontSize: 14},
    quoteValue: {color: c.text, fontSize: 14, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right'},
    quoteStrong: {fontSize: 16, fontWeight: '700'},
    mono: {fontSize: 12},
    hint: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    err: {color: c.danger, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    link: {color: c.accent, fontWeight: '600'},
    note: {color: c.text, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    statusRow: {flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 16},
    statusText: {color: c.text, fontSize: 15, flexShrink: 1},
    footer: {gap: 14, alignItems: 'stretch'},
    offLink: {alignSelf: 'center', paddingVertical: 4},
    offLinkText: {color: c.danger, fontSize: 15, fontWeight: '600'},
    pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 4},
    pickLabel: {color: c.text, fontSize: 16, fontWeight: '600', flex: 1},
    pickSub: {color: c.subtext, fontSize: 14, fontVariant: ['tabular-nums']},
  });

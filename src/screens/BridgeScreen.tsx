import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {formatUnits, parseUnits, zeroAddress, type Address, type Hex} from 'viem';
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
import {CHAIN_ID, isTestnet, isTronNetwork, NATIVE, type Network} from '@/core/chain';
import {displayAddress, parseAddress} from '@/core/address';
import {isPayableAddress} from '@/core/asset-catalog';
import {recipientName, useRecipientNames} from '@/core/recipient-names';
import {fetchWhitelist, type WhitelistedRecipient} from '@/vault/payments';
import {WHITELIST_STATUS} from '@/core/abi';
import {getRiskConfig} from '@/vault/risk';
import {fmtAllowance} from '@/components/riskFormat';
import {QrScanner} from '@/components/QrScanner';
import {ScanButton} from '@/components/ScanIcon';
import {networkLabel, useNetwork, useNetworks} from '@/core/network-store';
import {useAssetCatalog} from '@/core/asset-catalog';
import {knownAssets} from '@/core/assets';
import {availableVaultUpgrade, plannedVaultUpgrade} from '@/vault/auto-upgrade';
import {ProtocolChip} from '@/components/ProtocolIcon';
import {useActiveVaultAddress, vaultAddressOf} from '@/core/active-vault';
import {useVaults, vaultLabel} from '@/core/vault-store';
import {CopyButton} from '@/components/CopyButton';
import {asShown, displaySymbol, fmtNum, shortAddress} from '@/core/format';
import {useWallet} from '@/wallet/store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {usePrices} from '@/vault/usePrices';
import {worthShowing} from '@/core/prices';
import {isQueuedStake} from '@/vault/lido';
import {balanceOfSymbol} from '@/vault/read';
import {quoteRelayFeeUsd, relayGasFor} from '@/vault/fee-quote';
import {useFeeFloor} from '@/vault/useFeeFloor';
import {feeCoinForSpend, feeWeth, reserveHeld, resolveFeeReserve, useWethFeeCoin} from '@/vault/stableCoinAsGas';
import {gateReasonKey, useCapability} from '@/vault/gate';
import {BRIDGE_TO_SINCE, NO_LIMIT, versionAtLeast} from '@/vault/capabilities';
import {runningVaultVersion} from '@/vault/vault-abi';
import {useActiveAccount} from '@/core/account-mode';
import {usdValue} from '@/core/prices';
import {bridgeFromWallet, walletBridgeCost} from '@/wallet/bridge';
import {recordSent} from '@/wallet/sent-log';
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
  type BridgeDest,
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
  /**
   * Wallet mode (core/account-mode): the key bridges its own coins to its own address on the other
   * network (wallet/bridge) — no vault, so none of its switch, release, positions or fee float.
   */
  const active = useActiveAccount(network);
  const walletOn = active.kind === 'wallet';
  const activeVault = useActiveVaultAddress(network);
  const vault = walletOn ? null : activeVault;
  const owner = useWallet((s) => s.address);
  const getSigner = useWallet((s) => s.signer);
  const assets = useAssetCatalog(network);
  const bal = useVaultBalances(network);
  const pos = useVaultPositions(vault, network);
  const ownGate = useCapability('bridge');
  const toGate = useCapability('bridgeTo');
  const payeeGate = useCapability('bridgeToWhitelistedRecipient');
  const enableGate = useCapability('enableBridge');
  const names = useRecipientNames((s) => s.names);
  /** Opened from a payee on another network (Payees): that payee is the recipient. */
  const params = useRoute<RouteProp<RootStackParamList, 'Bridge'>>().params;
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
  const [picker, setPicker] = useState<'from' | 'to' | 'source' | 'recipient' | null>(null);
  /**
   * Who is paid over there (vault 1.2.1 and an adapter that can): the owner's own smart wallet,
   * an address typed or scanned, or a payee from the book that reaches the To network.
   */
  const [dest, setDest] = useState<{kind: 'mine'} | {kind: 'address'} | {kind: 'payee'; id: string}>(() =>
    params?.payeeId ? {kind: 'payee', id: params.payeeId} : {kind: 'mine'},
  );
  const [addrText, setAddrText] = useState('');
  const [scanning, setScanning] = useState(false);
  /** The book, every network's entries: the payees a bridge may pay. Null until read. */
  const [book, setBook] = useState<WhitelistedRecipient[] | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!vault) return setBook(null);
      let live = true;
      fetchWhitelist(vault, network, {all: true}).then((b) => live && setBook(b));
      return () => {
        live = false;
      };
    }, [vault, network]),
  );
  /** The daily send limit, which a bridge to an address counts against. */
  const [sendLimit, setSendLimit] = useState<bigint | null>(null);
  useEffect(() => {
    setSendLimit(null);
    if (vault) getRiskConfig(vault, network).then((r) => r?.read && setSendLimit(r.sendDailyAllowance));
  }, [vault, network]);
  /**
   * Someone else over there: offered once the vault's release and the adapter both bridge to
   * others ({BRIDGE_TO_SINCE}), or an upgrade to such a release rides in front. A wallet sends to
   * any address straight through the SpokePool; it has no payee book.
   */
  const plannedUp = vault ? plannedVaultUpgrade(vault, network) : null;
  const toOthers = walletOn
    ? !!bi
    : !!bi?.toAddress && (versionAtLeast(version, BRIDGE_TO_SINCE) || (!!plannedUp && versionAtLeast(plannedUp, BRIDGE_TO_SINCE)));
  /**
   * There is no smart wallet on Tron any more: a vault bridges there only to someone else's
   * address or a payee, so without those Tron is not offered at all.
   */
  const ownOn = (n: Network) => walletOn || !isTronNetwork(n);
  const destinations = useMemo(
    () => Array.from(new Set((bi?.routes ?? []).map((r) => r.to))).filter((n) => toOthers || ownOn(n)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bi, toOthers, walletOn],
  );
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
  /**
   * The To field as typed, when the amount was asked for by what should ARRIVE: the From amount is
   * then worked back from Across's quote (see the quote's effect). Null while From leads.
   */
  const [toText, setToText] = useState<string | null>(null);
  /** How many times the From amount has been nudged toward the typed To amount; a few at most. */
  const toTries = useRef(0);
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
  const worstFloor = useFeeFloor(network);
  /**
   * What THIS bridge will be billed — a swap, plus a withdrawal per position it may draw on — with a
   * fifth more as gas moves. The fee floor prices the worst operation there is (a swap, two
   * withdrawals and a first setup), which on Tron's energy prices came to about $15 and held that
   * much back from Max. Zero when the owner pays; the worst case until this quote lands.
   */
  const [bridgeFeeUsd, setBridgeFeeUsd] = useState<number | null>(null);
  const movableCount = route ? movableFor(route).length : 0;
  useEffect(() => {
    setBridgeFeeUsd(null);
    if (walletOn) return;
    let live = true;
    quoteRelayFeeUsd(network, relayGasFor({swap: 1, withdraw: movableCount})).then((v) => live && v != null && v > 0 && setBridgeFeeUsd(v * 1.2));
    return () => {
      live = false;
    };
  }, [network, walletOn, movableCount]);
  const feeFloor = worstFloor === 0 ? 0 : bridgeFeeUsd != null ? Math.min(bridgeFeeUsd, worstFloor) : worstFloor;
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
  /**
   * What the wallet pays the chain for this bridge, in its coin: held back from Max when the coin
   * itself is what crosses (a sixth more, as the price moves), and the fee line's figure.
   */
  const [walletCost, setWalletCost] = useState<bigint | null>(null);
  useEffect(() => {
    setWalletCost(null);
    if (!walletOn || !route) return;
    let live = true;
    walletBridgeCost(network, route.native)
      .then((c2) => live && setWalletCost(c2))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [walletOn, network, route?.native, route]);
  const nativePrices = usePrices(network, 0, useMemo(() => [NATIVE[network].wrapped], [network]));
  const walletFeeUsd = walletOn && walletCost != null ? usdValue(Number(formatUnits(walletCost, NATIVE[network].decimals)), NATIVE[network].wrapped, nativePrices) : null;
  const walletKeep = walletOn && route?.native && walletCost ? walletCost + walletCost / 6n : 0n;
  const keepRaw = walletOn ? walletKeep : numRaw(reserve.keep);
  /** What the float actually holds of the free balance: never more than there is. */
  const heldRaw = keepRaw < freeRaw ? keepRaw : freeRaw;
  /** This bridge's own fee, in the coin: what stays behind even when the reserve is taken. */
  const coinUsd = reserve.coin?.toUpperCase() === feeWeth(network) ? weth?.usd ?? 0 : 1;
  const feeNowRaw = !walletOn && reserve.keep > 0 && coinUsd > 0 ? numRaw(feeFloor / coinUsd) : 0n;
  const posOf = (key: string) => movable.find((p) => p.protocol === key);
  /** The most each source can put in, in the coin's smallest unit. */
  const capRaw = (key: string): bigint =>
    !route ? 0n : key === 'free' ? big(freeRaw - keepRaw) : key === 'reserve' ? big(heldRaw - feeNowRaw) : toRaw(posOf(key)?.formatted ?? '0');
  /** Every source of this coin, in the order a typed amount fills them: free, the positions, the reserve last. */
  // A wallet has no float to offer as a source: what is held back of its coin is gas.
  const sourceKeys = route ? ['free', ...movable.map((p) => p.protocol as string), ...(heldRaw > 0n && !walletOn ? ['reserve'] : [])] : ['free'];
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
    setToText(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, assetAddr]);
  /** Back to the coin's own sources, empty: a new coin or a new From network. */
  const resetFunding = () => {
    fundTouched.current = false;
    setFundOn(defaultOn());
    setFundAmt({});
    setAmountText('');
    setToText(null);
  };
  const setAmount = (v: string) => {
    if (v !== '') return;
    setFundAmt({});
    setAmountText('');
    setToText(null);
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
    setToText(null);
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
  const [ownRecipient, setOwnRecipient] = useState<Address | null>(null);
  useEffect(() => {
    setOwnRecipient(null);
    // The wallet's own address over there: the same key, the same 20 bytes (on Tron written T…).
    if (walletOn) return setOwnRecipient(bi && to && active.address ? active.address : null);
    if (!bi || !to || !vault || !owner || !ownOn(to)) return;
    let live = true;
    bridgeRecipient(network, bi.adapter, vault, to, owner as Address)
      .then((r) => live && setOwnRecipient(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bi, to, vault, owner, network, walletOn, active.address]);
  /** The owner's own wallet over there is a choice: not a vault's to Tron. */
  const ownOk = !!to && ownOn(to);
  /**
   * An address may be typed straight into To while a send to anyone may go: refused under a lock,
   * and with Send to new at $0. A wallet answers to neither.
   */
  const addrOk = toOthers && (walletOn || toGate.allowed);
  /** A payee is paid on `n`: one on that network, or on every EVM network where the guard marks `n` EVM. */
  const reaches = (b: WhitelistedRecipient, n: Network) =>
    b.chain === CHAIN_ID[n] || (b.chain === 'evm' && !!bi?.evm.includes(n));
  const payeeNow = (b: WhitelistedRecipient) => b.status === WHITELIST_STATUS.payable || b.status === WHITELIST_STATUS.removalQueued;
  const payeesTo = !walletOn && toOthers && to && book ? book.filter((b) => reaches(b, to)) : [];
  const payee = dest.kind === 'payee' ? book?.find((b) => b.id === dest.id) : undefined;
  /** Opened for a payee on one other network: To is that network, once its routes are in. */
  const toForPayee = useRef(!!params?.payeeId);
  useEffect(() => {
    if (!toForPayee.current || !payee || typeof payee.chain !== 'number' || !destinations.length) return;
    toForPayee.current = false;
    const n = destinations.find((d) => CHAIN_ID[d] === payee.chain);
    if (n) setTo(n);
  }, [payee, destinations]);
  // A choice the new To network (or release) no longer allows falls back to the owner's own wallet,
  // or, where there is none (a vault to Tron), to an address.
  useEffect(() => {
    if (!to) return;
    if (dest.kind === 'mine') {
      if (!ownOk) setDest({kind: 'address'});
      return;
    }
    if (dest.kind === 'payee' && (!book || toForPayee.current)) return;
    const gone = dest.kind === 'payee' ? !(payee && reaches(payee, to)) : !addrOk;
    if (!toOthers || gone) setDest(ownOk ? {kind: 'mine'} : {kind: 'address'});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, toOthers, book, dest.kind, ownOk, addrOk]);
  /** What was typed, as the 0x… the vault takes (a Tron T… address too). */
  const typed = dest.kind === 'address' && to && isPayableAddress(addrText, to) ? parseAddress(to, addrText) : null;
  /** The vault's own address: its counterpart over there is "my smart wallet", and the vault refuses it as an address. */
  const typedSelf = !!typed && !!vault && typed.toLowerCase() === vault.toLowerCase();
  /**
   * The owner's own smart wallet, pasted in rather than picked: this vault's address, or its
   * counterpart over there. Not an error: it is sent as My smart wallet, the address left showing.
   */
  const isOwnText = (v: string) => {
    if (!to || !isPayableAddress(v, to)) return false;
    const a = parseAddress(to, v)?.toLowerCase();
    if (!a) return false;
    return (!!vault && a === vault.toLowerCase()) || (!!ownRecipient && a === ownRecipient.toLowerCase());
  };
  const pastedOwn = isOwnText(addrText);
  useEffect(() => {
    if (pastedOwn && ownOk && dest.kind === 'address') setDest({kind: 'mine'});
  }, [pastedOwn, ownOk, dest.kind]);
  /**
   * The owner's other smart wallets on the To network, for the list beside this one's. Paid as an
   * address (bridgeTo), so offered only while a send to anyone may go; a wallet bridges to its own.
   */
  const vaultRefs = useVaults((st) => st.vaults);
  const vaultIdx = useVaults((st) => st.activeIndex);
  const otherVaults = useMemo(() => {
    if (walletOn || !to || !ownOk || !addrOk) return [];
    const shown = vaultRefs.filter((v) => !v.hidden);
    const here = (vault ?? '').toLowerCase();
    const mine = (ownRecipient ?? '').toLowerCase();
    return shown
      .filter((v) => v.index !== vaultIdx)
      .map((v) => ({index: v.index, name: vaultLabel(v, (n) => t('mobile.app.vault_n', {n}), shown), address: vaultAddressOf(v, to)}))
      .filter((v): v is typeof v & {address: Address} => !!v.address && v.address.toLowerCase() !== here && v.address.toLowerCase() !== mine);
  }, [vaultRefs, vaultIdx, walletOn, to, ownOk, addrOk, vault, ownRecipient, t]);
  /** My smart wallet picked from the list: named on the row, as a payee is, until cleared. */
  const [mineChosen, setMineChosen] = useState(false);
  const recipient: Address | null =
    dest.kind === 'mine' ? (ownOk ? ownRecipient : null) : dest.kind === 'address' ? (typedSelf ? null : typed) : payee && to && reaches(payee, to) ? (payee.recipientAddress as Address) : null;
  /** To an address: a send that crosses, so a stablecoin only (the vault meters it as one); to a payee, any token but the coin itself. */
  const assetBad =
    !walletOn && !!route && ((dest.kind === 'address' && (route.native || route.asset.kind !== 'stable')) || (dest.kind === 'payee' && route.native));
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [quoteErr, setQuoteErr] = useState<BridgeQuoteError | null>(null);
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    // Quoted over the balance too, so what an amount would bring is seen before there is enough; Confirm stays off.
    // Before a recipient is named (an address still to type), the quote is asked for the owner's own
    // address: what arrives and the least that goes hardly depend on who receives, so the amount
    // gets its answer at once. Confirm still waits for the recipient; the quote is asked again then.
    const quoteTo = recipient ?? (owner as Address | null) ?? active.address ?? null;
    if (!route || !quoteTo || raw <= 0n || assetBad) return;
    let live = true;
    setQuoting(true);
    const timer = setTimeout(() => {
      // Only the owner's own vault over there takes the origin owner; someone else is paid as named.
      quoteBridge(network, route, raw, quoteTo, walletOn || dest.kind !== 'mine' ? zeroAddress : bridgeOriginOwner(network, route.to, owner as Address))
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
  }, [route, recipient, raw, network, quoteNonce, planKey, dest.kind, assetBad]);

  // To leads: nudge the From amount by what the quote fell short or over, until it lands on the
  // typed amount. The fee hardly moves with the amount, so one or two steps settle it.
  useEffect(() => {
    if (toText === null || !quote || !route) return;
    const want = toRaw(toText);
    const miss = want - quote.received;
    const tol = want / 10_000n; // within 0.01%
    if ((miss <= tol && -miss <= tol) || toTries.current >= 4) return;
    toTries.current += 1;
    const next = raw + miss;
    if (next > 0n) typeAmount(fmtCap(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote]);
  /** The To field typed in: a first guess at the From amount, from the last quote's rate when there is one. */
  const typeTo = (v: string) => {
    setToText(v);
    toTries.current = 0;
    const want = toRaw(v);
    if (want <= 0n) {
      fundTouched.current = true;
      setFundAmt({});
      setAmountText('');
      return;
    }
    const guess = quote && quote.received > 0n ? (want * quote.amount) / quote.received : want;
    typeAmount(fmtCap(guess));
  };
  /** What arrives, as the To field shows it while From leads: plain digits, so it can be typed over. */
  const toShown = toText ?? (quote && route ? String(Number(Number(formatUnits(quote.received, dec)).toFixed(6))) : '');

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

  const doBridgeWallet = async () => {
    const from = active.address;
    if (!bi || !route || !quote || !from) return;
    const title = `${t('mobile.bridge.tab')} ${fmtNum(Number(amount))} ${symOf(route)} → ${label(route.to)}`;
    const tx = showTx(title, network);
    try {
      const account = await useWallet.getState().walletSigner();
      const {hash} = await bridgeFromWallet({account, network, info: bi, route, quote, wallet: from, recipient: dest.kind === 'address' && typed ? typed : undefined});
      recordSent({
        hash,
        network,
        from,
        to: bi.spokePool,
        symbol: symOf(route),
        token: route.native ? null : route.asset.address,
        amount: formatUnits(quote.amount, dec),
      });
      tx.success(hash);
      setAmount('');
      resetFunding();
      bal.refresh();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    }
  };

  const doBridge = async (upgradeVault = false) => {
    if (walletOn) return doBridgeWallet();
    if (!bi || !route || !quote || !vault) return;
    const bill = billFor(route);
    if (!bill.coin) return;
    const tx = showTx(`${t('mobile.bridge.tab')} ${fmtNum(Number(amount))} ${symOf(route)} → ${label(route.to)}`, network);
    try {
      const account = await getSigner();
      const withdrawals = plan;
      const target: BridgeDest | undefined =
        dest.kind === 'address' && typed ? {kind: 'address', recipient: typed} : dest.kind === 'payee' && payee ? {kind: 'payee', id: payee.id} : undefined;
      if (dest.kind !== 'mine' && !target) return;
      const hash = await bridgeFromVault({account, vault, network, adapter: bi.adapter, route, quote, stableCoin: bill.coin, pinFee: bill.pin, upgradeVault, withdrawals, dest: target});
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
  /** The rule for who is paid: the owner's own bridge, a bridge to an address (a send), or to a payee. */
  const gate = dest.kind === 'address' ? toGate : dest.kind === 'payee' ? payeeGate : ownGate;
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
  const on = walletOn || !!settings?.enabled || upgradeRides || askUpgrade || stuck;
  // The daily loss limit at $0 refuses a bridge (its cost counts against the limit): say so in the
  // bridge's words, not the market trade's the shared reason is named for.
  // The vault's guard rules the vault's bridge; a wallet answers to no guard.
  const lossOff = !walletOn && dest.kind === 'mine' && !gate.allowed && gate.reason === 'market_trade_off';
  const blocked = walletOn || gate.allowed ? null : lossOff ? 'loss_off' : t(gateReasonKey(gate)!);
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

  const payeeName = (b: WhitelistedRecipient) =>
    recipientName(names, to ?? network, b.recipientAddress) ?? t('mobile.payments.recipient_n', {n: b.id});
  const ownName = () => t(walletOn ? 'mobile.bridge.my_wallet' : 'mobile.bridge.my_smart_wallet');
  const destName = () =>
    dest.kind === 'mine' ? (ownOk ? ownName() : t('mobile.bridge.choose_recipient')) : dest.kind === 'address' ? t('mobile.bridge.an_address') : payee ? payeeName(payee) : '…';
  /** What the choice of recipient means, under the To card. */
  const destNote = () => {
    if (!to || dest.kind === 'mine') return null;
    if (assetBad)
      return <Text style={styles.err}>{t(dest.kind === 'address' ? 'mobile.bridge.to_address_stable_only' : 'mobile.bridge.to_payee_no_native')}</Text>;
    if (walletOn) return <Text style={styles.hint}>{t('mobile.bridge.to_address_check', {network: label(to)})}</Text>;
    if (dest.kind === 'address') {
      const limit = sendLimit == null ? null : sendLimit === NO_LIMIT ? null : fmtAllowance(sendLimit, t);
      return (
        <Text style={styles.hint}>
          {limit ? `${t('mobile.bridge.to_address_limit', {limit})} ` : ''}
          {t('mobile.bridge.to_address_check', {network: label(to)})}
        </Text>
      );
    }
    return <Text style={styles.hint}>{t('mobile.bridge.to_payee_note')}</Text>;
  };

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
            {vault ? <VaultAddr address={vault} styles={styles} copy /> : walletOn && active.address ? <VaultAddr address={active.address} styles={styles} copy /> : null}
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
                onChangeText={(v) => {
                  setToText(null);
                  typeAmount(v);
                }}
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
            {/* Who is paid there, on this same row (vault 1.2.1). While a send to anyone may go, an
                address is typed straight in: left empty, the owner's own smart wallet. The book's
                payees are a tap on the person mark; the camera is at the right end. */}
            {toOthers && to && addrOk ? (
              <View style={styles.headRecip}>
                {(dest.kind === 'payee' && payee) || (dest.kind === 'mine' && mineChosen && !addrText) ? (
                  <>
                    {payee && dest.kind === 'payee' ? (
                      <Text {...FIT} style={styles.payeeChosen} numberOfLines={1}>
                        {payeeName(payee)}
                      </Text>
                    ) : (
                      // My smart wallet picked: its address there, shortened as From shows its own.
                      <View style={styles.headRecipAddr}>
                        {ownRecipient ? <VaultAddr address={ownRecipient} styles={styles} /> : <Text style={styles.payeeChosen}>{ownName()}</Text>}
                      </View>
                    )}
                    <ClearBtn
                      onPress={() => {
                        setMineChosen(false);
                        setDest(ownOk ? {kind: 'mine'} : {kind: 'address'});
                      }}
                    />
                  </>
                ) : (
                  <>
                    <TextInput
                      style={[styles.addrInput, addrText.length > 0 && dest.kind === 'address' && !typed && !pastedOwn && styles.inputOver]}
                      // Empty is the owner's own wallet, so no name stands in it; only where there is
                      // none of theirs (Tron) does it say what to type.
                      placeholder={ownOk ? undefined : t('mobile.bridge.address_on', {network: label(to)})}
                      placeholderTextColor={c.subtext}
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={addrText}
                      onChangeText={(v) => {
                        setAddrText(v);
                        setMineChosen(false);
                        // The owner's own address pasted in is My smart wallet (see `pastedOwn`), decided
                        // here in one step: passing through "an address" first re-asked the quote twice
                        // and the card redrew. Already My smart wallet, nothing changes at all.
                        const own = ownOk && (!v || isOwnText(v));
                        if (own) {
                          if (dest.kind !== 'mine') setDest({kind: 'mine'});
                        } else if (dest.kind !== 'address') setDest({kind: 'address'});
                      }}
                    />
                    {addrText ? (
                      <ClearBtn
                        onPress={() => {
                          setAddrText('');
                          if (ownOk) setDest({kind: 'mine'});
                        }}
                      />
                    ) : null}
                  </>
                )}
                {/* The list: My smart wallet, and the payees that reach this network. */}
                {ownOk || payeesTo.length > 0 || otherVaults.length > 0 ? (
                  <Pressable
                    hitSlop={8}
                    onPress={() => setPicker('recipient')}
                    accessibilityRole="button"
                    accessibilityLabel={t('mobile.bridge.recipient')}
                    style={({pressed}) => pressed && styles.pressed}>
                    <PersonIcon color={c.subtext} />
                  </Pressable>
                ) : null}
                {/* Its 48pt target, pulled in so the mark sits at the card's right inset. */}
                <View style={styles.scanEnd}>
                  <ScanButton onPress={() => setScanning(true)} />
                </View>
              </View>
            ) : toOthers && to && (payeesTo.length > 0 || !ownOk) ? (
              // Send to new at $0 or locked: no address to type, only the owner's own wallet or a payee.
              <Pressable
                style={({pressed}) => [styles.headRecip, pressed && styles.pressed]}
                onPress={() => setPicker('recipient')}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.bridge.recipient')}>
                <Text {...FIT} style={styles.recipValue} numberOfLines={1}>
                  {destName()}
                </Text>
                <Chevron color={c.subtext} />
              </Pressable>
            ) : (
              <>
                {/* The owner's vault there, where it arrives. */}
                {to && dest.kind === 'mine' && recipient ? <VaultAddr address={recipient} styles={styles} /> : null}
                <View style={styles.spacer} />
              </>
            )}
          </View>
          <View style={styles.line}>
            <View style={styles.field}>
              {/* The coin that arrives (picked on From, so plain, not a pill, so it does not look tappable). */}
              <View style={styles.assetStatic}>
                {shownOutSym ? <TokenIcon symbol={shownOutSym} size={20} /> : null}
                <Text style={styles.assetSym}>{shownOutSym ?? '—'}</Text>
              </View>
              {/* About what arrives, or typed: what should arrive, the From amount worked back from it. */}
              {toText === null && quote ? <Text style={styles.approx}>≈</Text> : null}
              <TextInput
                style={styles.input}
                keyboardType="decimal-pad"
                value={toShown}
                placeholder="0"
                placeholderTextColor={c.subtext}
                editable={!!route && !!to}
                onChangeText={typeTo}
              />
              {quoting ? <ActivityIndicator size="small" color={c.subtext} /> : null}
            </View>
          </View>
        </SettingsGroup>
        {destNote()}

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
            {/* How long it takes, as a fee line: the To row holds who is paid. */}
            {quote?.fillSeconds ? (
              <View style={styles.feeLine}>
                <Text style={styles.feeLabel}>{t('mobile.bridge.arrival_time')}</Text>
                <Text style={styles.feeValue}>{fillTime(quote.fillSeconds)}</Text>
              </View>
            ) : null}
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
            {walletOn ? (
              // The wallet's own gas, in its coin: the fee transfer, the approval or unwrap, the deposit.
              <ConfirmButton onPress={confirm} disabled={!quote || over || !recipient} fee={walletFeeUsd != null} networkFeeUsd={walletFeeUsd ?? undefined} />
            ) : (
              <ConfirmButton
                onPress={confirm}
                disabled={!quote || over || !!blocked || stuck || !recipient || assetBad}
                gas={bridgeGas}
                locked={!gate.allowed && gate.reason !== 'market_trade_off' && gate.reason !== 'send_allowance_off'}
              />
            )}
          </View>
        ) : null}
      </ScrollView>

      <Sheet
        visible={picker != null}
        title={t(picker === 'from' ? 'mobile.bridge.from' : picker === 'to' ? 'mobile.bridge.to' : picker === 'recipient' ? 'mobile.bridge.recipient' : 'vault.select_asset')}
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
            : picker === 'recipient' && to
            ? (
                <>
                  {/* Two sections: the owner's smart wallets (this one, then the others), and payees. */}
                  {ownOk ? <Text style={styles.pickSection}>{t('mobile.payments.my_vaults')}</Text> : null}
                  {ownOk ? (
                    <Pressable style={styles.pickRow} onPress={() => (setDest({kind: 'mine'}), setMineChosen(true), setAddrText(''), setPicker(null))}>
                      <NetworkIcon network={to} size={30} />
                      <View style={styles.pickCol}>
                        <Text style={styles.pickLabel} numberOfLines={1}>
                          {ownName()}
                        </Text>
                        {ownRecipient ? (
                          <Text style={styles.pickSub} numberOfLines={1}>
                            {shortAddress(displayAddress(to, ownRecipient))}
                          </Text>
                        ) : null}
                      </View>
                      {/* Ticked only once picked: the empty field's default is not a choice made. */}
                      {dest.kind === 'mine' && mineChosen ? <Check color={c.accent} /> : null}
                    </Pressable>
                  ) : null}
                  {otherVaults.map((v) => {
                    const on = dest.kind === 'address' && !!typed && typed.toLowerCase() === v.address.toLowerCase();
                    return (
                      <Pressable
                        key={`v${v.index}`}
                        style={styles.pickRow}
                        onPress={() => {
                          setMineChosen(false);
                          setAddrText(displayAddress(to, v.address));
                          setDest({kind: 'address'});
                          setPicker(null);
                        }}>
                        <NetworkIcon network={to} size={30} />
                        <View style={styles.pickCol}>
                          <Text style={styles.pickLabel} numberOfLines={1}>
                            {v.name}
                          </Text>
                          <Text style={styles.pickSub} numberOfLines={1}>
                            {shortAddress(displayAddress(to, v.address))}
                          </Text>
                        </View>
                        {on ? <Check color={c.accent} /> : null}
                      </Pressable>
                    );
                  })}
                  {payeesTo.length > 0 ? <Text style={styles.pickSection}>{t('mobile.payments.whitelisted_book')}</Text> : null}
                  {payeesTo.map((b) => {
                    const ok = payeeNow(b);
                    return (
                      <Pressable
                        key={b.id}
                        disabled={!ok}
                        style={[styles.pickRow, !ok && styles.dim]}
                        onPress={() => (setDest({kind: 'payee', id: b.id}), setPicker(null))}>
                        <View style={styles.pickGlyph}>
                          <Text style={styles.pickGlyphText}>{payeeName(b).slice(0, 1).toUpperCase()}</Text>
                        </View>
                        <View style={styles.pickCol}>
                          <Text style={styles.pickLabel} numberOfLines={1}>
                            {payeeName(b)}
                          </Text>
                          <Text style={styles.pickSub} numberOfLines={1}>
                            {ok ? shortAddress(displayAddress(to, b.recipientAddress)) : t('mobile.bridge.payee_not_yet')}
                          </Text>
                        </View>
                        {dest.kind === 'payee' && dest.id === b.id ? <Check color={c.accent} /> : null}
                      </Pressable>
                    );
                  })}
                </>
              )
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
      <QrScanner
        visible={scanning}
        onScan={(a) => {
          setScanning(false);
          setAddrText(to ? displayAddress(to, a) : a);
        }}
        onClose={() => setScanning(false)}
      />
    </View>
  );
}

function PersonIcon({color}: {color: string}) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function Chevron({color}: {color: string}) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path d="M9 6l6 6-6 6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
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
function VaultAddr({address, styles, copy}: {address: Address; styles: ReturnType<typeof makeStyles>; copy?: boolean}) {
  return (
    <View style={styles.vaultAddrLine}>
      <Text style={styles.vaultAddr} numberOfLines={1}>
        {shortAddress(asShown(address))}
      </Text>
      {/* The From side only: it is the owner's own address, the one worth copying. */}
      {copy ? <CopyButton address={address} size={12} /> : null}
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
    approx: {color: c.subtext, fontSize: 17},
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
    pickCol: {flex: 1, minWidth: 0, gap: 2},
    pickGlyph: {width: 30, height: 30, borderRadius: 15, backgroundColor: c.neutralSoft, alignItems: 'center', justifyContent: 'center'},
    pickGlyphText: {color: c.text, fontSize: 12, fontWeight: '700'},
    recipRow: {flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48},
    recipLabel: {color: c.subtext, fontSize: 14},
    recipValue: {flex: 1, minWidth: 0, color: c.text, fontSize: 15, fontWeight: '600', textAlign: 'right'},
    addrInput: {flex: 1, minWidth: 0, color: c.text, fontSize: 13, paddingVertical: 4},
    payeeChosen: {flex: 1, minWidth: 0, color: c.text, fontSize: 13, fontWeight: '600'},
    // The recipient on the To row, after the network: the rest of the row, the camera at its end.
    scanEnd: {marginVertical: -8, marginRight: -12, marginLeft: -8},
    pickSection: {color: c.subtext, fontSize: 13, fontWeight: '600', paddingHorizontal: 4, paddingTop: 14, paddingBottom: 6},
    headRecipAddr: {flex: 1, minWidth: 0, flexDirection: 'row', justifyContent: 'flex-end'},
    headRecip: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8},
  });

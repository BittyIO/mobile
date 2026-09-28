import {useHeaderHeight} from '@react-navigation/elements';
import React, {useEffect, useMemo, useState} from 'react';
import {Animated, InputAccessoryView, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import Svg, {Circle, Line} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {ConfirmButton} from '@/components/Button';
import {useSlideUp} from '@/components/useSlideUp';
import {showTx, showToast, ToastHost} from '@/components/Toast';
import {AssetPicker} from '@/components/AssetPicker';
import {PriceChart} from '@/components/PriceChart';
import {Pill} from '@/components/ui';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {usePrices} from '@/vault/usePrices';
import {ownerVaultAddress, balanceOfSymbol} from '@/vault/read';
import {marketSell, buildMarketSell, poolSpotPrice} from '@/vault/trade';
import {relayVaultMulticall, type VaultCall} from '@/vault/relay';
import {placeLimitOrder, prepareIntent, cancelLimitOrders, fetchRecentOrders, fetchSettlements, type CowOrder, type SettlementMeta} from '@/vault/limit';
import {EXPLORER_TX} from '@/core/chain';
import {placeTwap} from '@/vault/twap';
import {fetchMarketTrades, type MarketTrade} from '@/vault/market-trades';
import {fetchYielding, type Yielding} from '@/vault/yielding';
import {adapterByName} from '@/core/protocols';
import {ASSETS, assetMeta} from '@/core/assets';
import {VAULT_DEFI_ABI} from '@/core/abi';
import {fmtNum, displaySymbol} from '@/core/format';
import {formatUnits, parseUnits, type Address} from 'viem';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

const SLIPPAGE_BPS = 100; // 1%
const KB_ID = 'trade-number-kb'; // links the numeric inputs to their Done accessory bar
type Mode = 'Market' | 'Limit' | 'TWAP';
type Side = 'buy' | 'sell';
type Tab = 'open' | 'finished' | 'cancelled';
// "Valid for" presets, matching the web: Limit adds a 5-minute quick-fill + 180D; TWAP runs over a wider
// horizon (no 5m). Keyed by seconds so switching modes keeps the selection consistent. The label is
// `n` + the translated unit abbreviation ("5m", "1D").
const MIN = 'vault.minute_abbrev';
const DAY = 'vault.day_abbrev';
const LIMIT_VALID = [
  {n: 5, unit: MIN, s: 300},
  {n: 1, unit: DAY, s: 86400},
  {n: 7, unit: DAY, s: 604800},
  {n: 30, unit: DAY, s: 2592000},
  {n: 180, unit: DAY, s: 15552000},
];
const TWAP_VALID = [
  {n: 1, unit: DAY, s: 86400},
  {n: 7, unit: DAY, s: 604800},
  {n: 30, unit: DAY, s: 2592000},
  {n: 180, unit: DAY, s: 15552000},
];

function SearchIcon({color, size = 15}: {color: string; size?: number}) {
  const c = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={11} cy={11} r={7} {...c} />
      <Line x1={21} y1={21} x2={16.65} y2={16.65} {...c} />
    </Svg>
  );
}

// CoW's account endpoint keeps reporting an order as "open" for a while after its validTo passes, so an
// order that's really done would stay stuck under Open and never reach Finished. Treat a past-validTo
// "open" order as expired here so it buckets correctly.
const effectiveStatus = (o: CowOrder, cancelled?: Set<string>): string => {
  // CoW's orderbook keeps reporting an order as open for a while after its on-chain invalidation, so
  // an order this session cancelled is shown as cancelled straight away, whatever the API says.
  if (cancelled?.has(o.uid.toLowerCase()) && o.status === 'open') return 'cancelled';
  return o.status === 'open' && o.validTo * 1000 < Date.now() ? 'expired' : o.status;
};

const orderBucket = (s: string): Tab => {
  const x = s.toLowerCase();
  if (x.includes('cancel')) return 'cancelled';
  if (x.includes('fulfil') || x.includes('filled') || x.includes('expire')) return 'finished';
  return 'open';
};
// Returns the translation key for the pill label; the caller resolves it with `t`.
function statusPill(s: string): {key: string; tone: 'sky' | 'green' | 'gray' | 'amber'} {
  const x = s.toLowerCase();
  if (x.includes('fulfil') || x.includes('filled')) return {key: 'vault.fulfilled', tone: 'green'};
  if (x.includes('cancel')) return {key: 'vault.cancelled', tone: 'gray'};
  if (x.includes('expire')) return {key: 'vault.expired', tone: 'amber'};
  return {key: 'vault.open', tone: 'sky'};
}

// CoW's partner fee is baked into the on-chain amounts (buy grosses up the sell side; sell discounts the
// buy side); back it out so the displayed price matches what the user entered. Display-only.
const PARTNER_FEE = 0.002;

const fmtN = fmtNum;
const fmtAmt = (raw: string, decimals: number): string => fmtN(Number(formatUnits(BigInt(raw), decimals)));

const fmtExpiry = (validTo: number): string =>
  new Date(validTo * 1000).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

/**
 * Trade — web-mobile layout: pair + asset search, price chart, then the ORDERS list (Open / Finished /
 * Cancelled). A fixed Buy/Sell bar sits at the bottom; pressing either opens the order form as a bottom
 * sheet (Market / Limit / TWAP) pre-set to that side. Market swaps via Uniswap V3; Limit/TWAP post CoW
 * intents (relayer approved once per sell token). All relayed, signed on-device.
 */
export function TradeScreen() {
  const headerHeight = useHeaderHeight();
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const account = useWallet((s) => s.account);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const assets = ASSETS[network];
  const stables = useMemo(() => assets.filter((a) => a.kind === 'stable'), [assets]);

  const [baseSym, setBaseSym] = useState(assets.find((a) => a.kind !== 'stable')?.symbol ?? 'WETH');
  const [quoteSym, setQuoteSym] = useState(stables[0]?.symbol ?? 'USDC');
  // A network switch keeps the pair only where both sides exist there. Robinhood has no USDC or USDT,
  // so a USDC quote becomes USDG on arrival, and USDG becomes USDC again on the way back; a base the
  // new network lacks falls back to its first non-stable asset.
  useEffect(() => {
    if (!assets.some((a) => a.symbol === baseSym)) setBaseSym(assets.find((a) => a.kind !== 'stable')?.symbol ?? assets[0]?.symbol ?? 'WETH');
    if (!stables.some((s) => s.symbol === quoteSym)) setQuoteSym(stables[0]?.symbol ?? 'USDC');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('open');

  // Order form (in the bottom sheet)
  const [sheetSide, setSheetSide] = useState<Side | null>(null);
  const [mode, setMode] = useState<Mode>('Market');
  const [amount, setAmount] = useState('');
  const [receiveInput, setReceiveInput] = useState('');
  const [price, setPrice] = useState('');
  const [priceEdited, setPriceEdited] = useState(false);
  const [parts, setParts] = useState('10');
  const [validSec, setValidSec] = useState(86400); // 1D — in both preset sets
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const [orders, setOrders] = useState<CowOrder[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancellingAll, setCancellingAll] = useState(false);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(true);
  const [marketTrades, setMarketTrades] = useState<MarketTrade[]>([]);

  const balances = useVaultBalances(network);
  // Pull-to-refresh: re-reads prices, the pool quote, the chart, balances and orders together.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [pulled, setPulled] = useState(false);
  const prices = usePrices(network, refreshNonce);
  const base = assets.find((a) => a.symbol === baseSym);
  const intent = adapterByName(network, 'CoW Swap');

  // The vault's Sky (sUSDS) balance = "yielding USDC". Loaded with the vault balances. There's no separate
  // yielding quote: when you pay USDC and free USDC is short, we auto-withdraw the shortfall from Sky.
  const [yld, setYld] = useState<Yielding | null>(null);
  useEffect(() => {
    let live = true;
    if (balances.vault) fetchYielding(balances.vault, network).then((y) => live && setYld(y)).catch(() => live && setYld(null));
    else setYld(null);
    return () => {
      live = false;
    };
  }, [balances.vault, network, balances.balances]);

  const usdcAsset = useMemo(() => stables.find((s) => s.symbol === 'USDC') ?? stables[0], [stables]);
  const quoteAsset = assets.find((a) => a.symbol === quoteSym);

  // Order-form denomination: you always enter the PAY leg. A sell pays the base (e.g. ETH); a buy pays
  // the quote (e.g. USDC). So the Amount field + Max button sit on a DIFFERENT asset per side.
  const paysBase = sheetSide !== 'buy';
  const spendSym = paysBase ? baseSym : quoteSym;
  const recvSym = paysBase ? quoteSym : baseSym;
  const freeSpend = balanceOfSymbol(balances.balances, spendSym);
  // Paying USDC can also draw on the vault's yielding USDC (auto-withdrawn on submit), so it's spendable.
  const yieldAvail = !paysBase && quoteSym === 'USDC' && yld ? yld.usdc : 0;
  const spendBal = yieldAvail > 0 ? String(Number(freeSpend) + yieldAvail) : freeSpend;
  // More than the vault can pay: flagged as the user types, and the order is not sent.
  const overBalance = !balances.loading && Number(amount) > 0 && Number(amount) > Number(spendBal);

  // Off-chain oracle price (CoinGecko) — only a fast-loading fallback for the display before the pool
  // quote lands. NEVER used for the trade itself: on a testnet it's the mainnet price and diverges from
  // the pool the swap actually routes through.
  const oraclePrice = useMemo(() => {
    const b = prices.get(baseSym);
    const q = prices.get(quoteSym);
    if (!b) return null;
    return q ? b / q : b;
  }, [prices, baseSym, quoteSym]);

  // Live Uniswap pool price (quote per 1 base) for THIS network's pool — the price the market swap
  // executes at. Re-quoted whenever the pair or network changes.
  const [poolPrice, setPoolPrice] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    setPoolPrice(null);
    if (base && quoteAsset) {
      poolSpotPrice(network, base.address, quoteAsset.address)
        .then((p) => live && setPoolPrice(p))
        .catch(() => live && setPoolPrice(null));
    }
    return () => {
      live = false;
    };
  }, [network, base?.address, quoteAsset?.address, refreshNonce]);

  // The pool price is authoritative; fall back to the oracle only until the quote arrives.
  const pairPrice = poolPrice ?? oraclePrice;

  // Settlement tx per filled order, so a finished order can link to the transaction that executed it.
  const [settlements, setSettlements] = useState<Map<string, SettlementMeta>>(() => new Map());
  const settlementTxFor = (uid: string): string | null => {
    for (const [hash, m] of settlements) if (m.orderUid.toLowerCase() === uid.toLowerCase()) return hash;
    return null;
  };
  const refreshOrders = () => {
    if (!owner) return;
    const vault = ownerVaultAddress(owner, network);
    fetchRecentOrders(vault, network).then(setOrders).catch(() => setOrders([]));
    fetchSettlements(vault, network).then(setSettlements).catch(() => setSettlements(new Map()));
    // Completed market swaps leave no order record — they're recovered from the vault's transfer feed.
    fetchMarketTrades(vault, network).then(setMarketTrades).catch(() => setMarketTrades([]));
  };
  // Orders cancelled in this session, applied over the orderbook until it catches up.
  const [cancelledUids, setCancelledUids] = useState<Set<string>>(() => new Set());
  const markCancelled = (uids: string[]) => {
    setCancelledUids((cur) => {
      const next = new Set(cur);
      for (const u of uids) next.add(u.toLowerCase());
      return next;
    });
    // The orderbook lags the chain: refresh now and again shortly after, so the list settles on its
    // own once CoW has indexed the invalidation.
    refreshOrders();
    for (const ms of [2000, 6000]) setTimeout(refreshOrders, ms);
  };
  useEffect(refreshOrders, [owner, network, status]);
  // Poll so a fill / expiry moves an order out of Open without needing a remount.
  useEffect(() => {
    const id = setInterval(refreshOrders, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, network]);

  const selectAsset = (sym: string) => {
    setBaseSym(sym);
    if (sym === quoteSym) {
      const other = stables.find((s) => s.symbol !== sym);
      if (other) setQuoteSym(other.symbol);
    }
    setSearch('');
  };
  const searchResults = search.trim()
    ? assets
        .filter((a) => {
          const q = search.trim().toLowerCase();
          return a.symbol.toLowerCase().includes(q) || (a.company ?? '').toLowerCase().includes(q);
        })
        .slice(0, 8)
    : [];

  // Asset pickers: a sheet with icons, for the base and the quote side of the pair.
  const [picker, setPicker] = useState<'base' | 'quote' | null>(null);
  const pickBase = () => setPicker('base');
  const pickQuote = () => setPicker('quote');
  const pickerAssets = picker === 'quote' ? stables.filter((s) => s.symbol !== baseSym) : assets.filter((a) => a.symbol !== quoteSym);

  // Plain (no thousands separators, so Number() round-trips) price string for the input default.
  const priceToInput = (p: number) => (p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toPrecision(4));

  const openSheet = (side: Side) => {
    setSheetSide(side);
    setStatus('idle');
    setErr(null);
    setAmount('');
    setReceiveInput('');
    setPriceEdited(false);
    setPrice(pairPrice ? priceToInput(pairPrice) : '');
  };

  // Seed the Limit/TWAP price with the live pair price — and re-seed when the authoritative pool price
  // arrives (it can replace a fast oracle fallback), as long as the user hasn't typed their own.
  useEffect(() => {
    if (sheetSide && !priceEdited && pairPrice) setPrice(priceToInput(pairPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetSide, pairPrice, priceEdited]);

  // Price is always quote-per-base. Market prices strictly off the POOL (what it executes at); Limit/TWAP
  // use the entered price. The receive leg follows from the pay leg: sell → quote = base×price, buy →
  // base = quote÷price.
  const effPrice = mode === 'Market' ? poolPrice ?? 0 : Number(price) || 0;

  // Pay ⇄ Receive are both editable and kept in sync through the price. sell: receive = pay×price;
  // buy: receive = pay÷price (and the inverse when the user edits Receive).
  const toField = (n: number): string => (!isFinite(n) || n <= 0 ? '' : String(Number(n < 1 ? n.toPrecision(6) : n.toFixed(6))));
  const applyPay = (t: string) => {
    setAmount(t);
    const p = Number(t);
    setReceiveInput(effPrice > 0 && p > 0 ? toField(paysBase ? p * effPrice : p / effPrice) : '');
  };
  const applyReceive = (t: string) => {
    setReceiveInput(t);
    const r = Number(t);
    setAmount(effPrice > 0 && r > 0 ? toField(paysBase ? r / effPrice : r * effPrice) : '');
  };
  // Re-derive Receive from the pay amount whenever the price or side changes (a Limit price edit, the
  // pool quote landing, or a Buy/Sell flip), so the two stay consistent without a feedback loop.
  useEffect(() => {
    if (!sheetSide) return;
    const p = Number(amount);
    if (effPrice > 0 && p > 0) setReceiveInput(toField(paysBase ? p * effPrice : p / effPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effPrice, paysBase, sheetSide]);

  // The gasless relay fee is paid from a vault stablecoin. Prefer a HELD stablecoin that isn't the coin
  // being spent as the pay leg — so maxing USDC still leaves USDT to cover gas. Falls back to any held
  // stablecoin, then the quote.
  const pickFeeCoin = (excludeAddr?: string): Address => {
    const held = stables.filter((s) => Number(balanceOfSymbol(balances.balances, s.symbol)) > 0);
    const ex = excludeAddr?.toLowerCase();
    const preferred = ex ? held.find((s) => s.address.toLowerCase() !== ex) : held[0];
    return ((preferred ?? held[0] ?? quoteAsset)?.address ?? quoteSym) as Address;
  };

  // The same checks onSubmit makes, so the button is disabled rather than erroring on tap.
  const canConfirm =
    !!sheetSide && !!account && !!owner && !!base && !!quoteAsset &&
    Number(amount) > 0 &&
    (mode === 'Market' || Number(price) > 0) &&
    (mode !== 'TWAP' || Number(parts) >= 2) &&
    !overBalance;

  const onSubmit = async () => {
    const side = sheetSide;
    if (!side || !account || !owner || !base || !quoteAsset) return;
    if (!(Number(amount) > 0)) return setErr(t('vault.enter_amount')), setStatus('error');
    if (mode !== 'Market' && !(Number(price) > 0)) return setErr(t('vault.enter_limit_price')), setStatus('error');
    if (overBalance) return setErr(t('vault.insufficient_balance', {token: displaySymbol(spendSym)})), setStatus('error');
    setStatus('busy');
    setErr(null);
    // "Buy 0.1 ETH" / "Sell 100 USDC" — the order in the user's words, not the tx.
    const tx = showTx(`${side === 'buy' ? t('vault.buy') : t('vault.sell')} ${amount} ${displaySymbol(spendSym)}`, network);
    try {
      const acct = await getSigner();
      const vault = ownerVaultAddress(owner, network);
      // You always sell the PAY leg for the RECEIVE leg: sell base→quote, buy quote→base. Exact-in.
      const spendAsset = (paysBase ? base : quoteAsset);
      const recvAsset = (paysBase ? quoteAsset : base);
      const sellToken = spendAsset.address as Address;
      const buyToken = recvAsset.address as Address;
      // Charge gas to a stablecoin that isn't the pay leg (so a max-USDC trade pays gas from USDT).
      const feeCoin = pickFeeCoin(sellToken);

      // Paying USDC can draw on the vault's yielding USDC: if free USDC is short of the amount, withdraw the
      // shortfall from Sky (rounded up so the swap has enough) — bundled into the same tx. No separate quote.
      const payUsdc = !paysBase && quoteAsset.symbol === 'USDC' && !!yld;
      const freeUsdc = payUsdc ? Number(balanceOfSymbol(balances.balances, 'USDC')) : 0;
      const shortfall = payUsdc && Number(amount) > freeUsdc ? Math.min(Math.ceil((Number(amount) - freeUsdc) * 1e6) / 1e6, yld!.usdc) : 0;
      const sky = shortfall > 0 ? adapterByName(network, 'Sky') : null;
      const withdrawCalls: VaultCall[] =
        shortfall > 0 && sky
          ? [{abi: VAULT_DEFI_ABI, functionName: 'withdraw', args: [sky, quoteAsset.address, parseUnits(shortfall.toFixed(quoteAsset.decimals), quoteAsset.decimals)]}]
          : [];

      if (mode === 'Market') {
        if (withdrawCalls.length) {
          // Top up USDC from Sky, then market-buy the base with it — one multicall. Fee is charged in USDC.
          const {setup, swap} = await buildMarketSell({network, vault, sellToken, buyToken, sellAmount: amount, slippageBps: SLIPPAGE_BPS});
          await relayVaultMulticall({account: acct, vault, network, calls: [...withdrawCalls, ...setup, swap], stableCoin: quoteAsset.address});
        } else {
          // marketSell bundles any required allowlist setup ahead of the swap; exact-in, works both sides.
          await marketSell({account: acct, vault, network, sellToken, buyToken, sellAmount: amount, slippageBps: SLIPPAGE_BPS, stableCoin: feeCoin});
        }
      } else {
        if (!intent) throw new Error(t('mobile.trade.cow_unavailable'));
        // Bundle the one-time setup (allowlist assets, register the intent adapter so the vault clones it,
        // approve the relayer) — plus any Sky top-up — into a single mined tx before posting, so the USDC is
        // in the vault when the order settles.
        const needApprove = !approved.has(sellToken.toLowerCase());
        await prepareIntent({account: acct, vault, network, intentProtocol: intent, tokens: [sellToken, buyToken], approveToken: needApprove ? sellToken : undefined, stableCoin: withdrawCalls.length ? quoteAsset.address : feeCoin, preCalls: withdrawCalls});
        if (needApprove) setApproved((p) => new Set(p).add(sellToken.toLowerCase()));
        // Minimum received (what the user wants), in the receive leg's units. Falls back to the
        // price-derived amount if they left the field to auto-fill. Bounded decimals so parseUnits round-trips.
        const recvNum = Number(receiveInput) > 0 ? Number(receiveInput) : effPrice > 0 && Number(amount) > 0 ? (paysBase ? Number(amount) * effPrice : Number(amount) / effPrice) : 0;
        if (!(recvNum > 0)) {
          setErr(t('mobile.trade.enter_receive'));
          setStatus('error');
          return;
        }
        const minRecv = recvNum.toFixed(Math.min(recvAsset.decimals, 8));
        if (mode === 'Limit') {
          await placeLimitOrder({account: acct, vault, network, sellToken, buyToken, sellAmount: amount, buyAmount: minRecv, kind: 'sell', validSeconds: validSec});
        } else {
          const n = Math.max(1, parseInt(parts || '1', 10));
          await placeTwap({account: acct, vault, network, sellToken, buyToken, totalSell: amount, totalMinBuy: minRecv, parts: n, partDuration: Math.max(60, Math.floor(validSec / n))});
        }
      }
      tx.success();
      setStatus('done');
      setSheetSide(null);
      refreshOrders();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      tx.error(msg);
      setErr(msg);
      setStatus('error');
    }
  };

  const onCancel = async (o: CowOrder) => {
    if (!owner || !quoteAsset) return;
    if (!intent) return showToast('error', t('mobile.trade.cannot_cancel'), t('mobile.trade.cow_unavailable'));
    setCancelling(o.uid);
    const tx = showTx(t('mobile.actions.cancel_intent'), network);
    try {
      const acct = await getSigner();
      tx.success(await cancelLimitOrders({account: acct, vault: ownerVaultAddress(owner, network), network, intentProtocol: intent, uids: [o.uid as `0x${string}`], stableCoin: pickFeeCoin()}));
      markCancelled([o.uid]);
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setCancelling(null);
    }
  };

  const onCancelAll = async (uids: string[]) => {
    if (!owner || !quoteAsset || uids.length === 0) return;
    if (!intent) return showToast('error', t('mobile.trade.cannot_cancel'), t('mobile.trade.cow_unavailable'));
    setCancellingAll(true);
    const tx = showTx(t('mobile.actions.cancel_intents', {count: uids.length}), network);
    try {
      const acct = await getSigner();
      tx.success(await cancelLimitOrders({account: acct, vault: ownerVaultAddress(owner, network), network, intentProtocol: intent, uids: uids as `0x${string}`[], stableCoin: pickFeeCoin()}));
      markCancelled(uids);
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setCancellingAll(false);
    }
  };

  // Only orders/trades for the current pair unless "Show others" is on.
  const pairSet = new Set([base?.address.toLowerCase(), quoteAsset?.address.toLowerCase()]);
  const inPair = (o: CowOrder): boolean => pairSet.has(o.sellToken.toLowerCase()) && pairSet.has(o.buyToken.toLowerCase());
  const marketInPair = (m: MarketTrade): boolean => pairSet.has(m.sold.address.toLowerCase()) && pairSet.has(m.bought.address.toLowerCase());
  const visibleOrders = showOthers ? orders : orders.filter(inPair);
  // Market swaps are always complete → they belong under Finished.
  const marketFinished = showOthers ? marketTrades : marketTrades.filter(marketInPair);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = {open: 0, finished: 0, cancelled: 0};
    visibleOrders.forEach((o) => (c[orderBucket(effectiveStatus(o, cancelledUids))] += 1));
    c.finished += marketFinished.length;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleOrders, marketFinished]);
  const shownOrders = visibleOrders.filter((o) => orderBucket(effectiveStatus(o, cancelledUids)) === tab);
  const openUids = visibleOrders.filter((o) => effectiveStatus(o, cancelledUids) === 'open').map((o) => o.uid);
  const TABS: {key: Tab; label: string}[] = [
    {key: 'open', label: t('vault.orders_open_short')},
    {key: 'finished', label: t('vault.orders_finished_short')},
    {key: 'cancelled', label: t('vault.orders_cancelled_short')},
  ];
  const MODES: {key: Mode; label: string}[] = [
    {key: 'Market', label: t('vault.market')},
    {key: 'Limit', label: t('vault.limit')},
    {key: 'TWAP', label: t('vault.twap')},
  ];
  const busy = status === 'busy';
  const sheetSlide = useSlideUp(sheetSide != null);

  const onPull = () => {
    setPulled(true);
    setRefreshNonce((n) => n + 1);
    balances.refresh();
    refreshOrders();
    // The reads are short; the spinner clears on its own rather than waiting on each of them.
    setTimeout(() => setPulled(false), 1200);
  };

  return (
    <>
      <ScrollView showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        contentContainerStyle={[styles.body, {paddingTop: 8}]}
        contentInset={{top: headerHeight}}
        contentOffset={{x: 0, y: -headerHeight}}
        scrollIndicatorInsets={{top: headerHeight}}
        automaticallyAdjustContentInsets={false}
        refreshControl={<RefreshControl refreshing={pulled} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled">
        {/* Pair + asset search */}
        <View style={styles.headerRow}>
          <View style={styles.pair}>
            <Pressable style={styles.pairPart} onPress={pickBase}>
              <TokenIcon symbol={baseSym} size={28} />
              <Text style={styles.pairText}>{displaySymbol(baseSym)}</Text>
            </Pressable>
            <Text style={styles.pairSlash}>/</Text>
            <Pressable style={styles.pairPart} onPress={pickQuote}>
              <TokenIcon symbol={quoteSym} size={28} />
              <Text style={styles.pairText}>{displaySymbol(quoteSym)}</Text>
            </Pressable>
          </View>
          <View style={styles.search}>
            <SearchIcon color={c.subtext} />
            <TextInput style={styles.searchInput} placeholder={t('vault.search_assets')} placeholderTextColor={c.subtext} autoCapitalize="characters" autoCorrect={false} value={search} onChangeText={setSearch} />
          </View>
        </View>

        {searchResults.length > 0 ? (
          <View style={styles.card}>
            {searchResults.map((a) => (
              <Pressable key={a.symbol} style={styles.resultRow} onPress={() => selectAsset(a.symbol)}>
                <TokenIcon symbol={a.symbol} size={22} />
                <Text style={styles.resultText}>{displaySymbol(a.symbol)}</Text>
                {a.company ? (
                  <Text style={styles.resultCompany} numberOfLines={1}>
                    {a.company}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : null}

        <PriceChart key={`${baseSym}-${refreshNonce}`} symbol={baseSym} />

        {/* Orders */}
        <View style={styles.card}>
          <View style={styles.orderTabs}>
            <View style={styles.orderTabsLeft}>
              {TABS.map((t) => (
                <Pressable key={t.key} onPress={() => setTab(t.key)} hitSlop={6}>
                  <Text style={[styles.orderTabText, tab === t.key && styles.orderTabOn]}>
                    {t.label}
                    {counts[t.key] > 0 ? ` (${counts[t.key]})` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={styles.othersToggle} onPress={() => setShowOthers((v) => !v)} hitSlop={6}>
              <View style={[styles.checkbox, showOthers && styles.checkboxOn]}>{showOthers ? <Text style={styles.checkboxTick}>✓</Text> : null}</View>
              <Text style={styles.othersText}>{t('mobile.trade.others')}</Text>
            </Pressable>
          </View>

          {tab === 'open' && openUids.length > 1 ? (
            <Pressable style={styles.cancelAllRow} onPress={() => onCancelAll(openUids)} disabled={cancellingAll} hitSlop={6}>
              <Text style={styles.cancelAllText}>{cancellingAll ? t('mobile.trade.cancelling_all') : `${t('vault.cancel_all')} (${openUids.length})`}</Text>
            </Pressable>
          ) : null}

          {shownOrders.length === 0 && !(tab === 'finished' && marketFinished.length > 0) ? (
            <Text style={styles.empty}>{t(`mobile.trade.no_${tab}_orders`)}</Text>
          ) : (
            shownOrders.slice(0, 30).map((o, i, arr) => {
              // The card's own padding frames the list: the last row adds no bottom padding.
              const isLast = i === arr.length - 1 && !(tab === 'finished' && marketFinished.length > 0);
              const es = effectiveStatus(o, cancelledUids);
              const sp = statusPill(es);
              const sellM = assetMeta(network, o.sellToken as Address);
              const buyM = assetMeta(network, o.buyToken as Address);
              const sellNum = Number(formatUnits(BigInt(o.sellAmount), sellM.decimals));
              const buyNum = Number(formatUnits(BigInt(o.buyAmount), buyM.decimals));
              // Price quoted in the stable leg when there is one, else base-per-quote by side.
              const sellIsStable = stables.some((s) => s.address.toLowerCase() === o.sellToken.toLowerCase());
              const buyIsStable = stables.some((s) => s.address.toLowerCase() === o.buyToken.toLowerCase());
              let px: number;
              let pxSym: string;
              if (sellIsStable || buyIsStable) {
                px = (sellIsStable ? sellNum : buyNum) / (sellIsStable ? buyNum : sellNum);
                pxSym = sellIsStable ? sellM.symbol : buyM.symbol;
              } else {
                px = o.kind === 'buy' ? sellNum / buyNum : buyNum / sellNum;
                pxSym = o.kind === 'buy' ? sellM.symbol : buyM.symbol;
              }
              px = px / (o.kind === 'buy' ? 1 + PARTNER_FEE : 1 - PARTNER_FEE);
              const isBuy = o.kind === 'buy';
              // All rows collapse by default; tap to expand (open rows reveal their Cancel button).
              const isExp = expanded === o.uid;
              const canCancel = es === 'open' && !!intent;
              return (
                <View key={o.uid} style={styles.orderCard}>
                  <Pressable
                    style={[styles.orderHead, isLast && !isExp && styles.noBottom]}
                    onPress={() => setExpanded(expanded === o.uid ? null : o.uid)}>
                    <View style={styles.orderHeadLeft}>
                      <View style={[styles.kindBadge, {backgroundColor: isBuy ? c.successSoft : c.dangerSoft}]}>
                        <Text style={[styles.kindText, {color: isBuy ? c.success : c.danger}]}>{isBuy ? t('vault.buy') : t('vault.sell')}</Text>
                      </View>
                      <Text style={styles.orderSummary} numberOfLines={1}>
                        <Amount v={fmtAmt(o.sellAmount, sellM.decimals)} /> {displaySymbol(sellM.symbol)} → <Amount v={fmtAmt(o.buyAmount, buyM.decimals)} /> {displaySymbol(buyM.symbol)}
                      </Text>
                    </View>
                    {/* Open and Filled are what the tab already says, so an open order shows its Cancel
                        here instead; Expired stays as a pill (the Cancelled tab holds both cancelled and
                        expired orders). */}
                    {canCancel ? (
                      <Pressable
                        style={styles.orderHeadRight}
                        onPress={(e) => {
                          e.stopPropagation();
                          void onCancel(o);
                        }}
                        disabled={cancelling === o.uid}
                        hitSlop={8}>
                        <Text style={styles.cancelInline}>{cancelling === o.uid ? t('mobile.trade.cancelling') : t('common.cancel')}</Text>
                      </Pressable>
                    ) : sp.tone === 'amber' ? (
                      <View style={styles.orderHeadRight}>
                        <Pill label={t(sp.key)} tone={sp.tone} />
                      </View>
                    ) : settlementTxFor(o.uid) ? (
                      // Filled: link to the settlement transaction — the solver's execution, not the
                      // relayed approval that came before it.
                      <Pressable
                        style={styles.orderHeadRight}
                        onPress={(e) => {
                          e.stopPropagation();
                          void Linking.openURL(EXPLORER_TX[network] + settlementTxFor(o.uid));
                        }}
                        hitSlop={8}>
                        <Text style={styles.viewLink}>{t('mobile.home.view')} ↗</Text>
                      </Pressable>
                    ) : null}
                  </Pressable>

                  {isExp ? (
                    <View style={[styles.orderDetail, isLast && styles.noBottom]}>
                      <View style={styles.orderLine}>
                        <Text style={styles.orderLabel}>{t('vault.pay')}</Text>
                        <View style={styles.orderAmt}>
                          <Text style={styles.orderAmtVal}><Amount v={fmtAmt(o.sellAmount, sellM.decimals)} size={13} /></Text>
                          <TokenIcon symbol={sellM.symbol} size={16} />
                          <Text style={styles.orderAmtSym}>{displaySymbol(sellM.symbol)}</Text>
                        </View>
                      </View>
                      <View style={styles.orderLine}>
                        <Text style={styles.orderLabel}>{t('vault.receive')}</Text>
                        <View style={styles.orderAmt}>
                          <Text style={styles.orderAmtVal}><Amount v={fmtAmt(o.buyAmount, buyM.decimals)} size={13} /></Text>
                          <TokenIcon symbol={buyM.symbol} size={16} />
                          <Text style={styles.orderAmtSym}>{displaySymbol(buyM.symbol)}</Text>
                        </View>
                      </View>
                      <View style={styles.orderLine}>
                        <Text style={styles.orderLabel}>{t('vault.price')}</Text>
                        <Text style={styles.orderVal}>{px.toLocaleString('en-US', {maximumSignificantDigits: 6})} {pxSym}</Text>
                      </View>
                      <View style={styles.orderLine}>
                        <Text style={styles.orderLabel}>{t('vault.expires')}</Text>
                        <Text style={styles.orderVal}>{fmtExpiry(o.validTo)}</Text>
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })
          )}

          {/* Completed market swaps (Finished only) — recovered from the transfer feed, no order record. */}
          {tab === 'finished'
            ? marketFinished.slice(0, 30).map((m, i, arr) => {
                const isLast = i === arr.length - 1;
                const soldIsStable = stables.some((s) => s.address.toLowerCase() === m.sold.address.toLowerCase());
                const isBuy = soldIsStable; // spent a stablecoin to acquire the crypto leg
                const px = soldIsStable ? m.sold.amount / m.bought.amount : m.bought.amount / m.sold.amount;
                const pxSym = soldIsStable ? m.sold.symbol : m.bought.symbol;
                const isExp = expanded === m.txHash;
                return (
                  <View key={m.txHash} style={styles.orderCard}>
                    <Pressable style={[styles.orderHead, isLast && !isExp && styles.noBottom]} onPress={() => setExpanded(expanded === m.txHash ? null : m.txHash)}>
                      <View style={styles.orderHeadLeft}>
                        <View style={[styles.kindBadge, {backgroundColor: isBuy ? c.successSoft : c.dangerSoft}]}>
                          <Text style={[styles.kindText, {color: isBuy ? c.success : c.danger}]}>{isBuy ? t('vault.buy') : t('vault.sell')}</Text>
                        </View>
                        <View style={styles.marketTag}>
                          <Text style={styles.marketTagText}>{t('vault.market')}</Text>
                        </View>
                        <Text style={styles.orderSummary} numberOfLines={1}>
                          <Amount v={fmtN(m.sold.amount)} /> {displaySymbol(m.sold.symbol)} → <Amount v={fmtN(m.bought.amount)} /> {displaySymbol(m.bought.symbol)}
                        </Text>
                      </View>
                      <Pressable
                        style={styles.orderHeadRight}
                        onPress={(e) => {
                          e.stopPropagation();
                          void Linking.openURL(EXPLORER_TX[network] + m.txHash);
                        }}
                        hitSlop={8}>
                        <Text style={styles.viewLink}>{t('mobile.home.view')} ↗</Text>
                      </Pressable>
                    </Pressable>
                    {isExp ? (
                      <View style={[styles.orderDetail, isLast && styles.noBottom]}>
                        <View style={styles.orderLine}>
                          <Text style={styles.orderLabel}>{t('mobile.trade.paid')}</Text>
                          <View style={styles.orderAmt}>
                            <Text style={styles.orderAmtVal}><Amount v={fmtN(m.sold.amount)} size={13} /></Text>
                            <TokenIcon symbol={m.sold.symbol} size={16} />
                            <Text style={styles.orderAmtSym}>{displaySymbol(m.sold.symbol)}</Text>
                          </View>
                        </View>
                        <View style={styles.orderLine}>
                          <Text style={styles.orderLabel}>{t('vault.received')}</Text>
                          <View style={styles.orderAmt}>
                            <Text style={styles.orderAmtVal}><Amount v={fmtN(m.bought.amount)} size={13} /></Text>
                            <TokenIcon symbol={m.bought.symbol} size={16} />
                            <Text style={styles.orderAmtSym}>{displaySymbol(m.bought.symbol)}</Text>
                          </View>
                        </View>
                        <View style={styles.orderLine}>
                          <Text style={styles.orderLabel}>{t('vault.price')}</Text>
                          <Text style={styles.orderVal}>{px.toLocaleString('en-US', {maximumSignificantDigits: 6})} {pxSym}</Text>
                        </View>
                        {m.ts ? (
                          <View style={styles.orderLine}>
                            <Text style={styles.orderLabel}>{t('vault.fulfilled')}</Text>
                            <Text style={styles.orderVal}>{fmtExpiry(m.ts)}</Text>
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })
            : null}
        </View>
      </ScrollView>

      {/* Fixed Buy / Sell bar. */}
      <View style={styles.bar}>
        <Pressable style={[styles.barBtn, {backgroundColor: c.buy}]} onPress={() => openSheet('buy')}>
          <Text style={styles.barText}>{t('vault.buy')}</Text>
        </Pressable>
        <Pressable style={[styles.barBtn, {backgroundColor: c.sell}]} onPress={() => openSheet('sell')}>
          <Text style={styles.barText}>{t('vault.sell')}</Text>
        </Pressable>
      </View>

      {/* Order form bottom sheet */}
      <Modal transparent visible={sheetSide != null} animationType="none" onRequestClose={() => setSheetSide(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => !busy && setSheetSide(null)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Animated.View style={sheetSlide}>
            <Pressable style={styles.sheet} onPress={() => Keyboard.dismiss()}>
            {/* The sheet's side is already the button the user pressed, and the submit button repeats it, so
                the head carries only the close control. */}
            <View style={styles.sheetHead}>
              <Pressable onPress={() => !busy && setSheetSide(null)} hitSlop={10}>
                <Text style={styles.sheetClose}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.segTrack}>
              {MODES.map((m) => (
                <Pressable key={m.key} style={[styles.segBtn, mode === m.key && styles.segOn]} onPress={() => setMode(m.key)}>
                  <Text style={[styles.segText, mode === m.key && styles.segTextOn]}>{m.label}</Text>
                </Pressable>
              ))}
            </View>

            {/* Amount (base) */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{sheetSide === 'buy' ? t('vault.you_pay') : t('vault.trade_amount')}</Text>
              <View style={styles.fieldRight}>
                <TextInput style={[styles.fieldInput, overBalance && styles.fieldInputOver]} keyboardType="decimal-pad" inputAccessoryViewID={KB_ID} placeholder="0" placeholderTextColor={c.subtext} value={amount} onChangeText={applyPay} />
                {Number(spendBal) > 0 ? (
                  <Pressable onPress={() => applyPay(spendBal)} style={styles.maxPill}>
                    <Text style={styles.maxText}>{t('common.max')}</Text>
                  </Pressable>
                ) : null}
                <TokenIcon symbol={spendSym} size={20} />
                <Text style={styles.fieldSym}>{displaySymbol(spendSym)}</Text>
              </View>
            </View>
            {overBalance ? (
              <Text style={styles.overText}>
                {t('vault.exceeds_balance')} · {t('vault.available')} <Amount v={fmtNum(Number(spendBal))} /> {displaySymbol(spendSym)}
              </Text>
            ) : Number(spendBal) > 0 ? (
              <Text style={styles.availText}>
                {t('vault.available')} <Amount v={fmtNum(Number(spendBal))} /> {displaySymbol(spendSym)}
                {yieldAvail > 0 ? ` ${t('mobile.trade.incl_yielding', {amount: fmtNum(yieldAvail)})}` : ''}
              </Text>
            ) : null}

            {mode !== 'Market' ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>{t('vault.price')}</Text>
                <View style={styles.fieldRight}>
                  <TextInput style={styles.fieldInput} keyboardType="decimal-pad" inputAccessoryViewID={KB_ID} placeholder="0" placeholderTextColor={c.subtext} value={price} onChangeText={(v) => { setPrice(v); setPriceEdited(true); }} />
                  <Text style={styles.fieldSym}>{displaySymbol(quoteSym)}</Text>
                </View>
              </View>
            ) : null}

            {mode === 'TWAP' ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>{t('vault.parts')}</Text>
                <View style={styles.fieldRight}>
                  <TextInput style={styles.fieldInput} keyboardType="number-pad" inputAccessoryViewID={KB_ID} value={parts} onChangeText={setParts} />
                </View>
              </View>
            ) : null}

            {/* Receive (the other leg) — editable; kept in sync with Amount through the price. */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t('vault.receive_amount')} {mode === 'Market' ? '≈' : '≥'}</Text>
              <View style={styles.fieldRight}>
                <TextInput style={styles.fieldInput} keyboardType="decimal-pad" inputAccessoryViewID={KB_ID} placeholder="0" placeholderTextColor={c.subtext} value={receiveInput} onChangeText={applyReceive} />
                <TokenIcon symbol={recvSym} size={20} />
                <Text style={styles.fieldSym}>{displaySymbol(recvSym)}</Text>
              </View>
            </View>

            {mode !== 'Market' ? (
              <View style={styles.validRow}>
                <Text style={styles.fieldLabel}>{mode === 'TWAP' ? t('mobile.trade.over') : t('vault.valid_for')}</Text>
                <View style={styles.validChips}>
                  {(mode === 'TWAP' ? TWAP_VALID : LIMIT_VALID).map((v) => (
                    <Pressable key={v.s} style={[styles.vchip, validSec === v.s && styles.vchipOn]} onPress={() => setValidSec(v.s)}>
                      <Text style={[styles.vchipText, validSec === v.s && styles.vchipTextOn]}>{`${v.n}${t(v.unit)}`}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            {status === 'error' && err ? <Text style={styles.err} selectable>{err}</Text> : null}

            <ConfirmButton onPress={onSubmit} loading={busy} disabled={!canConfirm} color={sheetSide === 'buy' ? c.buy : c.sell} style={styles.submit} />
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
      <AssetPicker
        visible={picker != null}
        title={picker === 'quote' ? t('mobile.trade.quote') : t('vault.select_asset')}
        assets={pickerAssets}
        selected={picker === 'quote' ? quoteSym : baseSym}
        onSelect={(sym) => (picker === 'quote' ? setQuoteSym(sym) : selectAsset(sym))}
        onClose={() => setPicker(null)}
      />
    </>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  kbBar: {backgroundColor: c.elevated, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'flex-end'},
  kbDone: {color: c.accent, fontSize: 16, fontWeight: '700'},
  body: {flexGrow: 1, padding: 16, gap: 14, paddingBottom: 24},
  headerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  pair: {flexDirection: 'row', alignItems: 'center', flexShrink: 1},
  pairPart: {flexDirection: 'row', alignItems: 'center', gap: 6},
  pairText: {color: c.text, fontSize: 20, fontWeight: '700'},
  pairSlash: {color: c.subtext, fontSize: 20, fontWeight: '600', marginHorizontal: 7},
  search: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.card, borderRadius: 19, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, height: 38, width: 130},
  searchInput: {flex: 1, color: c.text, fontSize: 14, padding: 0},
  card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 0},
  resultRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10},
  resultText: {color: c.text, fontSize: 15, fontWeight: '600'},
  resultCompany: {color: c.subtext, fontSize: 13, flexShrink: 1},
  orderTabs: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12},
  orderTabsLeft: {flexDirection: 'row', gap: 16, alignItems: 'center'},
  orderTabText: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  orderTabOn: {color: c.text},
  othersToggle: {flexDirection: 'row', alignItems: 'center', gap: 6},
  checkbox: {width: 15, height: 15, borderRadius: 4, borderWidth: 1, borderColor: c.subtext, alignItems: 'center', justifyContent: 'center'},
  checkboxOn: {backgroundColor: c.buttonSecondary, borderColor: c.buttonSecondary},
  checkboxTick: {color: c.text, fontSize: 10, fontWeight: '700'},
  othersText: {color: c.subtext, fontSize: 12},
  cancelAllRow: {alignItems: 'flex-end', paddingVertical: 6},
  cancelAllText: {color: c.subtext, fontSize: 12, fontWeight: '600', textDecorationLine: 'underline'},
  empty: {color: c.subtext, fontSize: 13, textAlign: 'center', paddingTop: 10},
  orderCard: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  orderHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, gap: 10},
  orderHeadLeft: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1},
  orderHeadRight: {flexDirection: 'row', alignItems: 'center', gap: 8},
  orderSummary: {color: c.text, fontSize: 12, fontVariant: ['tabular-nums'], flexShrink: 1},
  orderDetail: {paddingBottom: 12, gap: 7},
  noBottom: {paddingBottom: 0},
  kindBadge: {borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3},
  kindText: {fontSize: 11, fontWeight: '700'},
  marketTag: {backgroundColor: c.card, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2},
  marketTagText: {color: c.textMuted, fontSize: 10, fontWeight: '600'},
  orderLine: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  orderLabel: {color: c.subtext, fontSize: 12},
  orderAmt: {flexDirection: 'row', alignItems: 'center', gap: 6},
  orderAmtVal: {color: c.text, fontSize: 13, fontVariant: ['tabular-nums']},
  orderAmtSym: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  orderVal: {color: c.text, fontSize: 13, fontVariant: ['tabular-nums']},
  cancelInline: {color: c.danger, fontSize: 13, fontWeight: '600'},
  viewLink: {color: c.accent, fontSize: 13, fontWeight: '600'},
  bar: {flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: c.bg},
  barBtn: {flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center'},
  barText: {color: c.onAccent, fontSize: 17, fontWeight: '700'},
  dim: {opacity: 0.5},
  // sheet
  sheetBackdrop: {flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end'},
  sheet: {backgroundColor: c.elevated, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 34, gap: 10},
  sheetHead: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 4},
  sheetTitle: {color: c.text, fontSize: 18, fontWeight: '700'},
  sheetQuote: {color: c.subtext, fontWeight: '600'},
  sheetPrice: {color: c.subtext, fontSize: 12, marginTop: 3, fontVariant: ['tabular-nums']},
  sheetClose: {color: c.subtext, fontSize: 18},
  segTrack: {flexDirection: 'row', backgroundColor: c.cardAlt, borderRadius: 12, padding: 4, gap: 4, marginBottom: 4},
  segBtn: {flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center'},
  segOn: {backgroundColor: c.buttonSecondary},
  segText: {color: c.subtext, fontSize: 14, fontWeight: '600'},
  segTextOn: {color: c.text},
  // web-style inline field: left label + right value + token adornment
  field: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.input, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingHorizontal: 14, height: 52},
  fieldLabel: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  fieldRight: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end', marginLeft: 12},
  fieldInput: {flex: 1, textAlign: 'right', color: c.text, fontSize: 17, fontVariant: ['tabular-nums'], padding: 0},
  fieldValue: {flex: 1, textAlign: 'right', color: c.text, fontSize: 17, fontVariant: ['tabular-nums']},
  fieldSym: {color: c.text, fontSize: 14, fontWeight: '700'},
  maxPill: {backgroundColor: c.accentSoft, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3},
  maxText: {color: c.accent, fontSize: 11, fontWeight: '700'},
  availText: {color: c.subtext, fontSize: 11, marginTop: -6, marginLeft: 2},
  overText: {color: c.danger, fontSize: 12},
  fieldInputOver: {color: c.danger},
  validRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.input, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingLeft: 14, paddingRight: 6, height: 52},
  validChips: {flexDirection: 'row', gap: 4},
  vchip: {paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8},
  vchipOn: {backgroundColor: c.buttonSecondary},
  vchipText: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  vchipTextOn: {color: c.text},
  err: {color: c.danger, fontSize: 13},
  submit: {marginTop: 6},
});

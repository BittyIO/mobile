/**
 * Market swaps derived from the vault's transfer feed — ported from web `lib/market-trades`. A market
 * order leaves NO order record anywhere (unlike a CoW limit/TWAP order): the vault hands the sold token
 * to its AMM adapter clone and the clone hands the bought token back in the SAME transaction. That shared
 * counterparty, with different tokens each way, is what identifies the swap. This is how completed market
 * trades show up in the Trade screen's Finished tab.
 */
import type {Address} from 'viem';
import {apiFetch, apiUrl, type Network} from '@/core/chain';
import {GPV2_SETTLEMENT} from '@/core/cow';
import {fetchFillTxs} from './limit';
import type {TransferRow, VaultAction} from './transactions';

// The fee Safe: where a relayed op pays its gas (the vault's fee collector) and where the Uniswap
// adapter takes its 0.2% (a stablecoin sell's second out-leg). Each set also keeps the address that
// held the role before, since earlier vaults, older adapter clones and past history still pay there.
const FEE_SAFE = '0x5837c8f4963f694c59e53445c070acb266187bf1';
// The fee Safe's own vault: relay fees from vault v1.0.2, adapter fees from adapter v1.0.1.
const FEE_VAULT = '0xf0e7f6998b362bd15cf819c7ebfcace8865feca0';
export const BITTY_FEE_COLLECTORS = new Set([FEE_VAULT, FEE_SAFE, '0x76dc42c2e0ef4fb02600430cb0d3a68d015c30aa']);
export const ADAPTER_FEE_RECIPIENTS = new Set([FEE_VAULT, FEE_SAFE, '0x12ee2de7bf086388b1d560eb95e7191edfab9823']);

// Yield receipt tokens a stake mints to the vault (Sky sUSDS, Lido stETH) — a tx moving one is a
// stake/unstake into Flexible Yield ("Earn"), never a swap.
export const STAKE_TOKENS = new Set([
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH
  '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd', // sUSDS (mainnet)
  '0x5875eee11cf8398102fdad704c9e96607675467a', // sUSDS (Base)
]);

// Lending receipt tokens (Aave aTokens) — a tx moving one is a supply/withdraw on Flexible Lend.
export const SUPPLY_TOKENS = new Set([
  '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', // aEthUSDC
  '0x23878914efe38d27c4d67ab83ed1b93a74d4086a', // aEthUSDT
  '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8', // aEthWETH
  '0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8', // aEthWBTC
  '0xaf0f6e8b0dc5c913bbf4d14c22b4e78dd14310b6', // aUSDT (Sepolia)
  '0x1804bf30507dc2eb3bdebbbdd859991eaef6eeff', // aWBTC (Sepolia)
  '0x4e65fe4dba92790696d040ac24aa414708f5c0ab', // aBasUSDC (Base)
  '0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7', // aBasWETH (Base)
  '0xbdb9300b7cde636d9cd4aff00f6f009ffbbc8ee6', // aBascbBTC (Base)
]);

// Underlying protocol contracts a stake/supply moves tokens against — recognizes the op even when the
// receipt token itself isn't in the lists above (e.g. a testnet aToken we don't enumerate). Lowercased.
export const STAKE_COUNTERPARTY = new Set([
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH (Lido)
  '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd', // sUSDS (Sky, mainnet)
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f', // USDS (Sky, mainnet)
  '0x5875eee11cf8398102fdad704c9e96607675467a', // sUSDS (Sky, Base)
]);
export const SUPPLY_COUNTERPARTY = new Set([
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Aave v3 Pool (mainnet)
  '0xa238dd80c259a72e81d7e4664a9801593f98d1c5', // Aave v3 Pool (Base)
  '0x6ae43d3271ff6888e7fc43fd7321a503ff738951', // Aave v3 Pool (Sepolia)
]);

const lc = (s?: string | null) => (s ?? '').toLowerCase();
export const isReceiptToken = (a?: string | null) => STAKE_TOKENS.has(lc(a)) || SUPPLY_TOKENS.has(lc(a));

export type MarketTrade = {
  txHash: string;
  blockNum: number;
  ts?: number; // unix seconds
  sold: {address: string; symbol: string; amount: number};
  bought: {address: string; symbol: string; amount: number};
};

/** Split one tx's legs (gas-fee legs already removed) into the market swap, if any. */
export function splitMarketSwap(legs: TransferRow[]): TransferRow[] {
  const byCp = new Map<string, {out: Set<string>; in: Set<string>; receipt: boolean}>();
  for (const l of legs) {
    const cp = lc(l.counterparty);
    if (!cp) continue;
    const entry = byCp.get(cp) ?? {out: new Set(), in: new Set(), receipt: false};
    entry[l.direction].add(lc(l.assetAddress));
    if (isReceiptToken(l.assetAddress)) entry.receipt = true;
    byCp.set(cp, entry);
  }
  const swapCps = new Set<string>();
  for (const [cp, e] of byCp) {
    if (e.receipt || e.out.size === 0 || e.in.size === 0) continue;
    if ([...e.out].some((t) => !e.in.has(t))) swapCps.add(cp);
  }
  if (swapCps.size === 0) return [];

  const soldTokens = new Set(
    legs.filter((l) => l.direction === 'out' && swapCps.has(lc(l.counterparty))).map((l) => lc(l.assetAddress)),
  );
  return legs.filter(
    (l) =>
      swapCps.has(lc(l.counterparty)) ||
      (l.direction === 'out' && ADAPTER_FEE_RECIPIENTS.has(lc(l.counterparty)) && soldTokens.has(lc(l.assetAddress))),
  );
}

/**
 * Net a set of swap legs into what the vault actually sold vs bought — the sold side sums the input plus
 * the adapter fee leg, so it's the full amount spent. Null if the legs don't net to a clean swap.
 */
export function netTrade(swapLegs: TransferRow[]): {sold: MarketTrade['sold']; bought: MarketTrade['bought']} | null {
  const net = new Map<string, {symbol: string; amount: number}>();
  for (const l of swapLegs) {
    const n = Number(l.amount);
    if (!l.assetAddress || !Number.isFinite(n)) continue;
    const key = lc(l.assetAddress);
    const cur = net.get(key) ?? {symbol: l.assetSymbol ?? '', amount: 0};
    cur.amount += l.direction === 'out' ? -n : n;
    net.set(key, cur);
  }
  const sold = [...net.entries()].filter(([, v]) => v.amount < -1e-12).sort((a, b) => a[1].amount - b[1].amount)[0];
  const bought = [...net.entries()].filter(([, v]) => v.amount > 1e-12).sort((a, b) => b[1].amount - a[1].amount)[0];
  if (!sold || !bought) return null;
  return {
    sold: {address: sold[0], symbol: sold[1].symbol, amount: -sold[1].amount},
    bought: {address: bought[0], symbol: bought[1].symbol, amount: bought[1].amount},
  };
}

/**
 * What one read of the transfer feed yields.
 *
 * Two things, because the feed is the only place either can be had. The market swaps are the
 * trades that leave no order record. The fills are the opposite — swaps that DO have an order
 * behind them, excluded from `trades` for that reason — and all that is taken from them is WHEN,
 * keyed by the settlement transaction: CoW's order objects carry no execution time, so a filled
 * limit order could say what it got and never when it got it.
 */
export type TradeFeed = {
  trades: MarketTrade[];
  /** Settlement transaction hash (lower-cased) → unix seconds. */
  cowFills: Map<string, number>;
  /** Order uid (lower-cased) → when the transaction that cancelled it landed. */
  cancels: Map<string, number>;
};

/**
 * When each order was cancelled, read off the calldata of the transaction that did it.
 *
 * A cancellation moves no tokens, so there is nothing in the transfer legs to recognise it by —
 * but it is a relayed operation and therefore pays its gas, which puts the transaction in the
 * feed, and the server decodes what every transaction CALLED. `cancelIntentOrders` names the
 * uids it invalidated, so the order and the clock meet in one place.
 *
 * This is the only way a cancellation time survives a reinstall or arrives from another device:
 * CoW's order object records no cancellation date, and the app's own log (see {cancel-log}) only
 * knows about cancels it performed itself.
 */
function cancelTimes(legs: TransferRow[], actions: Record<string, VaultAction[]>): Map<string, number> {
  const at = new Map<string, number>();
  for (const l of legs) {
    if (!l.timestamp) continue;
    const acts = actions[lc(l.txHash)] ?? actions[l.txHash];
    if (!acts) continue;
    const secs = Math.floor(Date.parse(l.timestamp) / 1000);
    if (!Number.isFinite(secs)) continue;
    for (const a of acts) {
      if (!a.name.startsWith('cancelIntentOrder')) continue;
      const uids = a.args.uids ?? a.args.uid ?? [];
      for (const uid of Array.isArray(uids) ? uids : [uids]) at.set(lc(uid), secs);
    }
  }
  return at;
}

/** Every market swap in a transfer feed, newest first. */
export function marketTradesFromTransfers(legs: TransferRow[]): MarketTrade[] {
  return tradeFeedFromTransfers(legs).trades;
}

export function tradeFeedFromTransfers(legs: TransferRow[]): TradeFeed {
  const groups = new Map<string, TransferRow[]>();
  for (const l of legs) {
    const arr = groups.get(l.txHash);
    if (arr) arr.push(l);
    else groups.set(l.txHash, [l]);
  }
  const trades: MarketTrade[] = [];
  const cowFills = new Map<string, number>();
  for (const [txHash, group] of groups) {
    const opLegs = group.filter((l) => !(l.direction === 'out' && BITTY_FEE_COLLECTORS.has(lc(l.counterparty))));
    // A swap settled by CoW is a limit or TWAP order being filled, and the orderbook already has
    // it as an order. Recovering it here as well listed one filled order twice in Finished: once
    // from CoW with its price and expiry, once from the chain as an anonymous swap. This feed is
    // for the trades that leave NO order record, which is what "market" means here.
    //
    // Recognised by the settlement contract alone, BEFORE the swap split: an order paid from a
    // position sells sUSDS or an aToken, which the split sets aside as a receipt-token move, so
    // the fill was never seen and the order showed no time.
    const settled = opLegs.filter((l) => lc(l.counterparty) === lc(GPV2_SETTLEMENT));
    if (settled.length) {
      const at = settled.find((l) => l.timestamp)?.timestamp;
      if (at) cowFills.set(lc(txHash), Math.floor(Date.parse(at) / 1000));
      continue;
    }
    const swapLegs = splitMarketSwap(opLegs);
    if (swapLegs.length === 0) continue;
    const at = swapLegs.find((l) => l.timestamp)?.timestamp;
    const secs = at ? Math.floor(Date.parse(at) / 1000) : undefined;
    const t = netTrade(swapLegs);
    if (!t) continue;
    trades.push({txHash, blockNum: swapLegs[0].blockNum, ts: secs, sold: t.sold, bought: t.bought});
  }
  return {trades: trades.sort((a, b) => b.blockNum - a.blockNum), cowFills, cancels: new Map()};
}

/** One read of the transfer feed, as both of the things it carries. Best-effort — empty on failure. */
export async function fetchTradeFeed(vault: string, network: Network): Promise<TradeFeed> {
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/transfers/${vault}`, network));
    if (!res.ok) return {trades: [], cowFills: new Map(), cancels: new Map()};
    const json = (await res.json()) as {data?: TransferRow[]; actions?: Record<string, VaultAction[]>};
    const rows = json.data ?? [];
    return {...tradeFeedFromTransfers(rows), cancels: cancelTimes(rows, json.actions ?? {})};
  } catch {
    return {trades: [], cowFills: new Map(), cancels: new Map()};
  }
}

/** Just the market swaps, for a caller that has no use for the fills. */
export async function fetchMarketTrades(vault: string, network: Network): Promise<MarketTrade[]> {
  return (await fetchTradeFeed(vault, network)).trades;
}

/**
 * The market swaps, and WHEN each CoW order filled — the pair every order list needs.
 *
 * A fill's time is in neither place on its own: CoW's order object carries a creation date and no
 * execution date, and the transfer feed knows when a transaction happened but not which order it
 * settled. Joining the two is the whole job, and both screens that list orders were doing it
 * themselves — one of them simply not bothering, which is why a filled order said when it filled
 * on the Trade tab and said nothing in Order history.
 */
export async function fetchTrades(
  vault: string,
  network: Network,
): Promise<{trades: MarketTrade[]; fillAt: Map<string, number>; cancelAt: Map<string, number>}> {
  const [feed, fillTxs] = await Promise.all([
    fetchTradeFeed(vault, network),
    fetchFillTxs(vault as Address, network),
  ]);
  const fillAt = new Map<string, number>();
  for (const [uid, tx] of fillTxs) {
    const ts = feed.cowFills.get(tx);
    if (ts) fillAt.set(uid, ts);
  }
  return {trades: feed.trades, fillAt, cancelAt: feed.cancels};
}

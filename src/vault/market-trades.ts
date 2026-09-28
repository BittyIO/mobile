/**
 * Market swaps derived from the vault's transfer feed — ported from web `lib/market-trades`. A market
 * order leaves NO order record anywhere (unlike a CoW limit/TWAP order): the vault hands the sold token
 * to its AMM adapter clone and the clone hands the bought token back in the SAME transaction. That shared
 * counterparty, with different tokens each way, is what identifies the swap. This is how completed market
 * trades show up in the Trade screen's Finished tab.
 */
import {apiUrl, type Network} from '@/core/chain';
import type {TransferRow} from './transactions';

// The vault implementation's immutable fee sink — a relayed op pays its gas here, never a user transfer.
export const BITTY_FEE_COLLECTOR = '0x76dc42c2e0ef4fb02600430cb0d3a68d015c30aa';
// The Uniswap adapter's fee recipient — a stablecoin sell takes its 0.2% as a second out-leg to here.
export const ADAPTER_FEE_RECIPIENT = '0x12ee2de7bf086388b1d560eb95e7191edfab9823';

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
      (l.direction === 'out' && lc(l.counterparty) === ADAPTER_FEE_RECIPIENT && soldTokens.has(lc(l.assetAddress))),
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

/** Every market swap in a transfer feed, newest first. */
export function marketTradesFromTransfers(legs: TransferRow[]): MarketTrade[] {
  const groups = new Map<string, TransferRow[]>();
  for (const l of legs) {
    const arr = groups.get(l.txHash);
    if (arr) arr.push(l);
    else groups.set(l.txHash, [l]);
  }
  const trades: MarketTrade[] = [];
  for (const [txHash, group] of groups) {
    const opLegs = group.filter((l) => !(l.direction === 'out' && lc(l.counterparty) === BITTY_FEE_COLLECTOR));
    const swapLegs = splitMarketSwap(opLegs);
    if (swapLegs.length === 0) continue;
    const t = netTrade(swapLegs);
    if (!t) continue;
    const ts = swapLegs.find((l) => l.timestamp)?.timestamp;
    trades.push({txHash, blockNum: swapLegs[0].blockNum, ts: ts ? Math.floor(Date.parse(ts) / 1000) : undefined, sold: t.sold, bought: t.bought});
  }
  return trades.sort((a, b) => b.blockNum - a.blockNum);
}

/** Fetch the vault's completed market swaps from the transfer feed. Best-effort — [] on failure. */
export async function fetchMarketTrades(vault: string, network: Network): Promise<MarketTrade[]> {
  try {
    const res = await fetch(apiUrl(`/api/ethereum/vaults/transfers/${vault}`, network));
    if (!res.ok) return [];
    const json = (await res.json()) as {data?: TransferRow[]};
    return marketTradesFromTransfers(json.data ?? []);
  } catch {
    return [];
  }
}

/**
 * USD prices via CoinGecko simple/price (same source as the web `lib/asset-prices`). Keyed by symbol
 * through a small id map, so no per-asset coingeckoId is needed. Best-effort — a failed fetch just
 * means no USD values render.
 */
export type PriceMap = Map<string, number>; // SYMBOL -> usd

/** Symbol → CoinGecko id, the same ids the web's asset catalog uses. */
export const COINGECKO_ID: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'ethereum',
  WBTC: 'bitcoin',
  cbBTC: 'bitcoin',
  XAUt: 'tether-gold',
  UNI: 'uniswap',
  AAVE: 'aave',
  USDC: 'usd-coin',
  USDT: 'tether',
  USDG: 'global-dollar',
  // Robinhood Chain tokenized stocks (Robinhood's own tokens, listed on CoinGecko under these ids).
  SPY: 'spdr-s-p-500-etf-trust-robinhood-tokenized-stock',
  NVDA: 'nvidia-robinhood-tokenized-stock',
  GLD: 'spdr-gold-shares-robinhood-token',
  SPCX: 'spacex-robinhood-tokenized-stock',
  META: 'meta-platforms-robinhood-tokenized-stock',
  GOOGL: 'alphabet-class-a-robinhood-tokenized-stock',
  AAPL: 'apple-robinhood-tokenized-stock',
  HIMS: 'hims-hers-health-inc-robinhood-token',
  MSTR: 'strategy-inc-robinhood-tokenized-stock',
  TSLA: 'tesla-robinhood-tokenized-stock',
  // Ondo Global Markets tokenized stocks on mainnet (tickers shared with Robinhood keep the id above).
  CRCL: 'circle-internet-group-ondo-tokenized-stock',
  COIN: 'coinbase-ondo-tokenized-stock',
  SBET: 'sharplink-gaming-inc-ondo-tokenized-stock',
  MSFT: 'microsoft-ondo-tokenized-stock',
  AMZN: 'amazon-ondo-tokenized-stock',
  PLTR: 'palantir-technologies-ondo-tokenized-stock',
  AMD: 'amd-ondo-tokenized-stock',
  TSM: 'taiwan-semiconductor-manufacturing-ondo-tokenized-stock',
  INTC: 'intel-ondo-tokenized-stock',
  QQQ: 'invesco-qqq-etf-ondo-tokenized-etf',
  NFLX: 'netflix-ondo-tokenized-stock',
  HOOD: 'robinhood-markets-ondo-tokenized-stock',
  BMNR: 'bitmine-immersion-technologies-ondo-tokenized-stocks',
  SNDK: 'sandisk-ondo-tokenized',
  COST: 'costco-ondo-tokenized-stock',
};
const CG_ID = COINGECKO_ID;

export async function fetchPrices(symbols: string[]): Promise<PriceMap> {
  const m: PriceMap = new Map();
  const ids = [...new Set(symbols.map((s) => CG_ID[s]).filter(Boolean))];
  if (ids.length === 0) return m;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
    );
    const j = (await res.json()) as Record<string, {usd?: number}>;
    for (const s of symbols) {
      const id = CG_ID[s];
      const p = id ? j[id]?.usd : undefined;
      if (typeof p === 'number') m.set(s, p);
    }
  } catch {
    /* no prices on failure */
  }
  return m;
}

/** USD value of `amount` (human units) of `symbol`, or null if unpriced. */
export function usdValue(amount: number, symbol: string, prices: PriceMap): number | null {
  const p = prices.get(symbol);
  return p != null ? amount * p : null;
}

export function fmtUsd(v: number | null): string {
  if (v == null) return '';
  return v.toLocaleString(undefined, {style: 'currency', currency: 'USD', maximumFractionDigits: 2});
}

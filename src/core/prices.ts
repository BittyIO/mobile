/**
 * USD prices, keyed by symbol through a small id map so no per-asset coingeckoId is needed.
 *
 * Two things make this reliable rather than best-effort:
 *
 *  - A dollar stable coin is worth a dollar. It is pegged locally and never asked about, which is
 *    what keeps a stablecoin vault's total from depending on a third party being reachable.
 *  - Everything else comes from the app's own /api/prices, which answers from Chainlink where a
 *    feed exists, the Uniswap pools on the asset's chain where one does not, and CoinGecko for
 *    the last handful of tokenized stocks that have neither. Coinbase's public spot endpoint
 *    backs the whole thing up for the majors, in case the endpoint itself is unreachable.
 *
 *    What the app never does is ask a price service directly: CoinGecko answers a phone with a
 *    CloudFront "Request blocked" 403, so the map came back empty and every price and portfolio
 *    total rendered as a dash. Asking it from a server works; asking it from here does not.
 */
import {API_BASE, type Network} from '@/core/chain';

export type PriceMap = Map<string, number>; // SYMBOL -> usd

/**
 * Stable coins pegged to the dollar, valued at 1 without asking anyone.
 *
 * The peg can break, and a price feed would show that. It would also show nothing at all whenever
 * the feed is unreachable, which is the failure that actually happened, so a fixed dollar is the
 * better of the two errors here.
 */
const USD_PEGGED = new Set(['USDC', 'USDT', 'USDG', 'DAI', 'USDS', 'PYUSD', 'FDUSD', 'USDe']);

/**
 * Symbol → CoinGecko id.
 *
 * No longer used for prices — those come from Uniswap now — but the price CHART still asks
 * CoinGecko for history, which no pool can answer in one call.
 */
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
  COST: 'costco-ondo-tokenized-stock',
};

/**
 * The app's own price endpoint: Chainlink, then Uniswap, then CoinGecko, resolved server-side.
 *
 * Symbols, not CoinGecko ids, because the server resolves them against the same asset catalog the
 * app renders from — so a token added to the catalog is priceable the moment it has a pool, with
 * no id to map and no third party to have heard of it.
 */
async function bittyPrices(symbols: string[], network: Network): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const url = `${API_BASE}/api/prices?network=${network}&symbols=${encodeURIComponent(symbols.join(','))}`;
    const res = await fetch(url);
    if (!res.ok) return out;
    const j = (await res.json()) as {prices?: Record<string, number>};
    for (const [k, v] of Object.entries(j?.prices ?? {})) if (typeof v === 'number' && v > 0) out.set(k, v);
  } catch {
    /* fall through to the sources below */
  }
  return out;
}

/**
 * Coinbase's public spot price, one symbol at a time, for what the other sources could not answer.
 *
 * Its universe is the majors — no tokenized stock, no long-tail token — so it fills gaps rather
 * than replacing anything. Requests run together and a failure is just a missing price.
 */
async function coinbaseSpot(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    symbols.map(async (s) => {
      try {
        // Wrapped tokens track the asset they wrap; ask for that.
        const base = s === 'WETH' ? 'ETH' : s === 'WBTC' || s === 'cbBTC' ? 'BTC' : s;
        const res = await fetch(`https://api.coinbase.com/v2/prices/${base}-USD/spot`);
        if (!res.ok) return;
        const j = (await res.json()) as {data?: {amount?: string}};
        const n = Number(j?.data?.amount);
        if (Number.isFinite(n) && n > 0) out.set(s, n);
      } catch {
        /* one missing price, not a failed fetch */
      }
    }),
  );
  return out;
}

export async function fetchPrices(symbols: string[], network: Network = 'mainnet'): Promise<PriceMap> {
  const m: PriceMap = new Map();
  // The pegs first, so they hold even if nothing below answers.
  for (const s of symbols) if (USD_PEGGED.has(s)) m.set(s, 1);

  const wanted = symbols.filter((s) => !USD_PEGGED.has(s));
  if (wanted.length === 0) return m;

  for (const [k, v] of await bittyPrices(wanted, network)) m.set(k, v);

  // Whatever has no pool on this chain — or the whole list, if the endpoint is unreachable.
  const missing = wanted.filter((s) => !m.has(s));
  if (missing.length) for (const [k, v] of await coinbaseSpot(missing)) m.set(k, v);
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

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
import {API_BASE, apiFetch, type Network} from '@/core/chain';
import {displayFx, CURRENCY_SYMBOL} from '@/core/currency-store';
import {fmtTiny} from '@/core/format';

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
    const res = await apiFetch(url);
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
        const res = await apiFetch(`https://api.coinbase.com/v2/prices/${base}-USD/spot`);
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

/**
 * A dollar figure, with enough of it to be worth reading.
 *
 * Two decimals is right for a dollar and wrong below one: a token at $0.0914 printed as "$0.09"
 * loses the digit that moves, and a chart whose whole range renders as the same four characters
 * says nothing at all. So the precision follows the magnitude —
 *
 *   $1,234.56   ·   $0.0914   ·   $0.0099   ·   $0.0000123
 *
 * Down to a cent it counts DECIMALS, with a floor of two so a round fifty cents is still "$0.50"
 * and not "$0.5"; `maximumFractionDigits` carries no minimum of its own, so nothing is padded.
 *
 * Below a cent it counts SIGNIFICANT DIGITS instead, because a fixed decimal cap is the wrong
 * instrument there: eight of them renders 0.00001234 as "$0.00001234", eleven characters of
 * which four are leading zeros and the last is noise. Three significant digits is the same amount
 * of information at any size — "$0.0000123" — and it is what every price page shows. The
 * two-decimal floor is dropped in that branch: Intl lets significant digits win when both are
 * given, and a number this small has no use for it anyway.
 */
export function fmtUsd(v: number | null): string {
  if (v == null) return '';
  /*
   * The argument stays a DOLLAR figure — every price in the system is one — and the display
   * currency is applied here, at the last moment, from the Settings choice (see currency-store).
   * Converting in one place means a screen can never mix currencies, and a missing rate degrades
   * to printing dollars rather than to a wrong number.
   */
  const {currency, rate} = displayFx();
  const n = v * rate;
  const abs = Math.abs(n);
  // Currencies with no everyday minor unit: ¥1,234.00 reads as a mistake where $1,234.00 does not.
  const wholeUnit = currency === 'JPY' || currency === 'KRW' || currency === 'VND' || currency === 'IDR';
  const digits: Intl.NumberFormatOptions =
    abs > 0 && abs < 0.01
      ? {maximumSignificantDigits: 3}
      : wholeUnit && abs >= 1
        ? {maximumFractionDigits: 0}
        : {minimumFractionDigits: 2, maximumFractionDigits: abs >= 1 ? 2 : 4};
  // The symbol is OURS, not Intl's: Hermes has no currency-symbol data, so style:'currency' printed
  // the ISO code ("CNY"). Format the number on its own (style:'decimal', which Hermes does support)
  // and prepend the sign, with the minus ahead of the symbol so a loss reads "-¥12", not "¥-12".
  // Dust (four zeros or more after the point) counts its zeros, as the amounts do — "$0.0₁₄882",
  // never "$0.00000000000000882", which nobody can read.
  const body =
    abs > 0 && Number(abs.toPrecision(3)) < 0.0001
      ? fmtTiny(abs)
      : Math.abs(n).toLocaleString(undefined, {style: 'decimal', ...digits});
  return `${n < 0 ? '-' : ''}${CURRENCY_SYMBOL[currency] ?? ''}${body}`;
}

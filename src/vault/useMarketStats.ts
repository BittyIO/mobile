import {useEffect, useMemo, useState} from 'react';
import {API_BASE, apiFetch, type Network} from '@/core/chain';
import type {Language} from '@/core/language-store';

/** What a watch list shows about an asset beyond its price. */
export type MarketStat = {
  /** Percent, already in percent units: -1.84 means down 1.84% over the day. */
  change24h: number | null;
  marketCap: number | null;
};
export type MarketStatMap = Map<string, MarketStat>;

/**
 * Day change and market cap for a screen's assets, from the app's own /api/prices/stats.
 *
 * A second hook rather than more fields on {usePrices}, because the two have different costs and
 * different failure modes. A price is a chain read and every balance on the screen depends on it;
 * these two numbers exist only on CoinGecko, are metered, and nothing but the watch list reads
 * them. Keeping them apart means a rate-limited third party can never delay — or blank — the
 * figure a user's own holdings are valued at.
 *
 * Missing is normal: an asset the catalog has no CoinGecko id for simply is not in the map, and
 * the row renders a dash. A failed request leaves the previous answer standing rather than
 * clearing it, so a dropped connection does not blank a list that was already drawn.
 */
export function useMarketStats(network: Network, symbols: string[], nonce = 0): MarketStatMap {
  const [stats, setStats] = useState<MarketStatMap>(new Map());
  // Sorted and joined so a re-render with the same set does not re-fetch.
  const key = useMemo(() => [...new Set(symbols)].sort().join(','), [symbols]);

  useEffect(() => {
    if (!key) return;
    let live = true;
    (async () => {
      try {
        const url = `${API_BASE}/api/prices/stats?network=${network}&symbols=${encodeURIComponent(key)}`;
        const res = await apiFetch(url);
        if (!res.ok) return;
        const j = (await res.json()) as {stats?: Record<string, {change24h?: number | null; marketCap?: number | null}>};
        if (!live) return;
        const m: MarketStatMap = new Map();
        for (const [sym, v] of Object.entries(j?.stats ?? {})) {
          m.set(sym, {
            change24h: typeof v?.change24h === 'number' ? v.change24h : null,
            marketCap: typeof v?.marketCap === 'number' ? v.marketCap : null,
          });
        }
        setStats(m);
      } catch {
        // Keep whatever was already on screen.
      }
    })();
    return () => {
      live = false;
    };
  }, [key, network, nonce]);

  return stats;
}

/**
 * How each language abbreviates a large number, largest unit first.
 *
 * Not a translation of "B" and "T" — the grouping itself differs. Chinese, Japanese and Korean
 * count in ten-thousands: 万 is 10⁴ and 亿 is 10⁸, so a figure a English speaker reads as 48.3B is
 * 483亿, and there is no unit at 10⁹ at all to translate "B" into. Getting that wrong is not a
 * clumsy label, it is the wrong number of digits.
 *
 * Each suffix carries its own leading space where the language wants one: CJK runs the unit
 * straight onto the figure, European abbreviations take a space.
 *
 * Everything not listed takes the Latin K/M/B/T, and that is a choice rather than a gap. The
 * four CJK languages have to be here because their grouping is different; German, Russian and
 * Brazilian Portuguese are here because their abbreviations are unambiguous and in daily use.
 * The rest — French, Spanish, Turkish, Indonesian, Vietnamese, Hindi, Thai — have several
 * competing short forms each, and their financial press quotes USD market caps in the Latin
 * letters anyway. A confident wrong abbreviation reads worse than the one every market knows.
 */
const CAP_UNITS: Partial<Record<Language, [number, string][]>> = {
  zh: [[1e12, '万亿'], [1e8, '亿'], [1e4, '万']],
  'zh-TW': [[1e12, '兆'], [1e8, '億'], [1e4, '萬']],
  ja: [[1e12, '兆'], [1e8, '億'], [1e4, '万']],
  ko: [[1e12, '조'], [1e8, '억'], [1e4, '만']],
  de: [[1e12, ' Bio.'], [1e9, ' Mrd.'], [1e6, ' Mio.'], [1e3, ' Tsd.']],
  ru: [[1e12, ' трлн'], [1e9, ' млрд'], [1e6, ' млн'], [1e3, ' тыс.']],
  'pt-BR': [[1e12, ' tri'], [1e9, ' bi'], [1e6, ' mi'], [1e3, ' mil']],
};
const DEFAULT_CAP_UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/**
 * A market cap in the shorthand the reader's own market uses: $2.1T, 4.87万亿, 412 млрд.
 *
 * Full digits would be a dozen characters in the narrowest column on the row, and nobody reads a
 * market cap to the dollar. Three significant figures is what fits and what the number is worth.
 */
export function fmtCap(n: number | null | undefined, language: Language = 'en'): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  for (const [size, suffix] of CAP_UNITS[language] ?? DEFAULT_CAP_UNITS) {
    if (n >= size) {
      const v = n / size;
      return `$${v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)}${suffix}`;
    }
  }
  return `$${n.toFixed(0)}`;
}

/** A day change as a signed percentage, with the sign always written out. */
export function fmtChange(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

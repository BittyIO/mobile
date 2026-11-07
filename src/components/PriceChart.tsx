import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {Defs, LinearGradient, Path, Stop} from 'react-native-svg';
import {fmtUsd} from '@/core/prices';
import {fmtPrice} from '@/components/OrderRow';
import {fmtCompact} from '@/vault/useMarketStats';
import {API_BASE, apiFetch} from '@/core/chain';
import {useNetwork} from '@/core/network-store';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {getPref, setPref} from '@/core/prefs';

/**
 * Cached history, keyed by symbol and range.
 *
 * The chart used to call CoinGecko from the device, once per mount and again on every range the
 * user tried. Nothing was cached, so flipping between 1W and 1M and back cost two more calls, and
 * the keyless per-IP allowance ran out within a session — after which the response was an error
 * object that parsed as JSON with no `prices` in it, and the chart showed a bare dash. It is one
 * request per symbol per range per TTL now, answered by our own server.
 */
const TTL_MS: Record<number, number> = {1: 5 * 60_000, 7: 30 * 60_000, 30: 60 * 60_000, 365: 6 * 60 * 60_000};
const cache = new Map<string, {pts: [number, number][] | null; at: number}>();

// Range pills; `label` is the web translation key for the period name.
const RANGES: {label: string; days: number}[] = [
  {label: 'vault.period_24h', days: 1},
  {label: 'vault.period_1w', days: 7},
  {label: 'vault.period_1m', days: 30},
  {label: 'vault.period_1y', days: 365},
];

/**
 * The range last chosen, on any chart. One for the whole app: it is how the owner likes to look at
 * a price, not a fact about one asset, and each new pair page used to open back on 1W.
 */
const RANGE_PREF = 'chart.range';
const savedRange = (): number => {
  const i = RANGES.findIndex((r) => String(r.days) === getPref(RANGE_PREF));
  return i >= 0 ? i : 1; // 1W
};

const H = 150;

/** One symbol's USD series for a range, through the cache. Null when there is none. */
async function loadSeries(network: string, symbol: string, days: number, forced: boolean): Promise<[number, number][] | null> {
  const key = `${network}:${symbol}:${days}`;
  const hit = forced ? undefined : cache.get(key);
  if (hit && Date.now() - hit.at < (TTL_MS[days] ?? 60 * 60_000)) return hit.pts;
  const r = await apiFetch(`${API_BASE}/api/prices/chart?network=${network}&symbol=${encodeURIComponent(symbol)}&days=${days}`);
  // Checked, not assumed. A refusal still returns a JSON body, so parsing it and looking for points
  // reported "no data" for what was really "ask again later".
  if (!r.ok) throw new Error(String(r.status));
  const j = await r.json();
  const arr = Array.isArray(j?.points) ? (j.points as [number, number][]) : [];
  const pts = arr.length >= 2 ? arr : null;
  cache.set(key, {pts, at: Date.now()});
  return pts;
}

/**
 * The base priced in the quote: each base point over the quote's point nearest in time.
 *
 * The two series come from one source at one granularity, so their timestamps nearly line up;
 * nearest-in-time rather than exact keeps a point that is a few seconds off from being dropped.
 */
function ratioSeries(base: [number, number][], quote: [number, number][]): [number, number][] | null {
  const out: [number, number][] = [];
  let j = 0;
  for (const [ts, px] of base) {
    while (j + 1 < quote.length && Math.abs(quote[j + 1][0] - ts) <= Math.abs(quote[j][0] - ts)) j++;
    const q = quote[j][1];
    if (q > 0) out.push([ts, px / q]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * Price chart for a base asset — CoinGecko USD history, line + area, green up / red down. Mirrors
 * web PriceChart.
 *
 * `quote`, when given, is a non-dollar quote (ETH on a UNI/ETH pair): the line is then the base in
 * THAT asset — the price the order form asks for — built from the two USD series, and the figures
 * carry the quote's ticker instead of a dollar sign.
 *
 * `last`, when given, is the price the screen is trading at (the live pool quote), and the line ends
 * on it: the headline then matches the order form and the Overview rather than a history point that
 * can be hours old.
 *
 * `reload` is a counter the screen bumps on pull-to-refresh. It is a PROP and not a remount — the
 * Trade tab used to put it in the chart's `key`, which threw the component away and built a new
 * one, and a new one starts on 1W: a pull after choosing 24H silently moved the chart back to a
 * week. The selected range belongs to the user, so it survives a refresh, a change of asset and a
 * new pair page (see {RANGE_PREF}), and only the series is re-read.
 */
export function PriceChart({
  symbol,
  quote,
  last: liveLast,
  reload = 0,
  title,
  footerLeft,
}: {
  symbol: string;
  quote?: string;
  last?: number;
  reload?: number;
  /** What the chart is OF, in its top-left corner over the price — the trade page's pair. */
  title?: React.ReactNode;
  /** The bottom-left corner, across from the time pills — the trade page's Asset details. */
  footerLeft?: React.ReactNode;
}) {
  const {t, language} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const network = useNetwork((st) => st.network);
  const [rangeIdx, setRangeIdxState] = useState(savedRange);
  const setRangeIdx = (i: number) => {
    setRangeIdxState(i);
    setPref(RANGE_PREF, String(RANGES[i].days));
  };
  const [pts, setPts] = useState<[number, number][] | null>(null);
  const [error, setError] = useState(false);

  // Drop the previous asset's series the instant the asset changes — DURING render, not in an
  // effect. An effect clears a tick too late: the first frame of the new asset still paints the old
  // one's line and price (loading only shows when there is no series), which is the stale figure
  // that flashed on every switch. Resetting here (React's "adjust state on prop change" pattern)
  // means the new symbol never renders with the old symbol's points. A range switch keeps the asset,
  // so it does not reset and the current line stays up while the new granularity loads.
  const assetKey = `${network}:${symbol}/${quote ?? ''}`;
  const [drawnAsset, setDrawnAsset] = useState(assetKey);
  if (drawnAsset !== assetKey) {
    setDrawnAsset(assetKey);
    setPts(null);
    setError(false);
  }

  // The current price must be identical whichever range is selected. Each range's series ends on a
  // coarser, staler granularity (7d/30d/1y lag the 24h one), so pin the freshest price SEEN across
  // ranges (by timestamp) as the series' last point. Persists across range switches; keyed by asset.
  const latestRef = useRef<{key: string; ts: number; price: number} | null>(null);
  const pinLatest = (arr: [number, number][] | null): [number, number][] | null => {
    if (!arr || arr.length === 0) return arr;
    const assetKey = `${network}:${symbol}/${quote ?? ''}`;
    const [lastTs, lastPrice] = arr[arr.length - 1];
    if (!latestRef.current || latestRef.current.key !== assetKey || lastTs > latestRef.current.ts) {
      latestRef.current = {key: assetKey, ts: lastTs, price: lastPrice};
    }
    return [...arr.slice(0, -1), [lastTs, latestRef.current.price]];
  };

  // A pull must reach the network even inside the TTL — the whole point of it is "I want the
  // current figure" — so a run the pull caused ignores the cache, while a range switch still gets
  // the cheap answer.
  const lastReload = useRef(reload);
  useEffect(() => {
    const forced = reload !== lastReload.current;
    lastReload.current = reload;
    const days = RANGES[rangeIdx].days;
    let live = true;
    setError(false);
    Promise.all([loadSeries(network, symbol, days, forced), quote ? loadSeries(network, quote, days, forced) : null])
      .then(([b, q]) => {
        if (!live) return;
        const pts = b && quote ? (q ? ratioSeries(b, q) : null) : b;
        setPts(pinLatest(pts));
        setError(pts == null);
      })
      .catch(() => {
        if (!live) return;
        setPts(null);
        setError(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, symbol, quote, rangeIdx, reload]);

  const g = useMemo(() => {
    if (!pts) return null;
    const ys = pts.map((p) => p[1]);
    if (liveLast != null && liveLast > 0) ys[ys.length - 1] = liveLast;
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const span = max - min || 1;
    const n = ys.length;
    const path = ys.map((y, i) => `${i ? 'L' : 'M'}${((i / (n - 1)) * 100).toFixed(2)} ${(100 - ((y - min) / span) * 96 - 2).toFixed(2)}`).join(' ');
    const first = ys[0];
    const last = ys[n - 1];
    const changePct = first ? (last / first - 1) * 100 : 0;
    return {min, max, path, area: `${path} L100 100 L0 100 Z`, up: last >= first, changePct, last};
  }, [pts, liveLast]);

  const color = g ? (g.up ? c.success : c.danger) : c.subtext;
  // A price in another token can run to nine digits — ETH is ~450M PEPE — so from a million up it
  // takes the market-cap shorthand (446M), and from a thousand up it is grouped (4,461.2).
  const inQuote = (n: number) =>
    n >= 1e6 ? fmtCompact(n, language) : n >= 1e4 ? n.toLocaleString(undefined, {maximumFractionDigits: 0}) : n >= 1e3 ? n.toLocaleString(undefined, {maximumFractionDigits: 2}) : (fmtPrice(n) ?? '0');
  // No unit after it: the pair over the chart already says what the price is in.
  const fmt = (n: number) => (quote ? inQuote(n) : fmtUsd(n));

  return (
    <View style={styles.card}>
      {/* What the chart is of on the left, what it is worth on the right, on one line. */}
      <View style={styles.head}>
        {title}
        <View style={styles.headPrice}>
          <Text style={styles.price} numberOfLines={1} ellipsizeMode="tail">{g ? fmt(g.last) : '—'}</Text>
          {g ? (
            <Text style={[styles.change, {color: g.changePct >= 0 ? c.success : c.danger}]}>
              {g.changePct >= 0 ? '+' : ''}
              {g.changePct.toFixed(2)}%
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.plot}>
        {/* A series for the current asset → draw it. An error → say so. Anything else (switching
            asset, first load, refetching with nothing cached) → the spinner. Never the previous
            asset's line: `pts` is cleared the moment the asset changes (see the render reset), so
            `g` is null here until THIS asset's data lands. */}
        {g ? (
          <>
            <Text style={[styles.corner, styles.top]}>{fmt(g.max)}</Text>
            <Svg width="100%" height={H} viewBox="0 0 100 100" preserveAspectRatio="none">
              <Defs>
                <LinearGradient id="pcArea" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={color} stopOpacity={0.25} />
                  <Stop offset="1" stopColor={color} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Path d={g.area} fill="url(#pcArea)" />
              <Path d={g.path} stroke={color} strokeWidth={1.6} fill="none" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </Svg>
            <Text style={[styles.corner, styles.bottom]}>{fmt(g.min)}</Text>
          </>
        ) : error ? (
          <Text style={styles.msg}>{t('vault.price_unavailable')}</Text>
        ) : (
          <ActivityIndicator color={c.accent} />
        )}
      </View>

      {/* Under the line it sets, on the right: the period is read after the shape, not before it. */}
      <View style={styles.foot}>
        {footerLeft ?? <View />}
        <View style={styles.ranges}>
          {RANGES.map((r, i) => (
            <Pressable key={r.label} onPress={() => setRangeIdx(i)} style={[styles.pill, rangeIdx === i && styles.pillOn]}>
              <Text style={[styles.pillText, rangeIdx === i && styles.pillTextOn]}>{t(r.label)}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  // The Earn card's frame: 20 on top, 16 elsewhere.
  card: {backgroundColor: c.card, borderRadius: 20, padding: 16, paddingTop: 20, gap: 12},
  // Ruled off from the plot, as an Earn card's header is from its rows.
  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
  // The price, then the change after it, on one line; the price gives way first if space runs out.
  headPrice: {flexDirection: 'row', alignItems: 'baseline', gap: 6, flexShrink: 1},
  price: {color: c.text, fontSize: 20, fontWeight: '700', flexShrink: 1},
  change: {fontSize: 13, fontWeight: '600', flexShrink: 0},
  // Ruled off from the plot as Earn's rows are from each other.
  foot: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  ranges: {flexDirection: 'row', gap: 4},
  pill: {paddingVertical: 4, paddingHorizontal: 8, borderRadius: 7},
  pillOn: {backgroundColor: c.bg},
  pillText: {color: c.subtext, fontSize: 11, fontWeight: '600'},
  pillTextOn: {color: c.text},
  plot: {height: H, justifyContent: 'center', position: 'relative'},
  corner: {position: 'absolute', right: 0, color: c.subtext, fontSize: 10, fontVariant: ['tabular-nums']},
  top: {top: 0},
  bottom: {bottom: 0},
  msg: {color: c.subtext, fontSize: 13, textAlign: 'center'},
});

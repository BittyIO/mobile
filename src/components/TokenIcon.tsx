import React, {useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {useStyles} from '@/theme';
import {displaySymbol} from '@/core/format';
import {catalogIcon} from '@/core/assets';
import {useCatalogVersion} from '@/core/asset-catalog';
import {useNetwork} from '@/core/network-store';

/**
 * The bundled icons: ONE file per token, no per-theme variants.
 *
 * Every asset listed here ships with the binary, so this map can only ever describe the assets
 * that existed when the client was built — and new ones are launched without a release. The real
 * source is the catalog's `icon` URL, which `uri` below renders straight from the server; these
 * are the offline fallback and the head start on a cold launch.
 *
 * That is also why there is no light/dark pair for any of them. A second file per token doubles
 * what a release has to carry to say one thing, and says nothing at all about an asset added after
 * it. Each icon here is instead drawn so one file works on both cards: a pale disc takes its own
 * mark's colour (UNI, cbBTC, WBTC), and a brand-black disc is lifted to #444446, which steps off
 * #1C1C1E and still reads as black on white (HOOD, PLTR). A server-sent icon gets neither
 * treatment, so the catalog should serve marks that already hold on both grounds.
 *
 * Static requires, because Metro cannot resolve a dynamic path.
 */
const ICONS: Record<string, number> = {
  ETH: require('@/assets/tokens/eth.png'),
  WBTC: require('@/assets/tokens/wbtc.png'),
  cbBTC: require('@/assets/tokens/cbbtc.png'),
  USDC: require('@/assets/tokens/usdc.png'),
  USDT: require('@/assets/tokens/usdt.png'),
  USDG: require('@/assets/tokens/usdg.png'),
  UNI: require('@/assets/tokens/uni.png'),
  AAVE: require('@/assets/tokens/aave.png'),
  XAUt: require('@/assets/tokens/xaut.png'),
  // Tokenized stocks (Robinhood Chain and Ondo Global Markets), logos vendored from the web repo;
  // the SVG ones (SPY, GLD, HIMS, CRCL) rasterised to PNG.
  //
  // Every one of these is edge to edge. As vendored they were a pale tint disc with the brand mark
  // inset at 0.83 of the frame, which read as a small logo in a halo beside the coins on the same
  // row; the tint has been recoloured to the mark's own colour.
  //
  // And every one is cropped to its disc, with the corners TRANSPARENT. Several arrived as opaque
  // squares (SPY, GLD and HIMS white; CRCL a pale lilac): the round clip below hides that on a
  // light card and very nearly hides it on a dark one — but the clip antialiases, so a pixel or
  // two of corner survives at the rim, pale against #1C1C1E. It was invisible in the light theme
  // and read as two specks beside the logo in the dark one.
  //
  // Anything added here wants the same treatment, and the test is not "is the corner white" —
  // CRCL's was not, which is how it outlived the first round of this. The test is whether the
  // corner is opaque AT ALL: outside the disc there should be nothing to clip.
  AAPL: require('@/assets/tokens/aapl.png'),
  NVDA: require('@/assets/tokens/nvda.png'),
  GOOGL: require('@/assets/tokens/googl.png'),
  META: require('@/assets/tokens/meta.png'),
  TSLA: require('@/assets/tokens/tsla.png'),
  MSTR: require('@/assets/tokens/mstr.png'),
  SPCX: require('@/assets/tokens/spcx.png'),
  SPY: require('@/assets/tokens/stocks/spy.png'),
  GLD: require('@/assets/tokens/stocks/gld.png'),
  HIMS: require('@/assets/tokens/stocks/hims.png'),
  CRCL: require('@/assets/tokens/stocks/crcl.png'),
  COIN: require('@/assets/tokens/stocks/coin.png'),
  SBET: require('@/assets/tokens/stocks/sbet.png'),
  MSFT: require('@/assets/tokens/stocks/msft.png'),
  AMZN: require('@/assets/tokens/stocks/amzn.png'),
  PLTR: require('@/assets/tokens/stocks/pltr.png'),
  AMD: require('@/assets/tokens/stocks/amd.png'),
  TSM: require('@/assets/tokens/stocks/tsm.png'),
  INTC: require('@/assets/tokens/stocks/intc.png'),
  QQQ: require('@/assets/tokens/stocks/qqq.png'),
  NFLX: require('@/assets/tokens/stocks/nflx.png'),
  HOOD: require('@/assets/tokens/stocks/hood.png'),
  BMNR: require('@/assets/tokens/stocks/bmnr.png'),
  COST: require('@/assets/tokens/stocks/cost.png'),
};
/**
 * Round token icon by symbol, with a lettered fallback for anything unmapped.
 *
 * Order of preference, and the reasons for it:
 *
 *  1. The BUNDLED icon, where this build has one. The catalog's URL used to win, and that handed
 *     every shipped asset back to the web's own file: WETH's row serves /assets/weth.png, so ETH
 *     wore the WETH mark again, and the stock logos came back as a pale tint disc with the brand
 *     inset — the exact files the bundled set exists to replace. A symbol in ICONS is one whose
 *     mark has been prepared for both themes here; the server cannot improve on it and should not
 *     be allowed to undo it.
 *  2. The catalog's URL, which is what an asset added server-side AFTER this build has. That is
 *     the whole point of the catalog, and it still works — for everything this build does not
 *     already ship, which is exactly the set it was meant to cover. Looked up BY SYMBOL when the
 *     caller passes no `uri`: four screens pass one and some thirty call sites do not, because
 *     all they have is a symbol — an order leg, a history row, a picker — and SKY, LINK, MORPHO,
 *     ARB and ENA drew lettered badges everywhere but the Overview for exactly that reason.
 *  3. A lettered badge.
 *
 * SVG is skipped outright at step 2: React Native's <Image> renders PNG and JPEG, and several
 * catalog rows point at .svg (CRCL, SPY, GLD, HIMS), which drew nothing at all — an empty hole
 * where a logo goes, rather than the badge that is meant to stand in for a missing one.
 */
export function TokenIcon({symbol, size = 28, uri}: {symbol: string; size?: number; uri?: string}) {
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  // Redraw when the rows land: the lookup below is a snapshot, and on a cold launch the first
  // paint happens before the catalog has answered.
  useCatalogVersion();
  const [remoteFailed, setRemoteFailed] = useState(false);
  const dim = {width: size, height: size, borderRadius: size / 2};
  // WETH shows as ETH, and a position's receipt token as the asset it stands for (see
  // displaySymbol): the same icon.
  const shown = displaySymbol(symbol);
  const src = ICONS[symbol] ?? ICONS[shown] ?? (shown.toUpperCase() === 'ETH' ? ICONS.ETH : undefined);
  if (src) return <Image source={src} style={dim} resizeMode="contain" />;
  const remote = uri ?? catalogIcon(network, symbol);
  // A 404, a host that is down, or a format the decoder refuses: fall through to the badge rather
  // than leave a gap, the same way the protocol marks do.
  if (remote && !remoteFailed && !/\.svgx?(?:[?#]|$)/i.test(remote))
    return <Image source={{uri: remote}} style={dim} resizeMode="contain" onError={() => setRemoteFailed(true)} />;
  // No logo asset: draw a colored badge with the ticker, so tokens without an icon read clearly
  // instead of fading into the card.
  const label = displaySymbol(symbol).slice(0, 4);
  return (
    <View style={[styles.fallback, dim, {backgroundColor: badgeColor(symbol)}]}>
      <Text style={[styles.text, {fontSize: Math.round(size * (label.length > 3 ? 0.3 : 0.36))}]}>{label}</Text>
    </View>
  );
}

// Deterministic disc color from the symbol: each lettered badge is distinct and stable across renders.
function badgeColor(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (Math.imul(h, 31) + symbol.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 45%)`;
}

const makeStyles = () => StyleSheet.create({
  fallback: {alignItems: 'center', justifyContent: 'center'},
  text: {color: '#ffffff', fontWeight: '700'},
});

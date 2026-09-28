import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {useIsDark, useStyles} from '@/theme';
import {displaySymbol} from '@/core/format';

// Static requires (Metro can't resolve dynamic paths). Icons vendored from the web repo (public/assets).
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
  SNDK: require('@/assets/tokens/stocks/sndk.png'),
  COST: require('@/assets/tokens/stocks/cost.png'),
};
// Marks whose brand version is a dark disc, which sinks into a dark card: the dark theme gets the
// same mark with its two colours swapped (light disc, dark letter).
const ICONS_DARK: Record<string, number> = {
  USDG: require('@/assets/tokens/usdg-dark.png'),
};

/** Round token icon by symbol, with a lettered fallback for anything unmapped. */
export function TokenIcon({symbol, size = 28, uri}: {symbol: string; size?: number; uri?: string}) {
  const styles = useStyles(makeStyles);
  const dark = useIsDark();
  const dim = {width: size, height: size, borderRadius: size / 2};
  // DB-managed icon URL wins when present (see the asset catalog); bundled by-symbol icons are the
  // offline fallback, then a lettered badge for anything unmapped.
  if (uri) return <Image source={{uri}} style={dim} resizeMode="contain" />;
  // WETH shows as ETH (see displaySymbol): same icon.
  const src = (dark ? ICONS_DARK[symbol] : undefined) ?? ICONS[symbol] ?? (symbol.toUpperCase() === 'ETH' || symbol.toUpperCase() === 'WETH' ? ICONS.ETH : undefined);
  if (src) return <Image source={src} style={dim} resizeMode="contain" />;
  // No logo asset: draw a colored badge with the ticker, so tokens without an icon (e.g. the Robinhood
  // stocks SPY / GLD / HIMS) read clearly instead of fading into the card.
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

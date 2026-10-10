import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {TokenIcon} from '@/components/TokenIcon';
import {displaySymbol} from '@/core/format';
import {fmtUsd} from '@/core/prices';
import {fmtCap, fmtChange} from '@/vault/useMarketStats';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * An asset as a WATCH LIST shows it: what it costs, what it did today, and how big it is.
 *
 * Not what you hold of it — that is the Overview's other row, and the difference is the whole
 * point of the two. A watch list is mostly assets at a balance of zero, where a column of dashes
 * and another of "$0.00" said nothing at all.
 *
 * Laid out as the holdings row is, so the two lists read as one page rather than as two designs:
 * the left is the asset — its mark, its ticker, and under it the price with the day's move in
 * brackets — and the right-hand end carries the one figure that is only true of a market, the cap.
 *
 * Which is a swap of where those two used to sit. The cap had a column of its own that took a
 * third of the row and a switch in the ⋯ menu to turn off again, leaving the price marooned in the
 * middle; and for a while the cap was the ticker's second line, which put a figure in the slot the
 * Overview uses for the price and left the right-hand end of a market row empty. Price belongs
 * under the ticker because that is where the Overview puts it; the cap belongs at the end because
 * that is where every figure in this app is read.
 */
export function MarketRow({
  symbol,
  icon,
  price,
  change24h,
  marketCap,
  first,
  onPress,
  onLongPress,
}: {
  symbol: string;
  icon?: string;
  price: number | null | undefined;
  change24h: number | null | undefined;
  marketCap: number | null | undefined;
  first?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const {language} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const change = fmtChange(change24h ?? undefined);
  // Nothing rather than a dash: the cap is absent while the stats load and for anything the
  // catalog has no market id for, and a column of em dashes reads as missing data where an empty
  // end reads as an asset with no cap to state.
  const cap = marketCap != null ? fmtCap(marketCap, language) : null;
  return (
    <View style={!first && styles.rowSeparator}>
      {/* No breakdown to open and no amounts to mask: every figure here is market data, so the
          whole row is one target and the eye leaves it alone. */}
      <Pressable style={styles.rowInner} onPress={onPress} onLongPress={onLongPress} delayLongPress={220}>
        <View style={styles.assetCell}>
          <TokenIcon symbol={symbol} uri={icon} size={30} />
          <View style={styles.assetText}>
            <Text style={styles.sym}>{displaySymbol(symbol)}</Text>
            {/* The price and what it did today, as one line — the same line the Overview's
                holdings row prints, down to the brackets and the colour. */}
            <Text style={styles.sub}>
              {price != null ? fmtUsd(price) : '—'}
              {change ? (
                <Text style={{color: (change24h ?? 0) >= 0 ? c.success : c.danger}}> ({change})</Text>
              ) : null}
            </Text>
          </View>
        </View>
        {cap && cap !== '—' ? <Text style={styles.cap}>{cap}</Text> : null}
      </Pressable>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    rowSeparator: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    rowInner: {flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 10},
    assetCell: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1},
    assetText: {flexShrink: 1, minWidth: 0},
    sym: {color: c.text, fontSize: 15, fontWeight: '600'},
    // The price and the day's move, as the holdings row reads them: one quiet line under the
    // ticker, the percentage coloured and the rest of it muted.
    sub: {color: c.subtext, fontSize: 12, marginTop: 2},
    /**
     * The cap, at the row's right-hand end.
     *
     * Quiet, and not semibold. It lines up with the amounts on the Overview's list, but it is not
     * one of them: an amount there is the user's own holding, and this is a fact about the market
     * that the row is listed under. At the weight of an amount a column of them read as the thing
     * the list was about, which is the price.
     */
    cap: {color: c.subtext, fontSize: 15, fontVariant: ['tabular-nums']},
  });

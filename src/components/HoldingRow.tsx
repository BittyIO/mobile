import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Amount} from '@/components/Amount';
import {TokenIcon} from '@/components/TokenIcon';
import {displaySymbol, fmtHolding, fmtShort} from '@/core/format';
import {fmtUsd, fmtValue} from '@/core/prices';
import {fmtChange} from '@/vault/useMarketStats';
import {useColors, useStyles, type Colors} from '@/theme';

/** The eye above the total is off, so every figure that is the user's own reads as this. */
export const MASK = '••••';

/**
 * An asset as the OVERVIEW shows it: what you hold, what it is worth, and what it has made.
 *
 * The counterpart to {MarketRow}, which answers the other question — a watch list asks what an
 * asset is doing, and this asks what yours is doing. The pair of them is why both are components
 * rather than two branches of one row function: the branches shared a name and almost nothing
 * else, and the screen that held them was the longest file in the app.
 *
 * The behaviour stays with the caller. The breakdown that opens under it, the drag that picks it
 * up and the balances it is drawn from all belong to the screen; what is here is the row.
 */
export function HoldingRow({
  symbol,
  icon,
  price,
  change24h,
  total,
  earned = 0,
  usd,
  hidden,
  first,
  onPress,
  onLongPress,
  onAmountPress,
  iconNode,
}: {
  symbol: string;
  icon?: string;
  /** A mark of the caller's own in place of the token icon — TRX, which no token catalog lists. */
  iconNode?: React.ReactNode;
  /** Unit price, under the ticker. */
  price: number | null | undefined;
  /**
   * The day's move, in brackets after that price — "$3,412.10 (+0.34%)".
   *
   * The same figure the watch list prints, on the row for an asset you actually hold, which is
   * where the question "is this up or down today" gets asked about a position rather than about a
   * market. It rides with the price because it is the price's context: how far the number beside
   * it has moved since yesterday, not a fact about the holding.
   *
   * Absent while the stats load and for anything the catalog has no market id for, and then the
   * brackets are not drawn at all — a price followed by "(—%)" reads as a broken figure.
   */
  change24h?: number | null;
  total: number;
  /** The part of the total that is yield, split out of it rather than added to it. */
  earned?: number;
  usd: number | null | undefined;
  hidden: boolean;
  first?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /** The amounts are their own target: they open the breakdown rather than the trade page. */
  onAmountPress?: () => void;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const change = fmtChange(change24h);
  return (
    <View style={!first && styles.rowSeparator}>
      {/* The row goes to Trade. The amounts on the right are their own target and open the
          breakdown instead — a nested pressable wins over the one around it, so the two do not
          fight, and the split matches what each half is about: the asset, and what you hold of it. */}
      {/* onLongPress is here for its side effect as much as its handler: once Pressability has
          fired a long press it suppresses the tap, so releasing after a hold does not also open
          the trade page. The drag itself is armed by a timer on the wrapper, which survives the
          small finger drift that cancels a Pressable's press. */}
      <Pressable style={styles.rowInner} onPress={onPress} onLongPress={onLongPress} delayLongPress={220}>
        <View style={styles.assetCell}>
          {iconNode ?? <TokenIcon symbol={symbol} uri={icon} size={30} />}
          <View style={styles.assetText}>
            {/* The ticker alone. What the company is belongs on the Trade directory, where you are
                choosing between assets; here you already know what you hold. */}
            <Text style={styles.sym}>{displaySymbol(symbol)}</Text>
            {price != null ? (
              <Text style={styles.sub}>
                {fmtUsd(price)}
                {change ? (
                  <Text style={{color: (change24h ?? 0) >= 0 ? c.success : c.danger}}> ({change})</Text>
                ) : null}
              </Text>
            ) : null}
          </View>
        </View>
        <Pressable style={styles.amtCol} hitSlop={8} disabled={!onAmountPress} onPress={onAmountPress}>
          <Text style={styles.amt}>
            {hidden ? (
              MASK
            ) : earned > 0 ? (
              <>
                <Amount v={fmtHolding(total - earned)} size={15} weight="600" />{' '}
                <Text style={styles.amtEarned}>+ <Amount v={fmtShort(earned)} size={13} color={c.success} weight="600" /></Text>
              </>
            ) : (
              <Amount v={fmtHolding(total)} size={15} weight="600" />
            )}
          </Text>
          {hidden ? <Text style={styles.sub}>{MASK}</Text> : usd != null ? <Text style={styles.sub}>{fmtValue(usd)}</Text> : null}
        </Pressable>
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
    amtCol: {alignItems: 'flex-end'},
    amt: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
    sub: {color: c.subtext, fontSize: 12, marginTop: 2},
    amtEarned: {color: c.success, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
  });

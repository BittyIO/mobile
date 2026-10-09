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
 * Its own component because the market-cap toggle in the watch list's ⋯ menu draws one too, as a
 * preview of what the switch does. A preview that is a copy of the row stops being a preview the
 * first time the row changes.
 */
export function MarketRow({
  symbol,
  icon,
  price,
  change24h,
  marketCap,
  showCap,
  first,
  onPress,
  onLongPress,
}: {
  symbol: string;
  icon?: string;
  price: number | null | undefined;
  change24h: number | null | undefined;
  marketCap: number | null | undefined;
  /** Does this list show the cap column? The price moves when it does — see below. */
  showCap: boolean;
  first?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const {language} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const change = fmtChange(change24h ?? undefined);
  return (
    <View style={!first && styles.rowSeparator}>
      {/* No breakdown to open and no amounts to mask: every figure here is market data, so the
          whole row is one target and the eye leaves it alone. */}
      <Pressable style={styles.rowInner} onPress={onPress} onLongPress={onLongPress} delayLongPress={220}>
        <View style={styles.assetCell}>
          <TokenIcon symbol={symbol} uri={icon} size={30} />
          <View style={styles.assetText}>
            <Text style={styles.sym}>{displaySymbol(symbol)}</Text>
          </View>
        </View>
        {/* With a cap column the price sits in the middle of the row, between the ticker and the
            cap; without one there is nothing to its right, so it takes the right edge — where
            every other figure in the app is read, and where a centred column would otherwise
            leave a band of empty card. */}
        <View style={[styles.priceCol, !showCap && styles.priceColEnd]}>
          <Text style={styles.amt}>{price != null ? fmtUsd(price) : '—'}</Text>
          {change ? (
            <Text style={[styles.change, {color: (change24h ?? 0) >= 0 ? c.success : c.danger}]}>{change}</Text>
          ) : null}
        </View>
        {showCap ? (
          <View style={styles.capCol}>
            <Text style={styles.cap}>{fmtCap(marketCap ?? undefined, language)}</Text>
          </View>
        ) : null}
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
    priceCol: {flex: 1, alignItems: 'center'},
    priceColEnd: {alignItems: 'flex-end'},
    capCol: {flex: 1, alignItems: 'flex-end'},
    amt: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
    change: {fontSize: 12, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums']},
    cap: {color: c.subtext, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums']},
  });

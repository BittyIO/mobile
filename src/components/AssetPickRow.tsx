import React from 'react';
import {Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {displaySymbol} from '@/core/format';
import type {Asset} from '@/core/assets';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * The query match, in the accent colour. Lifted out of the Trade directory so the one row the
 * picker and the directory now share highlights a search the same way in both.
 */
function Highlight({text, q, style, numberOfLines}: {text: string; q: string; style?: StyleProp<TextStyle>; numberOfLines?: number}) {
  const c = useColors();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {text.slice(0, i)}
      <Text style={{color: c.accent}}>{text.slice(i, i + q.length)}</Text>
      {text.slice(i + q.length)}
    </Text>
  );
}

/**
 * ONE asset row, for every asset-selection surface — the Trade directory and the Select-asset
 * picker both draw this, so the two can no longer drift. The surfaces differ only in what the row
 * SHOWS and DOES, which are props: a right-hand `value` (a price, a balance, or nothing), an
 * optional `check` (the accent tick a picker puts beside the chosen one, or the muted mark a
 * funded-and-locked row wears), and what a tap means via `onPress`.
 *
 * `query` highlights the ticker/name when the surface has a search; pass '' where it has none.
 */
export function AssetPickRow({
  asset,
  onPress,
  disabled = false,
  first = false,
  query = '',
  value,
  check = 'none',
  iconSize = 30,
}: {
  asset: Asset;
  onPress: () => void;
  /** A row that cannot be acted on — a funded entry whose tick is a statement of fact. */
  disabled?: boolean;
  /** The first row of a card draws no divider above it. */
  first?: boolean;
  /** Search query, for highlighting the match. '' (default) draws plain text. */
  query?: string;
  /** Right-hand figure — a price or a held balance, already formatted. Omitted draws nothing. */
  value?: string | null;
  /** The tick: accent for "chosen", muted for "held and locked", none for no mark. */
  check?: 'accent' | 'muted' | 'none';
  iconSize?: number;
}) {
  const {company} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const local = company(asset.symbol, asset.tokenName) as string | undefined;
  /**
   * A tokenized stock or fund: under the ticker, the company in full and who issued the token —
   * "Circle Internet Group (Ondo Tokenized)".
   *
   * The company is the token's own name with the issuer part taken off, where the catalog's short
   * label says only "Circle"; a language's own name for the company still leads where it has one.
   * The issuer is said the way the token's own name says it, "(Ondo Tokenized)" or "• Robinhood
   * Token", and by the issuer's name where the token's name does not (Coinbase's on Base). The
   * token's own ticker (CRCLon) is left off. All of it comes with the catalog (see {Asset.fullName}).
   */
  const fullCompany = asset.fullName?.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*•.*$/, '').trim();
  const title = fullCompany && local === asset.tokenName ? fullCompany : local;
  // The issuer as the token's own name says it, "(Ondo Tokenized)" or "• Robinhood Token", and by
  // the issuer's name where the token's name does not (Coinbase's on Base).
  const issuerLabel = asset.fullName
    ? asset.fullName.match(/\(([^)]+)\)\s*$/)?.[1] ?? asset.fullName.match(/•\s*(.+)$/)?.[1] ?? asset.issuer ?? null
    : null;
  return (
    <Pressable
      style={({pressed}) => [styles.row, !first && styles.divided, pressed && !disabled && styles.pressed]}
      disabled={disabled}
      onPress={onPress}>
      <TokenIcon symbol={asset.symbol} size={iconSize} />
      <View style={styles.name}>
        <Highlight text={displaySymbol(asset.symbol)} q={query} style={styles.symbol} />
        {/* A stock's full company name and its issuer on the one line under the ticker:
            "Circle Internet Group (Ondo Tokenized)". Two lines at most, so a long name never cuts
            the issuer off. */}
        {issuerLabel ? (
          <Highlight text={title ? `${title} (${issuerLabel})` : issuerLabel} q={query} style={styles.company} numberOfLines={2} />
        ) : local ? (
          <Highlight text={local} q={query} style={styles.company} numberOfLines={1} />
        ) : null}
      </View>
      {value ? <Text style={styles.value}>{value}</Text> : null}
      {check !== 'none' ? (
        <Svg width={20} height={20} viewBox="0 0 24 24">
          <Path
            d="M20 6 9 17l-5-5"
            stroke={check === 'muted' ? c.subtext : c.accent}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10},
    divided: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    pressed: {opacity: 0.6},
    name: {flex: 1},
    symbol: {color: c.text, fontSize: 16, fontWeight: '600'},
    company: {color: c.subtext, fontSize: 12, marginTop: 1},
    value: {color: c.subtext, fontSize: 14, fontVariant: ['tabular-nums']},
  });

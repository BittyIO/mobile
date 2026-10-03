import React, {useMemo} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {CopyAddress} from '@/components/CopyAddress';
import {TokenIcon} from '@/components/TokenIcon';
import {assetDescription} from '@/core/asset-info';
import {ASSETS, isAmmLiquid} from '@/core/assets';
import {displaySymbol} from '@/core/format';
import {useNetwork, networkLabel} from '@/core/network-store';
import {fmtUsd} from '@/core/prices';
import {usePrices} from '@/vault/usePrices';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * One asset, in full: what it is, what the vault holds of it, and how it can be traded.
 *
 * Pushed from the ⓘ on the pair screen, which is the moment the question comes up: the pair page
 * says what the asset COSTS and nothing whatever about what it is. A ticker is not an explanation —
 * SBET and BMNR mean nothing to anyone who has not already looked them up — so the paragraph is the
 * point of this screen, and the rows under it are the details that paragraph cannot carry.
 *
 * Deliberately NOT a holdings screen. What the vault holds of an asset is the Overview's question,
 * answered there and on the Earn rows; repeating it here made this page about the balance and left
 * "what am I even buying" unanswered.
 */
export function AssetDetailScreen() {
  const {t, company} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {symbol} = useRoute<RouteProp<RootStackParamList, 'AssetDetail'>>().params;
  const network = useNetwork((s) => s.network);
  const asset = useMemo(() => ASSETS[network].find((a) => a.symbol === symbol), [network, symbol]);

  const prices = usePrices(network);
  const price = prices.get(symbol) ?? null;

  if (!asset) return <View style={styles.container} />;

  const sym = displaySymbol(asset.symbol);
  const about = assetDescription(asset.symbol);

  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentContainerStyle={styles.body}>
      {/* The asset itself: what it is, and what one of it costs. */}
      <View style={styles.hero}>
        <TokenIcon symbol={asset.symbol} uri={asset.icon} size={56} />
        <Text style={styles.sym}>{sym}</Text>
        {company(asset.symbol, asset.company) ? (
          <Text style={styles.company}>{company(asset.symbol, asset.company)}</Text>
        ) : null}
        <Text style={styles.price}>{price != null ? fmtUsd(price) : '—'}</Text>
      </View>

      {/* The paragraph this screen exists for. Absent for an asset nobody has written one for yet,
          in which case the rows below stand on their own rather than a heading over a blank. */}
      {about ? (
        <View style={styles.card}>
          <Text style={styles.about}>{about}</Text>
        </View>
      ) : null}

      <Text style={styles.section}>{t('vault.token')}</Text>
      <View style={styles.card}>
        <Row label={t('mobile.settings.network')} value={networkLabel(network, t)} />
        <Row
          label={t('mobile.trade.contract')}
          // Full, not elided, and copyable: an address is told apart from another by its middle.
          value={<CopyAddress address={asset.address} textStyle={styles.mono} iconSize={13} numberOfLines={2} />}
        />
        {/* Why a pair offers Limit only: the guard registers the Ondo and Robinhood stocks without
            the AMM-liquid bit, because no Uniswap pool prices them. Said here rather than left for
            the order form to refuse. */}
        <Row
          label={t('mobile.trade.market_trading')}
          value={isAmmLiquid(network, asset.symbol) ? t('mobile.trade.market_available') : t('mobile.trade.limit_only')}
          tone={isAmmLiquid(network, asset.symbol) ? c.success : c.subtext}
        />
      </View>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
  tone?: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      {typeof value === 'string' ? (
        <Text style={[styles.value, strong && styles.valueStrong, tone ? {color: tone} : null]} numberOfLines={1}>
          {value}
        </Text>
      ) : (
        <View style={styles.valueSlot}>{value}</View>
      )}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 8, paddingBottom: 32},
    hero: {alignItems: 'center', gap: 6, paddingVertical: 12},
    sym: {color: c.text, fontSize: 22, fontWeight: '700'},
    company: {color: c.subtext, fontSize: 14},
    price: {color: c.text, fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 4},
    section: {color: c.subtext, fontSize: 13, fontWeight: '600', paddingHorizontal: 4, marginTop: 12},
    // Prose, so it gets reading leading rather than the tight spacing a row of figures wants.
    about: {color: c.text, fontSize: 14, lineHeight: 21, paddingVertical: 16},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      minHeight: 52,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    label: {color: c.subtext, fontSize: 14},
    value: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right'},
    valueStrong: {fontWeight: '700'},
    valueSlot: {flexShrink: 1, alignItems: 'flex-end'},
    mono: {color: c.text, fontSize: 12, fontFamily: 'Menlo'},
  });

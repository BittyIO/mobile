import React, {useMemo} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {CopyAddress} from '@/components/CopyAddress';
import {TokenIcon} from '@/components/TokenIcon';
import {assetDescription} from '@/core/asset-info';
import {isAmmLiquid} from '@/core/assets';
import {adapterByName} from '@/core/protocols';
import {displaySymbol} from '@/core/format';
import {useNetwork, networkLabel} from '@/core/network-store';
import {fmtUsd} from '@/core/prices';
import {usePrices} from '@/vault/usePrices';
import {useAssetDetail} from '@/vault/useAssetDetail';
import {fmtCap, fmtChange, fmtCompact} from '@/vault/useMarketStats';
import {useColors, useStyles, type Colors, MONO} from '@/theme';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';
import {openLink} from '@/core/open-link';

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
  const {t, company, language} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {symbol} = useRoute<RouteProp<RootStackParamList, 'AssetDetail'>>().params;
  const network = useNetwork((s) => s.network);
  const catalog = useAssetCatalog(network);
  const asset = useMemo(() => catalog.find((a) => a.symbol === symbol), [catalog, symbol]);

  const prices = usePrices(network);
  const price = prices.get(symbol) ?? null;
  /**
   * The figures the page is mostly about, from the server.
   *
   * Everything here — a description, a market cap, a supply, an all-time high — has no on-chain
   * source and no local one that could stay true: the app shipped with two dozen hand-written
   * paragraphs and nothing at all for an asset added after the build. CoinGecko answers a phone
   * with a 403 and the key cannot ship in a client, so the app's own server asks on its behalf.
   */
  const detail = useAssetDetail(network, symbol);

  if (!asset) return <View style={styles.container} />;

  const sym = displaySymbol(asset.symbol);
  /**
   * The local paragraph first, where there is one.
   *
   * Not staleness tolerance — the opposite. These are written about the COMPANY or the protocol
   * and hold on every chain, where CoinGecko's copy describes the wrapper it has an id for:
   * "AAPLon is the Ondo Tokenized version of Apple" is simply wrong on Robinhood's chain, where
   * the same ticker is Robinhood's token. The server's copy is what fills the gap for everything
   * nobody has written about — which is every asset added since this build.
   */
  const about = assetDescription(asset.symbol) ?? detail?.description ?? null;
  const change = (v: number | null | undefined) => {
    const text = fmtChange(v);
    return text ? <Text style={{color: (v ?? 0) >= 0 ? c.success : c.danger}}>{text}</Text> : null;
  };
  const periods: [string, number | null | undefined][] = [
    ['vault.period_24h', detail?.change.h24],
    ['vault.period_1w', detail?.change.d7],
    ['vault.period_1m', detail?.change.d30],
    ['vault.period_1y', detail?.change.y1],
  ];
  const hasMarket = !!detail && (detail.marketCap != null || detail.volume24h != null || detail.rank != null);

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
        {company(asset.symbol, asset.tokenName) ? (
          <Text style={styles.company}>{company(asset.symbol, asset.tokenName)}</Text>
        ) : null}
        {/* A tokenized stock is one issuer's claim on the share: which one, under the company. */}
        {asset.issuer ? <Text style={styles.issuer}>{t('mobile.trade.issued_by', {issuer: asset.issuer})}</Text> : null}
        <Text style={styles.price}>{price != null ? fmtUsd(price) : '—'}</Text>
        {/* The day's move under the figure it moved: a price with nothing beside it says what to
            pay and not whether it is a good moment, which is the question the number invites. */}
        {change(detail?.change.h24) ? <Text style={styles.heroChange}>{change(detail?.change.h24)}</Text> : null}
      </View>

      {/* The paragraph this screen exists for. Absent for an asset nobody has written one for yet,
          in which case the rows below stand on their own rather than a heading over a blank. */}
      {about ? (
        <View style={styles.card}>
          <Text style={styles.about}>{about}</Text>
        </View>
      ) : null}

      {/* What the market makes of it. Each row is dropped when the server has nothing for it —
          a tokenized stock has a company market cap and no circulating supply worth printing,
          and an asset with no CoinGecko id has none of this at all. */}
      {hasMarket ? (
        <>
          <Text style={styles.section}>{t('mobile.trade.market')}</Text>
          <View style={styles.card}>
            {detail?.marketCap != null ? (
              <Row label={t('mobile.trade.market_cap')} value={fmtCap(detail.marketCap, language)} />
            ) : null}
            {detail?.volume24h != null ? (
              <Row label={t('mobile.trade.volume_24h')} value={fmtCap(detail.volume24h, language)} />
            ) : null}
            {detail?.circulating != null ? (
              <Row
                label={t('mobile.trade.circulating')}
                value={`${fmtCompact(detail.circulating, language)} ${sym}`}
              />
            ) : null}
            {detail?.ath != null ? <Row label={t('mobile.trade.all_time_high')} value={fmtUsd(detail.ath)} /> : null}
            {detail?.rank != null ? <Row label={t('mobile.trade.rank')} value={`#${detail.rank}`} /> : null}
            {detail?.website ? (
              <Row
                label={t('mobile.trade.website')}
                value={
                  <Pressable onPress={() => openLink(detail.website as string, sym)} hitSlop={8}>
                    <Text style={styles.link} numberOfLines={1}>
                      {detail.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                    </Text>
                  </Pressable>
                }
              />
            ) : null}
          </View>
        </>
      ) : null}

      {/* One line, four periods — the shape every price page uses, and the only place on this
          screen where the numbers are worth comparing across columns rather than reading down. */}
      {periods.some(([, v]) => v != null) ? (
        <>
          <Text style={styles.section}>{t('mobile.trade.performance')}</Text>
          <View style={styles.perfCard}>
            {periods.map(([key, v]) => (
              <View key={key} style={styles.perfCell}>
                <Text style={styles.perfLabel}>{t(key)}</Text>
                <Text style={styles.perfValue}>{change(v) ?? <Text style={styles.perfNone}>—</Text>}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <Text style={styles.section}>{t('vault.token')}</Text>
      <View style={styles.card}>
        {/* The token's own name and ticker, and its issuer — served with the catalog for an equity. */}
        {asset.fullName ? (
          <>
            {/* Wraps rather than clipping: the full name is the point, and some run to a sentence. */}
            <Row
              label={t('mobile.trade.token_name')}
              value={
                <Text style={styles.value} numberOfLines={3}>
                  {asset.fullName}
                </Text>
              }
            />
            {asset.tokenSymbol ? <Row label={t('mobile.trade.token_symbol')} value={asset.tokenSymbol} /> : null}
            {asset.issuer ? <Row label={t('mobile.trade.issuer')} value={asset.issuer} /> : null}
          </>
        ) : null}
        <Row label={t('mobile.settings.network')} value={networkLabel(network, t)} />
        <Row
          label={t('mobile.trade.contract')}
          // Full, not elided, and copyable: an address is told apart from another by its middle.
          value={<CopyAddress address={asset.address} textStyle={styles.mono} iconSize={13} numberOfLines={2} />}
        />
        {/* Why a pair offers Limit only: the guard registers the Ondo and Robinhood stocks without
            the AMM-liquid bit, because no Uniswap pool prices them. Said here rather than left for
            the order form to refuse. */}
        {/* And where there are no limit orders either (Robinhood: no CoW, and its UniswapX adapter
            is retired), an asset the guard cannot price for Market is not tradable at all. */}
        <Row
          label={t('mobile.trade.market_trading')}
          value={
            isAmmLiquid(network, asset.symbol)
              ? t('mobile.trade.market_available')
              : adapterByName(network, 'CoW Swap')
                ? t('mobile.trade.limit_only')
                : t('mobile.trade.not_tradable_title')
          }
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
    issuer: {color: c.subtext, fontSize: 12},
    price: {color: c.text, fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 4},
    heroChange: {fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
    link: {color: c.accent, fontSize: 15},
    // Four equal columns rather than four rows: the periods are read against each other.
    perfCard: {backgroundColor: c.card, borderRadius: 20, flexDirection: 'row', paddingVertical: 16},
    perfCell: {flex: 1, alignItems: 'center', gap: 4},
    perfLabel: {color: c.subtext, fontSize: 12, fontWeight: '600'},
    perfValue: {fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
    perfNone: {color: c.subtext},
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
    mono: {color: c.text, fontSize: 12, fontFamily: MONO},
  });

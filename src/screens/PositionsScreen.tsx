import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '@/App';
import {PositionPanel} from '@/components/PositionPanel';
import {TokenIcon} from '@/components/TokenIcon';
import {useAssetCatalog} from '@/core/asset-catalog';
import {displaySymbol} from '@/core/format';
import {useNetwork} from '@/core/network-store';
import {fmtValue} from '@/core/prices';
import {fetchPositions, type Position} from '@/vault/position';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * Overview › Distribution › Positions — every holding's position, a card each, largest first.
 *
 * Its own page, pushed from the Positions row under the donut: the list runs long, and the
 * distribution reads better as the donut alone. The holdings arrive as the Overview had them (the
 * route's params, passed on by Distribution); the positions are the server's, all in one request
 * (see {fetchPositions}). Stablecoins are left out: a dollar has no cost or P&L worth a card.
 */
export function PositionsScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {vault, held, total} = useRoute<RouteProp<RootStackParamList, 'Positions'>>().params;
  const network = useNetwork((s) => s.network);
  const catalog = useAssetCatalog(network);

  // `undefined` while the request is out, `null` when it failed, else the list. Stablecoins are
  // left out: a dollar has no cost or P&L worth a card.
  const [positions, setPositions] = useState<Position[] | null | undefined>(undefined);
  const symbols = useMemo(
    () => held.map((h) => h.symbol).filter((sym) => catalog.find((a) => a.symbol === sym)?.kind !== 'stable'),
    [held, catalog],
  );
  const key = symbols.join(',');
  useEffect(() => {
    if (!vault) return;
    let live = true;
    setPositions(undefined);
    fetchPositions(vault, network, key ? key.split(',') : [])
      .then((p) => live && setPositions(p))
      .catch(() => live && setPositions(null));
    return () => {
      live = false;
    };
  }, [vault, network, key]);

  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentContainerStyle={styles.body}>
      {positions === undefined ? (
        <ActivityIndicator color={c.accent} style={styles.spinner} />
      ) : !positions || positions.length === 0 ? (
        <Text style={styles.empty}>{t('vault.none')}</Text>
      ) : (
        // Largest holding first, as the distribution lists them.
        [...positions]
          .sort((x, y) => (y.marketValue ?? 0) - (x.marketValue ?? 0))
          .map((p) => (
            <View key={p.symbol} style={styles.card}>
              <View style={styles.head}>
                <TokenIcon symbol={p.symbol} size={24} uri={held.find((h) => h.symbol === p.symbol)?.icon} />
                <Text style={styles.sym}>{displaySymbol(p.symbol)}</Text>
                <Text style={styles.val}>{fmtValue(p.marketValue ?? 0)}</Text>
              </View>
              <PositionPanel position={p} portfolioValue={total} bare noPercent />
            </View>
          ))
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    // The Earn and Overview cards' frame: 16 between cards, 20 on top inside one, 16 elsewhere.
    body: {padding: 16, gap: 16, paddingBottom: 40},
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, paddingTop: 20, gap: 16},
    head: {flexDirection: 'row', alignItems: 'center', gap: 8},
    sym: {color: c.text, fontSize: 16, fontWeight: '600', flex: 1},
    val: {color: c.text, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums']},
    spinner: {marginTop: 32},
    empty: {color: c.subtext, fontSize: 15, textAlign: 'center', marginTop: 32},
  });

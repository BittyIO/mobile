import React, {useMemo} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {AssetCategoryList} from '@/components/AssetCategoryList';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useAssetPick} from '@/core/asset-pick';
import {displaySymbol, fmtShort} from '@/core/format';
import {useNetwork} from '@/core/network-store';
import {balanceOfSymbol, ownerVaultAddress} from '@/vault/read';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {useWallet} from '@/wallet/store';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Which asset to trade — a PAGE, not a sheet.
 *
 * It was a sheet, and a sheet is the wrong container for a list long enough to scroll: the drag
 * that scrolls it is the same gesture that dismisses it, so on a chain with two dozen tokenized
 * stocks reaching for one near the bottom threw the sheet away instead. A page scrolls, and the
 * way out is the back button rather than a gesture that overlaps the one you need.
 *
 * Pushed with a slot rather than a callback, and it answers through {useAssetPick}: a function in
 * navigation params is state React Navigation is right to complain about.
 */
export function SelectAssetScreen() {
  const {t, company} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {params} = useRoute<RouteProp<RootStackParamList, 'SelectAsset'>>();
  const slot = params?.slot ?? 'base';
  const selected = params?.selected;

  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const catalog = useAssetCatalog(network);
  const balances = useVaultBalances(network);
  const positions = useVaultPositions(vault, network);
  const pick = useAssetPick((s) => s.pick);

  /**
   * The quote side is stable coins only — that is what a pair is quoted in — and the base side is
   * everything else the catalog has, with the quote leg itself left out so a pair cannot be set to
   * the same asset twice.
   */
  const assets = useMemo(
    () =>
      slot === 'quote'
        ? catalog.filter((a) => a.kind === 'stable')
        : catalog.filter((a) => a.symbol !== params?.exclude),
    [catalog, slot, params?.exclude],
  );

  /**
   * What the vault holds of an asset, EVERYWHERE: its free balance plus every yielding and lending
   * position in it.
   *
   * The sheet this replaces carried the same figure, and for the reason it was added: a list of
   * symbols alone meant leaving the picker to find out whether there was anything to trade with,
   * and a balance sitting in Earn looked like no balance at all.
   */
  const totalOf = (symbol: string): number =>
    Number(balanceOfSymbol(balances.balances, symbol) || 0) +
    positions.positions
      .filter((p) => p.symbol === symbol && (p.kind === 'staked' || p.kind === 'supplied'))
      .reduce((n, p) => n + Number(p.formatted || 0), 0);

  return (
    <ScrollView
      style={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.body}>
        {/* The tabs sit OUTSIDE the card and the categories swipe — see {AssetCategoryList}. Inside
            it they read as a heading for the rows beneath them, and the only way between categories
            was tapping the tab itself. */}
        <AssetCategoryList
          swipe={slot !== 'quote'}
          pageStyle={styles.card}
          assets={assets}
          // What the vault holds leads its category: that is nearly always what the picker was
          // opened to trade, and in catalog order it sat below two dozen stocks held at nothing.
          funded={(a) => totalOf(a.symbol) > 0}
          renderItem={(a, i) => {
            const held = totalOf(a.symbol);
            const on = !!selected && displaySymbol(selected) === displaySymbol(a.symbol);
            return (
              <Pressable
                style={({pressed}) => [styles.row, i > 0 && styles.divided, pressed && styles.pressed]}
                onPress={() => {
                  pick(slot, a.symbol);
                  nav.goBack();
                }}>
                <TokenIcon symbol={a.symbol} size={30} />
                <View style={styles.name}>
                  <Text style={styles.symbol}>{displaySymbol(a.symbol)}</Text>
                  {company(a.symbol, a.tokenName) ? (
                    <Text style={styles.company} numberOfLines={1}>
                      {company(a.symbol, a.tokenName) as string}
                    </Text>
                  ) : null}
                </View>
                {/* Nothing printed against a zero: an empty right-hand end reads as "none" without
                    putting a column of noughts beside every asset the vault has never held. */}
                {held > 0 ? <Amount v={fmtShort(held)} size={14} color={c.subtext} /> : null}
                {on ? (
                  <Svg width={18} height={18} viewBox="0 0 24 24">
                    <Path
                      d="M20 6 9 17l-5-5"
                      stroke={c.accent}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </Svg>
                ) : null}
              </Pressable>
            );
          }}
          placeholder={t('mobile.trade.search_assets')}
          /**
           * The quote side gets neither control.
           *
           * A chain has two or three stable coins: all of them are in view, so a magnifier can only
           * find what is already on screen, and they are all one category — so the tab row came out
           * as a lone "Crypto" above a page already titled "Select stablecoin", labelling a list it
           * does not divide and cannot be changed from.
           */
          search={slot !== 'quote'}
          categories={slot !== 'quote'}
        />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, paddingBottom: 32, gap: 10},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, gap: 2},
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10},
    divided: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    pressed: {opacity: 0.6},
    name: {flex: 1},
    symbol: {color: c.text, fontSize: 16, fontWeight: '600'},
    company: {color: c.subtext, fontSize: 12, marginTop: 1},
  });

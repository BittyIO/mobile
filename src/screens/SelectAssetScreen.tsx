import React, {useMemo} from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {AssetCategoryList} from '@/components/AssetCategoryList';
import {AssetPickRow} from '@/components/AssetPickRow';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useAssetPick} from '@/core/asset-pick';
import {useFavoriteSet} from '@/core/favorites-store';
import {displaySymbol, fmtShort} from '@/core/format';
import {usdValue} from '@/core/prices';
import {useNetwork} from '@/core/network-store';
import {balanceOfSymbol} from '@/vault/read';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {usePrices} from '@/vault/usePrices';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {useWallet} from '@/wallet/store';
import {useStyles, type Colors} from '@/theme';
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
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {params} = useRoute<RouteProp<RootStackParamList, 'SelectAsset'>>();
  const slot = params?.slot ?? 'base';
  const selected = params?.selected;

  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = useActiveVaultAddress(network);
  const catalog = useAssetCatalog(network);
  const balances = useVaultBalances(network);
  const positions = useVaultPositions(vault, network);
  const pick = useAssetPick((s) => s.pick);
  const prices = usePrices(network);
  // The active watch list, for the "Selected" first tab — the same tab, and the same default, as
  // the Trade directory. Not for the quote side: a stablecoin picker is two rows, not a directory.
  const favorites = useFavoriteSet(network);

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

  /**
   * What counts as "Selected": the watch list PLUS anything the vault actually holds worth more
   * than a dime — the same rule the Overview and the Trade directory use. Without the held half, a
   * token the vault holds but never starred (UNI on a COW/USDC vault) was missing from the one tab
   * a trader reaches for, and finding it meant scrolling the full crypto list. Judged by VALUE, so
   * a dust leftover does not earn a place.
   */
  const selectedSet = useMemo(() => {
    const s = new Set<string>(favorites);
    for (const a of assets) {
      const held = totalOf(a.symbol);
      if (held <= 0) continue;
      const v = usdValue(held, a.symbol, prices);
      if (v != null && v > 0.1) s.add(a.symbol);
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- totalOf closes over balances+positions
  }, [favorites, assets, balances.balances, positions.positions, prices]);

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
          renderItem={(a, i, _last, q) => {
            const held = totalOf(a.symbol);
            const on = !!selected && displaySymbol(selected) === displaySymbol(a.symbol);
            return (
              <AssetPickRow
                asset={a}
                first={i === 0}
                query={q}
                // Nothing against a zero: an empty end reads as "none" without a column of noughts.
                value={held > 0 ? fmtShort(held) : undefined}
                check={on ? 'accent' : 'none'}
                onPress={() => {
                  pick(slot, a.symbol);
                  nav.goBack();
                }}
              />
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
          selectedSet={slot !== 'quote' ? selectedSet : undefined}
        />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, paddingBottom: 32, gap: 10},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, gap: 2},
  });

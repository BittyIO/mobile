import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle} from 'react-native';
import Svg, {Circle, Line} from 'react-native-svg';
import {CategoryTabs} from '@/components/ui';
import {ASSET_CATEGORIES, assetCategory, type Asset, type AssetCategory} from '@/core/assets';
import {displaySymbol} from '@/core/format';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * A network's assets, under the categories they belong to, with a search.
 *
 * Three screens ask the same question — "which asset?" — and each had grown its own answer. The
 * Trade directory sorted them into Crypto / Stocks / ETFs and could search them; the asset picker
 * was one flat scroll of everything, which on a chain with two dozen tokenized stocks is a list
 * nobody can find anything in; the allow list was a third flat scroll. So the categories, the
 * search, the ranking of matches and the empty state live here, and a caller supplies only the rows.
 *
 * The caller owns the ROW, deliberately. What a row does is the only thing the three disagree
 * about: the directory opens a pair, the picker returns a choice, the allow list toggles a switch.
 * Taking `renderItem` rather than `onSelect` means none of them has to pretend to be one of the
 * others, and the component never grows a mode flag.
 */
export function AssetCategoryList({
  assets,
  renderItem,
  /** What the search field says when empty. Defaults to "Search assets". */
  placeholder,
  /** Shown in place of the rows when a category — or a search — has nothing in it. */
  empty,
  /** Drawn above the rows, inside the scroll the caller provides. */
  children,
  /**
   * One category per page, swiped sideways, with the tabs left OUTSIDE whatever the pages are in.
   *
   * The flat version puts the tabs at the top of the caller's card, which reads as a heading for
   * the rows under it — and the only way between categories is the tabs themselves. Paged, the
   * tabs sit above the card and label it, and the content moves the way a set of pages invites.
   *
   * Off by default: a picker is a list to pick from, and a sideways gesture there competes with the
   * vertical one that is the whole point of it.
   */
  swipe,
  /** The container each page's rows sit in — the card, when the tabs are outside it. */
  pageStyle,
  /**
   * Offer the search. On by default, and off where the list is short enough not to need one.
   *
   * The stablecoins are the case: there are two or three of them on any chain, every one visible
   * without scrolling, and a magnifier beside them is a control that can only ever find what is
   * already on screen.
   */
  search = true,
  /**
   * Offer the category tabs. On by default, and off where the categories say nothing.
   *
   * The stablecoins are all one category, so the row came out as a lone "Crypto" above a page
   * already titled "Select stablecoin" — a tab that cannot be changed, labelling a list it does not
   * divide. Elsewhere a lone tab is worth keeping: on the allow list and the directory it names
   * what the card below it holds, and the set grows as a chain gains assets.
   */
  categories: showCategories = true,
  /**
   * Which rows the vault actually holds. Those lead their category.
   *
   * The component cannot know — a balance is the caller's to read — so it asks. Without it a
   * picker is in catalog order, which on a chain of two dozen tokenized stocks buries the three
   * the vault has anything in; and what someone opens a picker to trade is nearly always one of
   * those three.
   *
   * A predicate rather than an amount: the order wanted is "held, then the rest", not a ranking by
   * size, and sorting by balance would shuffle the catalog's own arrangement on every price move.
   */
  funded,
  /**
   * The symbols on the user's watch list, for a synthetic "Selected" FIRST tab — the same tab the
   * Trade directory opens on. Only offered while it has something in it, and it is where the list
   * lands by default: what someone opens a picker for is nearly always an asset they curated onto
   * their list, not one of two dozen they have never touched.
   */
  selectedSet,
}: {
  assets: Asset[];
  renderItem: (asset: Asset, index: number, last: boolean, query: string) => React.ReactNode;
  placeholder?: string;
  empty?: string;
  children?: React.ReactNode;
  swipe?: boolean;
  pageStyle?: StyleProp<ViewStyle>;
  search?: boolean;
  categories?: boolean;
  funded?: (asset: Asset) => boolean;
  selectedSet?: Set<string>;
}) {
  const {t, company} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  type Tab = AssetCategory | 'selected';
  const [category, setCategory] = useState<Tab>('crypto_native');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  /** Only the categories this network actually has: an empty tab is a dead end. */
  const categories = useMemo(
    () => ASSET_CATEGORIES.filter((k) => assets.some((a) => assetCategory(a.category) === k)),
    [assets],
  );
  // Only while the list and the catalog actually intersect: a watch list carried over from another
  // network would otherwise put up a tab with nothing under it.
  const hasSelected = !!selectedSet?.size && assets.some((a) => selectedSet.has(a.symbol));
  /** One tab's rows: the watch list for "Selected", the catalog's own grouping for the rest. */
  const rowsFor = React.useCallback(
    (k: Tab) =>
      k === 'selected'
        ? assets.filter((a) => selectedSet?.has(a.symbol))
        : assets.filter((a) => assetCategory(a.category) === k),
    [assets, selectedSet],
  );
  // A category that has emptied out — a chain switch, a catalog that answered — hands back to the
  // first one that exists rather than leaving the list blank under a tab nothing is in.
  useEffect(() => {
    const valid: Tab[] = hasSelected ? ['selected', ...categories] : categories;
    if (valid.length && !valid.includes(category)) setCategory(valid[0]);
  }, [categories, category, hasSelected]);
  // Land on "Selected" once it exists — the watch list and the catalog both load after the first
  // render, so the default cannot be set at mount. Once only, and never over a tab the user has
  // already chosen by hand (`landedRef` is also set by every manual pick below).
  const landedRef = useRef(false);
  useEffect(() => {
    if (landedRef.current || !hasSelected) return;
    landedRef.current = true;
    setCategory('selected');
  }, [hasSelected]);

  /**
   * Ticker matches first, then names.
   *
   * Someone typing "A" almost always means an asset called A, not the dozen whose description
   * happens to contain the letter, and mixing the two in catalog order buried the obvious answer.
   * Within each group the match's POSITION decides, so one that starts with what was typed sorts
   * above one that merely contains it: "A" puts AAVE over BABA and Apple over Banana. Equal
   * positions keep the catalog's order, the sort being stable.
   *
   * Lifted from the Trade directory, which is where this behaviour was worked out; the picker had
   * no search at all and the allow list's matched on the ticker alone.
   */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const at = (text: (a: Asset) => string) => (x: Asset, y: Asset) =>
      text(x).toLowerCase().indexOf(q) - text(y).toLowerCase().indexOf(q);
    const symbolOf = (a: Asset) => displaySymbol(a.symbol);
    const nameOf = (a: Asset) => (company(a.symbol, a.tokenName) as string) ?? '';
    const bySymbol = assets.filter((a) => symbolOf(a).toLowerCase().includes(q)).sort(at(symbolOf));
    const hit = new Set(bySymbol.map((a) => a.address));
    const byName = assets.filter((a) => !hit.has(a.address) && nameOf(a).toLowerCase().includes(q)).sort(at(nameOf));
    return [...bySymbol, ...byName];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, assets, company]);

  /**
   * One category's rows, in the order they are worth reading.
   *
   * What the vault HOLDS first, then the stable coins — they are what everything else is priced and
   * bought in — then the catalog's own order, the sort being stable. One function, used by the flat
   * list and by every page of the pager: they had a copy each, which is how one of them would
   * eventually stop matching the other.
   *
   * Except on Selected, which keeps one fixed order — stable coins, then the catalog's. It is the
   * user's own short list, read by where things are: held-first moved a row each time a balance
   * landed or a trade emptied one, so the asset you went back for was no longer where you left it.
   */
  const sortRows = React.useCallback(
    (list: Asset[], tab: Tab) =>
      [...list].sort(
        (x, y) =>
          (funded && tab !== 'selected' ? Number(funded(y)) - Number(funded(x)) : 0) ||
          Number(y.kind === 'stable') - Number(x.kind === 'stable'),
      ),
    [funded],
  );
  const inCategory = useMemo(() => sortRows(rowsFor(category), category), [rowsFor, category, sortRows]);

  // A query in progress spans every category, so the tabs stop applying while one is typed.
  const rows = query.trim() ? results : inCategory;

  /**
   * The pager: one page per category, kept in step with the tabs in both directions.
   *
   * Its height follows the page in view, because the categories are different lengths and a pager
   * is as tall as its tallest child unless told otherwise — which would leave a short category
   * sitting above a screenful of nothing. `marketBottom` interpolates the difference away as the
   * swipe moves, so the card grows and shrinks with the gesture rather than after it.
   */
  const pagerRef = useRef<ScrollView>(null);
  const pagerX = useRef(new Animated.Value(0)).current;
  const [pageW, setPageW] = useState(0);
  const [pageH, setPageH] = useState<Record<string, number>>({});
  const realPages = categories.length > 0 ? categories : (['crypto_native'] as AssetCategory[]);
  const pages: Tab[] = hasSelected ? ['selected', ...realPages] : realPages;
  const pick = (k: Tab) => {
    landedRef.current = true;
    setCategory(k);
    const i = pages.indexOf(k);
    if (i >= 0 && pageW > 0) pagerRef.current?.scrollTo({x: i * pageW, animated: true});
  };
  const settle = (x: number) => {
    if (pageW <= 0) return;
    const k = pages[Math.max(0, Math.min(pages.length - 1, Math.round(x / pageW)))];
    if (k && k !== category) {
      landedRef.current = true;
      setCategory(k);
    }
  };
  const heights = pages.map((k) => pageH[k]);
  const sized = pages.length > 1 && pageW > 0 && heights.every((h) => h != null);
  const tallest = sized ? Math.max(...(heights as number[])) : 0;
  const pagerStyle = sized
    ? {
        height: tallest,
        marginBottom: pagerX.interpolate({
          inputRange: pages.map((_, i) => i * pageW),
          outputRange: (heights as number[]).map((h) => h - tallest),
          extrapolate: 'clamp' as const,
        }),
      }
    : undefined;
  // A different catalog is a different set of categories: start from the first one again.
  const key = pages.join(',');
  useEffect(() => {
    setPageH({});
    pagerRef.current?.scrollTo({x: 0, animated: false});
  }, [key]);

  const list = (within: Asset[]) =>
    within.length === 0 ? (
      <Text style={styles.empty}>{empty ?? t('vault.no_assets')}</Text>
    ) : (
      within.map((a, i) => (
        <React.Fragment key={a.address}>{renderItem(a, i, i === within.length - 1, query.trim())}</React.Fragment>
      ))
    );

  // Nothing to put on the head row: no tabs to show and no search to offer. The row is skipped
  // rather than rendered empty, so the rows start at the top of the page.
  const head = showCategories || search;

  return (
    <>
      {/* The tabs and the search share one line. A field of its own would push the rows down by a
          row's height on a page whose whole job is the rows, and a search that spans every category
          has nothing to do with the tab that is selected anyway. */}
      {head ? (
        <View style={styles.head}>
          {searching ? (
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder={placeholder ?? t('mobile.trade.search_assets')}
              placeholderTextColor={c.subtext}
              autoFocus
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="search"
            />
          ) : showCategories ? (
            // Shown even when the network has only one category: a lone "Crypto" still says what
            // the list below it holds, and hiding it left the card unlabelled. `categories={false}`
            // is for the lists where it says nothing at all.
            <View style={styles.tabs}>
              <CategoryTabs
                tabs={pages.map((k) => ({
                  key: k,
                  label:
                    k === 'selected'
                      ? t('vault.selected')
                      : k === 'crypto_native'
                        ? t('mobile.home.category_crypto')
                        : t(`vault.category_${k}`),
                }))}
                value={category}
                onChange={pick}
              />
            </View>
          ) : (
            // No tabs, but the search still needs pushing to the right-hand end.
            <View style={styles.tabs} />
          )}
          {search ? (
            <Pressable
              style={styles.searchBtn}
              hitSlop={8}
              onPress={() => {
                // Closing clears: a query left behind would keep the tabs suppressed with no field
                // on screen to explain why, and the only way out would be finding the ✕ again.
                setSearching((v) => !v);
                setQuery('');
              }}>
              <SearchIcon open={searching} color={c.subtext} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {children}

      {/* Searching, the result spans every category, so there are no pages to swipe between and
          the one list stands in for all of them. */}
      {!swipe || query.trim() ? (
        <View style={pageStyle}>{list(rows)}</View>
      ) : (
        <View onLayout={(e) => setPageW(e.nativeEvent.layout.width)}>
          {pageW > 0 ? (
            <Animated.ScrollView
              ref={pagerRef as never}
              horizontal
              pagingEnabled
              bounces={false}
              showsHorizontalScrollIndicator={false}
              style={pagerStyle}
              scrollEventThrottle={16}
              onScroll={Animated.event([{nativeEvent: {contentOffset: {x: pagerX}}}], {useNativeDriver: false})}
              onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.x)}>
              {pages.map((k) => (
                <View key={k} style={{width: pageW}}>
                  <View
                    style={pageStyle}
                    onLayout={(e) => {
                      // Read the height NOW: the event is pooled and recycled before a state
                      // updater would run.
                      const h = e.nativeEvent.layout.height;
                      setPageH((prev) => (prev[k] === h ? prev : {...prev, [k]: h}));
                    }}>
                    {list(sortRows(rowsFor(k), k))}
                  </View>
                </View>
              ))}
            </Animated.ScrollView>
          ) : null}
        </View>
      )}
    </>
  );
}

/** The magnifier, which becomes a ✕ once the field is open — one control, two states. */
function SearchIcon({open, color}: {open: boolean; color: string}) {
  const s = {stroke: color, strokeWidth: 1.9, fill: 'none' as const, strokeLinecap: 'round' as const};
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      {open ? (
        <>
          <Line x1={6} y1={6} x2={18} y2={18} {...s} />
          <Line x1={18} y1={6} x2={6} y2={18} {...s} />
        </>
      ) : (
        <>
          <Circle cx={11} cy={11} r={7} {...s} />
          <Line x1={16.2} y1={16.2} x2={21} y2={21} {...s} />
        </>
      )}
    </Svg>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    head: {flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36},
    tabs: {flex: 1},
    input: {
      flex: 1,
      color: c.text,
      fontSize: 15,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    searchBtn: {paddingHorizontal: 2, paddingVertical: 4},
    empty: {color: c.subtext, fontSize: 13, textAlign: 'center', paddingVertical: 36},
  });

import {useEffect, useMemo, useState} from 'react';
import type {Network} from '@/core/chain';
import {knownAssets} from '@/core/assets';
import {useCatalogVersion} from '@/core/asset-catalog';
import {fetchPrices, type PriceMap} from '@/core/prices';

/**
 * USD prices for a screen's assets, from the app's own /api/prices.
 *
 * `symbols` is what the screen actually renders, because the bundled catalog and the live one are
 * not the same list: the live catalog is the source the Overview draws from, and anything only in
 * there was never being priced. Passing nothing falls back to the bundled list, which is right for
 * a caller that has no catalog of its own.
 *
 * One request for the whole screen. The server holds each answer for a minute and coalesces
 * concurrent readers, so asking for thirty symbols costs about what asking for one does.
 */
export function usePrices(network: Network, nonce = 0, symbols?: string[]): PriceMap {
  const [prices, setPrices] = useState<PriceMap>(new Map());
  // On a cold launch the first render runs BEFORE the live catalog has answered, so the fallback
  // list is the bundled one — and without this subscription it stayed that way: the memo below
  // never recomputed, a catalog-only asset (every Base tokenized stock) was never asked for, and
  // the Limit sheet seeded no price for it. The version bump re-derives the list once the rows land.
  const catalogVersion = useCatalogVersion();
  // Sorted and joined so a re-render with the same set does not re-fetch.
  const key = useMemo(
    // `knownAssets`, not the bundled table: the fallback has to cover a token the catalog added
    // after this build, or it renders with a balance and no value beside it.
    () => [...new Set(['ETH', ...(symbols ?? knownAssets(network).map((a) => a.symbol))])].sort().join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogVersion invalidates knownAssets()
    [network, symbols, catalogVersion],
  );
  useEffect(() => {
    let live = true;
    fetchPrices(key.split(','), network).then((p) => live && setPrices(p));
    return () => {
      live = false;
    };
  }, [key, network, nonce]);
  return prices;
}

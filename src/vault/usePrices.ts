import {useEffect, useMemo, useState} from 'react';
import type {Network} from '@/core/chain';
import {ASSETS} from '@/core/assets';
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
  // Sorted and joined so a re-render with the same set does not re-fetch.
  const key = useMemo(
    () => [...new Set(['ETH', ...(symbols ?? ASSETS[network].map((a) => a.symbol))])].sort().join(','),
    [network, symbols],
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

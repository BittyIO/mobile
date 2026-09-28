import {useEffect, useState} from 'react';
import type {Network} from '@/core/chain';
import {ASSETS} from '@/core/assets';
import {fetchPrices, type PriceMap} from '@/core/prices';

/** USD prices for the network's assets (+ ETH). Refetches on network change. */
export function usePrices(network: Network, nonce = 0): PriceMap {
  const [prices, setPrices] = useState<PriceMap>(new Map());
  useEffect(() => {
    let live = true;
    const symbols = ['ETH', ...ASSETS[network].map((a) => a.symbol)];
    fetchPrices(symbols).then((p) => live && setPrices(p));
    return () => {
      live = false;
    };
  }, [network, nonce]);
  return prices;
}

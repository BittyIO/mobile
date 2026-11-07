import {create} from 'zustand';

/**
 * The price the Trade screen last quoted for an asset, in dollars — shared with every other screen.
 *
 * The Overview priced from /api/prices (Chainlink first, then a pool, cached for a minute or more)
 * while Trade priced from the live Uniswap quote, so the same ETH read two different figures one tab
 * apart. Trade's is the one an order would actually fill at, so it wins: Trade writes it here when a
 * live pool quote lands, and {usePriceFeed} lays it over the spot answer for as long as it is fresh.
 */
const FRESH_MS = 10 * 60_000;

type Entry = {usd: number; at: number};
type State = {
  prices: Record<string, Entry>;
  set: (network: string, symbol: string, usd: number) => void;
};

export const useLivePrices = create<State>((set) => ({
  prices: {},
  set: (network, symbol, usd) =>
    set((s) => ({prices: {...s.prices, [`${network}:${symbol}`]: {usd, at: Date.now()}}})),
}));

/** The live price for `symbol` on `network`, or null when there is none or it has gone stale. */
export function livePrice(prices: Record<string, Entry>, network: string, symbol: string): number | null {
  const e = prices[`${network}:${symbol}`];
  return e && Date.now() - e.at < FRESH_MS ? e.usd : null;
}

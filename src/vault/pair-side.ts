import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {assetMeta, underlyingOf} from '@/core/assets';
import {currentCatalog} from '@/core/asset-catalog';

/**
 * Which leg of a trade is the QUOTE — the side a price is stated in, and what a buy spends.
 *
 * Every row used to answer "the stablecoin", which stopped being enough once a pair could be quoted
 * in anything: a swap of ETH for UNI has no stable leg, and read as a sell of ETH at a price per
 * UNI, or as nothing at all. The rule is now a ranking, highest first:
 *
 *   1. a stablecoin (a receipt token counts as what it stands for — aUSDC is USDC);
 *   2. the quote of the pair on screen, so a UNI/ETH screen lists its own orders as UNI bought and
 *      sold at an ETH price;
 *   3. a major the market itself prices things in — ETH, then BTC;
 *   4. anything else.
 *
 * Two stablecoins tie on rank 1, and a tie read as a sell: USDC bought with USDT on the USDC/USDT
 * screen showed as a sell. The pair on screen breaks that tie — its quote is the quote, so spending
 * USDT there is a buy of USDC. A tie the screen cannot settle still reads as a sell.
 */
const MAJORS = ['WBNB', 'BNB', 'WETH', 'ETH', 'WBTC', 'cbBTC', 'BTCB'];

/** The symbol a leg trades as: a receipt token's underlying, else its own. */
export function legSymbol(network: Network, addr: string): string {
  return underlyingOf(network, addr) ?? assetMeta(network, addr as Address).symbol;
}

function quoteRank(network: Network, addr: string, pairQuote?: string): number {
  const sym = legSymbol(network, addr);
  // Half a step for the screen's quote, so it wins a stable-against-stable tie and nothing else.
  if (currentCatalog(network).some((a) => a.kind === 'stable' && a.symbol === sym)) return MAJORS.length + 2 + (pairQuote && sym === pairQuote ? 0.5 : 0);
  if (pairQuote && sym === pairQuote) return MAJORS.length + 1;
  const i = MAJORS.indexOf(sym);
  return i >= 0 ? MAJORS.length - i : 0;
}

/** True when the leg SOLD is the quote: the trade bought the other leg. */
export function soldIsQuote(network: Network, sellToken: string, buyToken: string, pairQuote?: string): boolean {
  return quoteRank(network, sellToken, pairQuote) > quoteRank(network, buyToken, pairQuote);
}

/** The pair a trade belongs to, as {base, quote} symbols. */
export function pairOf(network: Network, sellToken: string, buyToken: string, pairQuote?: string): {base: string; quote: string} {
  const sell = legSymbol(network, sellToken);
  const buy = legSymbol(network, buyToken);
  return soldIsQuote(network, sellToken, buyToken, pairQuote) ? {base: buy, quote: sell} : {base: sell, quote: buy};
}

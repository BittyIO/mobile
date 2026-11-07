/**
 * Market trading via the AMM adapter, relayed gaslessly. Ported from web marketSell/marketBuy.
 *
 * Pricing: Uniswap V3 QuoterV2 across the standard fee tiers, picking the best pool — the SAME pool the
 * swap then routes through (the fee is baked into the path). The slippage guard (buyAmountMin /
 * sellAmountMax) makes any relay/inclusion delay safe: a swap that would fill worse than the quote
 * reverts. Signed in-app; no gas.
 */
import {encodePacked, formatUnits, parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {publicClientFor, QUOTER_V2, type Network} from '@/core/chain';
import {QUOTER_V2_ABI, VAULT_TRADE_ABI} from '@/core/abi';
import {ammAdapters} from '@/core/protocols';
import {ammSpeaksUniversal, fetchUniversalRoute} from './universal-route';
import {assetMeta} from '@/core/assets';
import {relayVaultWrite, relayVaultMulticall, type VaultCall} from './relay';
import {buildSetupCalls} from './trade-setup';

const FEE_TIERS = [500, 3000, 10000] as const;
const NO_PRICE_LIMIT = BigInt(0);

/**
 * What a swap was quoted at. `fee` is the v3 fee tier the route used, and 0 for a Universal route
 * — one route can cross several pools at different tiers, so a single number stops meaning
 * anything. Nothing renders it today; it is kept because the type is exported.
 */
export type Quote = {fee: number; out: string; min: string};

/**
 * The `path` slot, and the floor that goes with it.
 *
 * A market-trade adapter since 1.0.3 takes a Universal Router route and refuses a v3 path; the
 * combined adapter before it takes a v3 path and knows nothing of routes. The adapter is asked
 * which it is, so one code path serves a chain mid-migration — see {ammSpeaksUniversal}.
 */
async function sellRoute(
  network: Network,
  amm: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
): Promise<{path: Hex; minOut: bigint; out: bigint; fee: number}> {
  if (await ammSpeaksUniversal(amm, network)) {
    const q = await fetchUniversalRoute({network, tokenIn, tokenOut, amountIn, slippageBps});
    if (!q) throw new Error('No Uniswap pool to price this pair');
    // `minOut` is the adapter's own floor, built by the service against the amount the adapter
    // will actually swap. Deriving one here from a client-side quote would fight it.
    return {path: q.route, minOut: q.minOut, out: q.amountOut, fee: 0};
  }
  const q = await bestSellQuote(network, tokenIn, tokenOut, amountIn);
  if (!q) throw new Error('No Uniswap pool to price this pair');
  // exact-input v3 path is forward: sell → fee → buy.
  return {
    path: encodePacked(['address', 'uint24', 'address'], [tokenIn, q.fee, tokenOut]),
    minOut: q.amountOut - (q.amountOut * BigInt(slippageBps)) / BigInt(10000),
    out: q.amountOut,
    fee: q.fee,
  };
}

/** Best (fee tier, amountOut) for an exact-in swap, or null if no pool prices it. */
async function bestSellQuote(
  network: Network,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<{fee: number; amountOut: bigint} | null> {
  const client = publicClientFor(network);
  const quoter = QUOTER_V2[network];
  // Quote every fee tier in ONE round-trip (they're independent) instead of three sequential RPC calls.
  const quotes = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const sim = await client.simulateContract({
          address: quoter,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: NO_PRICE_LIMIT}],
        });
        const amountOut = (sim.result as readonly [bigint, bigint, number, bigint])[0];
        return amountOut > BigInt(0) ? {fee, amountOut} : null;
      } catch {
        return null; // no pool at this tier
      }
    }),
  );
  let best: {fee: number; amountOut: bigint} | null = null;
  for (const q of quotes) if (q && (!best || q.amountOut > best.amountOut)) best = q;
  return best;
}

/** Best (fee tier, amountIn) for an exact-out swap, or null. */
async function bestBuyQuote(
  network: Network,
  tokenIn: Address,
  tokenOut: Address,
  amountOut: bigint,
): Promise<{fee: number; amountIn: bigint} | null> {
  const client = publicClientFor(network);
  const quoter = QUOTER_V2[network];
  const quotes = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const sim = await client.simulateContract({
          address: quoter,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactOutputSingle',
          args: [{tokenIn, tokenOut, amount: amountOut, fee, sqrtPriceLimitX96: NO_PRICE_LIMIT}],
        });
        const amountIn = (sim.result as readonly [bigint, bigint, number, bigint])[0];
        return amountIn > BigInt(0) ? {fee, amountIn} : null;
      } catch {
        return null; // no pool at this tier
      }
    }),
  );
  let best: {fee: number; amountIn: bigint} | null = null;
  for (const q of quotes) if (q && (!best || q.amountIn < best.amountIn)) best = q;
  return best;
}

/**
 * Price a trade WITHOUT executing — for the live preview as the user types. Returns the estimated
 * counter-amount and the slippage guard, or null if unpriceable. Same quote path the swap uses.
 */
export async function quotePreview(o: {
  network: Network;
  mode: 'sell' | 'buy';
  sellToken: Address;
  buyToken: Address;
  amount: string;
  slippageBps: number;
}): Promise<{fee: number; est: string; guard: string} | null> {
  if (!(Number(o.amount) > 0)) return null;
  const sell = assetMeta(o.network, o.sellToken);
  const buy = assetMeta(o.network, o.buyToken);
  /*
   * On a split-adapter chain the preview must come from the SAME quoting service the swap will
   * use: the service routes across v2/v3/v4, while the local QuoterV2 fallback below sees v3
   * only — on a chain whose liquidity lives in v4 pools (UNI/USDG on Robinhood) the fallback
   * reports "no pool" for a pair the swap can fill. `est`/`guard` are what actually reaches the
   * vault (the adapter's fee already off), which is the honest number to show next to a trade.
   * Buy-mode falls through: the service builds exact-in routes only, and exact-out market orders
   * are refused on split chains anyway (see {marketBuy}).
   */
  if (o.mode === 'sell') {
    const amm = ammAdapters(o.network)[0];
    if (amm && (await ammSpeaksUniversal(amm, o.network))) {
      const amountIn = parseUnits(o.amount, sell.decimals);
      const q = await fetchUniversalRoute({
        network: o.network,
        tokenIn: o.sellToken,
        tokenOut: o.buyToken,
        amountIn,
        slippageBps: o.slippageBps,
      });
      if (!q) return null;
      return {fee: 0, est: formatUnits(q.receive, buy.decimals), guard: formatUnits(q.minReceive, buy.decimals)};
    }
  }
  if (o.mode === 'sell') {
    const amountIn = parseUnits(o.amount, sell.decimals);
    const q = await bestSellQuote(o.network, o.sellToken, o.buyToken, amountIn);
    if (!q) return null;
    const min = q.amountOut - (q.amountOut * BigInt(o.slippageBps)) / BigInt(10000);
    return {fee: q.fee, est: formatUnits(q.amountOut, buy.decimals), guard: formatUnits(min, buy.decimals)};
  }
  const amountOut = parseUnits(o.amount, buy.decimals);
  const q = await bestBuyQuote(o.network, o.sellToken, o.buyToken, amountOut);
  if (!q) return null;
  const maxIn = q.amountIn + (q.amountIn * BigInt(o.slippageBps)) / BigInt(10000);
  return {fee: q.fee, est: formatUnits(q.amountIn, sell.decimals), guard: formatUnits(maxIn, sell.decimals)};
}

/**
 * Live pool price: quote per 1 base, straight from the Uniswap V3 pool the swap routes through. Use this
 * instead of an off-chain oracle (CoinGecko) for anything trade-related — on a testnet the pool price and
 * the mainnet oracle price diverge wildly, and the swap executes at the POOL price. Null if no pool.
 */
export async function poolSpotPrice(
  network: Network,
  base: Address,
  quote: Address,
  /** The base's rough dollar price, to size the quote. See below. */
  baseUsd?: number | null,
): Promise<number | null> {
  // Asked for about $100 of the base when its price is roughly known, not for one unit. The quote
  // takes the best of every pool, and for a sliver of a token the best is whichever near-empty pool
  // sits furthest off the market: one PEPE on Arbitrum priced at 0.0000000040 WETH, 78% over, from a
  // pool too thin to fill $100 at that rate. A real amount is what the swap would meet.
  if (baseUsd != null && baseUsd > 0) {
    const amount = Number((100 / baseUsd).toPrecision(2));
    const text = amount.toLocaleString('en-US', {useGrouping: false, maximumFractionDigits: 18});
    const q = await quotePreview({network, mode: 'sell', sellToken: base, buyToken: quote, amount: text, slippageBps: 0});
    if (q && Number(q.est) > 0) return Number(q.est) / amount;
  }
  // No price to size it by: one unit, and 10,000 times that while the answer has fewer than four
  // significant digits of the quote — one PEPE is ~0.000005 USDC, which six decimals can only give
  // as 0.000005 or 0.00001, the latter read as a doubled price.
  const dec = assetMeta(network, quote).decimals;
  for (let amount = 1; amount <= 1e12; amount *= 1e4) {
    const q = await quotePreview({network, mode: 'sell', sellToken: base, buyToken: quote, amount: String(amount), slippageBps: 0});
    if (!q) return null;
    const out = Number(q.est);
    if (out * 10 ** dec >= 1e4 || amount === 1e12) return out / amount;
  }
  return null;
}

type SellOpts = {
  account: Signer;
  vault: Address;
  network: Network;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string; // human units of sellToken
  slippageBps: number; // e.g. 100 = 1%
  stableCoin: Address;
  /** Bill exactly `stableCoin`: see {relayVaultWrite}. */
  pinFee?: boolean;
};

/**
 * Build (without relaying) the allowlist setup + marketSell call for an exact-in swap. Lets a caller bundle
 * the swap with other vault calls in one multicall — e.g. a Sky withdraw ahead of a yielding market buy.
 */
export async function buildMarketSell(o: {
  network: Network;
  vault: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  slippageBps: number;
}): Promise<{setup: VaultCall[]; swap: VaultCall}> {
  const sell = assetMeta(o.network, o.sellToken);
  const amountIn = parseUnits(o.sellAmount, sell.decimals);
  const amm = ammAdapters(o.network)[0];
  if (!amm) throw new Error('No AMM adapter configured');
  const r = await sellRoute(o.network, amm, o.sellToken, o.buyToken, amountIn, o.slippageBps);
  const swap: VaultCall = {abi: VAULT_TRADE_ABI, functionName: 'marketSell', args: [amm, o.sellToken, amountIn, o.buyToken, r.minOut, r.path]};
  const setup = await buildSetupCalls({network: o.network, vault: o.vault, adapter: amm, tokens: [o.sellToken, o.buyToken]});
  return {setup, swap};
}

/** Market SELL (exact-in): sell exactly `sellAmount`, receive at least the quoted amount minus slippage. */
export async function marketSell(o: SellOpts): Promise<{hash: Hex; quote: Quote}> {
  const sell = assetMeta(o.network, o.sellToken);
  const buy = assetMeta(o.network, o.buyToken);
  const amountIn = parseUnits(o.sellAmount, sell.decimals);

  const amm = ammAdapters(o.network)[0];
  if (!amm) throw new Error('No AMM adapter configured');

  const r = await sellRoute(o.network, amm, o.sellToken, o.buyToken, amountIn, o.slippageBps);

  const swapCall: VaultCall = {abi: VAULT_TRADE_ABI, functionName: 'marketSell', args: [amm, o.sellToken, amountIn, o.buyToken, r.minOut, r.path]};
  // If the vault's restricted allowlist requires the adapter/assets listed, bundle those updates ahead of
  // the swap in ONE multicall (one signature, mined atomically) so the swap sees them registered.
  const setup = await buildSetupCalls({network: o.network, vault: o.vault, adapter: amm, tokens: [o.sellToken, o.buyToken]});
  const {hash} = setup.length
    ? await relayVaultMulticall({account: o.account, vault: o.vault, network: o.network, calls: [...setup, swapCall], stableCoin: o.stableCoin, pinFee: o.pinFee})
    : await relayVaultWrite({account: o.account, vault: o.vault, network: o.network, ...swapCall, stableCoin: o.stableCoin, pinFee: o.pinFee});

  return {
    hash,
    quote: {fee: r.fee, out: formatUnits(r.out, buy.decimals), min: formatUnits(r.minOut, buy.decimals)},
  };
}

type BuyOpts = {
  account: Signer;
  vault: Address;
  network: Network;
  sellToken: Address;
  buyToken: Address;
  buyAmount: string; // human units of buyToken to receive exactly
  slippageBps: number;
  stableCoin: Address;
};

/**
 * Market BUY (exact-out): receive exactly `buyAmount`, spend at most the quoted input plus slippage.
 *
 * ONLY on a pre-split adapter. The split trade adapter's `swapExactOut` demands a Universal route
 * exactly as `swap` does, and the quoting service builds exact-IN routes only — so there is no
 * route to send and this refuses rather than letting the relay come back as `simulation-failed`.
 *
 * Nothing calls it: the Trade screen places both sides as exact-in, which is why this gap has no
 * user-facing consequence today. Kept, and kept honest, for whatever reaches for it next.
 */
export async function marketBuy(o: BuyOpts): Promise<{hash: Hex; quote: Quote}> {
  const sell = assetMeta(o.network, o.sellToken);
  const buy = assetMeta(o.network, o.buyToken);
  const amountOut = parseUnits(o.buyAmount, buy.decimals);

  const amm = ammAdapters(o.network)[0];
  if (!amm) throw new Error('No AMM adapter configured');
  if (await ammSpeaksUniversal(amm, o.network)) {
    throw new Error('Exact-out market orders are not supported on this chain yet — sell exact-in instead');
  }

  const q = await bestBuyQuote(o.network, o.sellToken, o.buyToken, amountOut);
  if (!q) throw new Error('No Uniswap pool to price this pair');
  const sellAmountMax = q.amountIn + (q.amountIn * BigInt(o.slippageBps)) / BigInt(10000);

  // exact-output path is REVERSED: buy → fee → sell.
  const reversedPath = encodePacked(['address', 'uint24', 'address'], [o.buyToken, q.fee, o.sellToken]);

  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_TRADE_ABI,
    functionName: 'marketBuy',
    args: [amm, o.sellToken, sellAmountMax, o.buyToken, amountOut, reversedPath],
    stableCoin: o.stableCoin,
  });

  return {
    hash,
    quote: {
      fee: q.fee,
      out: formatUnits(q.amountIn, sell.decimals),
      min: formatUnits(sellAmountMax, sell.decimals),
    },
  };
}

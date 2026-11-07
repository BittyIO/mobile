import {parseAbi, zeroAddress, type Address, type Hex} from 'viem';
import {API_BASE, apiFetch, publicClientFor, type Network} from '@/core/chain';

/**
 * The Universal Router route a market-trade adapter needs, from the app's own quoting service.
 *
 * Since the 1.0.3 AMM split, the swap adapter is version-agnostic: it forwards an opaque route to
 * the one Universal Router, which reaches v2, v3, v4 and any mix of them. The route is
 * `TAG ‖ abi.encode(commands, inputs, deadline)`, and the adapter refuses anything else —
 * `NotAUniswapRoute` — so the old v3 path (token ‖ fee ‖ token) reverts every market trade on a
 * split chain.
 *
 * Built on the server and not here, deliberately, and the contract says why: router builds differ
 * per chain (a newer router carries a per-hop price field an older input list does not), so the
 * encoding is the quoting service's business. The adapter never looks inside the bytes and
 * neither does this client.
 *
 * The server also owns one thing the client cannot see: the adapter's 0.2% swap fee comes off the
 * INPUT when the sold token is a guard-registered stable coin and off the OUTPUT otherwise, and
 * the route has to be built for the amount the adapter actually swaps — or the Permit2 allowance
 * it sets comes up short and the swap reverts for a second reason.
 */

export type UniversalQuote = {
  /** The tagged route bytes, passed straight through as the swap's `path`. */
  route: Hex;
  /** The pool's gross output, and the floor the adapter enforces on it. */
  amountOut: bigint;
  minOut: bigint;
  /** What actually reaches the vault, fee deducted — for display, not for the chain. */
  receive: bigint;
  minReceive: bigint;
  /** Human-readable hops, e.g. ["v3 USDC/WETH 0.05%"]. */
  hops: string[];
};

/**
 * Does this adapter want a Universal route?
 *
 * Asked of the adapter rather than assumed from the chain or the vault's version: `universalRouter()`
 * exists only on the split trade adapter, so a non-zero answer IS the capability. Immutable per
 * address, so one read per adapter for the life of the process — and a chain still running the
 * combined v3 adapter keeps getting a v3 path with no special-casing anywhere.
 */
const UNIVERSAL_ABI = parseAbi(['function universalRouter() view returns (address)']);
const speaks = new Map<string, boolean>();

export async function ammSpeaksUniversal(adapter: Address, network: Network): Promise<boolean> {
  const key = `${network}:${adapter.toLowerCase()}`;
  const known = speaks.get(key);
  if (known !== undefined) return known;
  let universal = false;
  try {
    const router = (await publicClientFor(network).readContract({
      address: adapter,
      abi: UNIVERSAL_ABI,
      functionName: 'universalRouter',
    })) as Address;
    universal = !!router && router !== zeroAddress;
  } catch {
    // No such function: the older combined adapter, which takes a v3 path.
    universal = false;
  }
  speaks.set(key, universal);
  return universal;
}

/**
 * Quote an exact-in swap and get its route. Null when nothing can price the pair.
 *
 * Not cached: a route carries a deadline and a minimum derived from a quote, and a stale one is
 * either refused by the router or fills at a price nobody agreed to.
 */
export async function fetchUniversalRoute(o: {
  network: Network;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
}): Promise<UniversalQuote | null> {
  const url =
    `${API_BASE}/api/ethereum/trade/route?network=${o.network}` +
    `&tokenIn=${o.tokenIn}&tokenOut=${o.tokenOut}` +
    `&amountIn=${o.amountIn.toString()}&slippageBps=${o.slippageBps}`;
  try {
    const res = await apiFetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      route?: string | null;
      amountOut?: string;
      minOut?: string;
      receive?: string;
      minReceive?: string;
      hops?: string[];
    };
    if (!j?.route || !j.amountOut || !j.minOut) return null;
    return {
      route: j.route as Hex,
      amountOut: BigInt(j.amountOut),
      minOut: BigInt(j.minOut),
      receive: BigInt(j.receive ?? j.amountOut),
      minReceive: BigInt(j.minReceive ?? j.minOut),
      hops: j.hops ?? [],
    };
  } catch {
    return null;
  }
}

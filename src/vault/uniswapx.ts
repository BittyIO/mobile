/**
 * UniswapX market orders: the vault's Market route on a chain whose intent adapter is UniswapX
 * (Robinhood). Gasless once set up, like a CoW order:
 *  1. the server fetches a V3 Dutch order from Uniswap's Trading API, checked against the adapter
 *     (swapper = vault, [vault, fee] outputs, 0.2% fee) — the API key never reaches the app;
 *  2. the order is decoded here from `encodedOrder` and checked again, against the price feed too —
 *     the adapter never compares an order with a price, so this is the only check there is;
 *  3. the owner signs the order's Permit2 digest, rebuilt here from the decoded order, so what is
 *     signed is what was checked and not whatever `permitData` says;
 *  4. `abi.encode(order, signerSig)` goes back through the server to Uniswap, and a filler settles it
 *     within the auction (~80 blocks) or it expires.
 *
 * Prerequisite, as for CoW: the vault has cloned the adapter and approved its spender (Permit2) for
 * the sell token — {prepareIntent}.
 */
import {decodeAbiParameters, encodeAbiParameters, parseAbi, parseAbiParameters, parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, apiUrl, publicClientFor, type Network} from '@/core/chain';
import {orderSignerSig} from '@/core/cow';
import {adapterByName} from '@/core/protocols';
import {assetMeta} from '@/core/assets';
import {VAULT_GUARD} from '@/core/vault-contracts';

/** UniswapXV1Protocol.FEE_RECIPIENT / FEE_BPS. */
const FEE_RECIPIENT = '0xf0e7f6998b362bd15cf819c7ebfcace8865feca0';
const FEE_BPS = BigInt(20);
/** The most an order's floor may sit under the price feed's value of what is sold. */
const MAX_FEED_SHORTFALL_BPS = BigInt(300);

/** The chain's UniswapX adapter, or null where there is none. */
export const uniswapXAdapter = (network: Network): Address | null => adapterByName(network, 'UniswapX');

const DECAY = '(uint256 relativeBlocks,int256[] relativeAmounts)';
const INFO = '(address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData)';
const INPUT = `(address token,uint256 startAmount,${DECAY} curve,uint256 maxAmount,uint256 adjustmentPerGweiBaseFee)`;
const OUTPUT = `(address token,uint256 startAmount,${DECAY} curve,address recipient,uint256 minAmount,uint256 adjustmentPerGweiBaseFee)`;
const SWAPPER_FIELDS = `${INFO} info,address cosigner,uint256 startingBaseFee,${INPUT} baseInput,${OUTPUT}[] baseOutputs`;
// The reactor's whole order, as `encodedOrder` carries it: the swapper's fields, then the cosigner's.
const ENCODED_ORDER = parseAbiParameters(
  `(${SWAPPER_FIELDS},(uint256 decayStartBlock,address exclusiveFiller,uint256 exclusivityOverrideBps,uint256 inputOverride,uint256[] outputOverrides) cosignerData,bytes cosignature)`,
);
// What the adapter decodes: the swapper's fields only, and the signer's signature.
const ADAPTER_PAYLOAD = parseAbiParameters(`(${SWAPPER_FIELDS}), bytes`);

// Permit2's PermitWitnessTransferFrom with the V3 Dutch order as witness — the digest the reactor
// has Permit2 check, and the one UniswapXV1Protocol rebuilds.
const PERMIT_TYPES = {
  PermitWitnessTransferFrom: [
    {name: 'permitted', type: 'TokenPermissions'},
    {name: 'spender', type: 'address'},
    {name: 'nonce', type: 'uint256'},
    {name: 'deadline', type: 'uint256'},
    {name: 'witness', type: 'V3DutchOrder'},
  ],
  TokenPermissions: [
    {name: 'token', type: 'address'},
    {name: 'amount', type: 'uint256'},
  ],
  V3DutchOrder: [
    {name: 'info', type: 'OrderInfo'},
    {name: 'cosigner', type: 'address'},
    {name: 'startingBaseFee', type: 'uint256'},
    {name: 'baseInput', type: 'V3DutchInput'},
    {name: 'baseOutputs', type: 'V3DutchOutput[]'},
  ],
  OrderInfo: [
    {name: 'reactor', type: 'address'},
    {name: 'swapper', type: 'address'},
    {name: 'nonce', type: 'uint256'},
    {name: 'deadline', type: 'uint256'},
    {name: 'additionalValidationContract', type: 'address'},
    {name: 'additionalValidationData', type: 'bytes'},
  ],
  V3DutchInput: [
    {name: 'token', type: 'address'},
    {name: 'startAmount', type: 'uint256'},
    {name: 'curve', type: 'NonlinearDutchDecay'},
    {name: 'maxAmount', type: 'uint256'},
    {name: 'adjustmentPerGweiBaseFee', type: 'uint256'},
  ],
  V3DutchOutput: [
    {name: 'token', type: 'address'},
    {name: 'startAmount', type: 'uint256'},
    {name: 'curve', type: 'NonlinearDutchDecay'},
    {name: 'recipient', type: 'address'},
    {name: 'minAmount', type: 'uint256'},
    {name: 'adjustmentPerGweiBaseFee', type: 'uint256'},
  ],
  NonlinearDutchDecay: [
    {name: 'relativeBlocks', type: 'uint256'},
    {name: 'relativeAmounts', type: 'int256[]'},
  ],
} as const;

type QuoteResponse = {
  routing: string;
  quote: {orderId: string; encodedOrder: Hex; [k: string]: unknown};
  permitData: {domain: {name: string; chainId: number; verifyingContract: Address}};
};

export type UniswapXQuote = {
  /** What the server returned; posted back unchanged with the signature. */
  raw: QuoteResponse;
  orderId: Hex;
  /** What the vault receives at the start of the auction, and at worst. */
  out: bigint;
  minOut: bigint;
};

const lower = (a: string) => a.toLowerCase();

/** Ask the server for an exact-in UniswapX order. Null when UniswapX will not quote the trade. */
export async function quoteUniswapX(o: {
  network: Network;
  vault: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
}): Promise<UniswapXQuote | null> {
  const amountIn = parseUnits(o.sellAmount, assetMeta(o.network, o.sellToken).decimals);
  const res = await apiFetch(apiUrl('/api/ethereum/uniswapx/quote', o.network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({vault: o.vault, tokenIn: o.sellToken, tokenOut: o.buyToken, amountIn: amountIn.toString()}),
  }).catch(() => null);
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as QuoteResponse | null;
  if (!raw?.quote?.encodedOrder || raw.routing !== 'DUTCH_V3') return null;
  const order = decodeOrder(raw.quote.encodedOrder);
  const problem = orderProblem(order, o.vault, o.sellToken, o.buyToken, amountIn);
  if (problem) throw new Error(`UniswapX order refused: ${problem}`);
  return {raw, orderId: raw.quote.orderId as Hex, out: order.baseOutputs[0].startAmount, minOut: order.baseOutputs[0].minAmount};
}

type SwapperOrder = ReturnType<typeof decodeOrder>;

function decodeOrder(encoded: Hex) {
  const [o] = decodeAbiParameters(ENCODED_ORDER, encoded);
  return {info: o.info, cosigner: o.cosigner, startingBaseFee: o.startingBaseFee, baseInput: o.baseInput, baseOutputs: o.baseOutputs};
}

/** The adapter's own checks, made on the order that will be signed; null when it passes them. */
function orderProblem(order: SwapperOrder, vault: Address, sellToken: Address, buyToken: Address, amountIn: bigint): string | null {
  const {info, baseInput: input, baseOutputs: outs} = order;
  if (lower(info.swapper) !== lower(vault)) return 'swapper';
  if (info.additionalValidationContract !== '0x0000000000000000000000000000000000000000') return 'validation contract';
  if (lower(input.token) !== lower(sellToken)) return 'sell token';
  // The most Permit2 can pull: never more than the amount the user typed.
  if (input.maxAmount !== amountIn || input.startAmount !== amountIn) return 'sell amount';
  if (outs.length !== 2) return 'outputs';
  const [out, fee] = outs;
  if (lower(out.token) !== lower(buyToken) || lower(out.recipient) !== lower(vault)) return 'output';
  if (lower(fee.token) !== lower(buyToken) || lower(fee.recipient) !== FEE_RECIPIENT) return 'fee output';
  const feeOk = (amount: bigint, f: bigint) => f * (BigInt(10_000) - FEE_BPS) >= amount * FEE_BPS;
  if (!feeOk(out.startAmount, fee.startAmount) || !feeOk(out.minAmount, fee.minAmount)) return 'fee';
  if (info.deadline < BigInt(Math.floor(Date.now() / 1000))) return 'expired';
  return null;
}

const GUARD_PRICE_ABI = parseAbi([
  'function assetCategory(address) view returns (uint8)',
  'function priceFeed(address) view returns ((address feed, uint32 maxAge, uint8 decimals, uint8 assetDecimals, bool hasQuote, address quote))',
]);
const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const ASSET_STABLE_COIN = 1;

/**
 * USD value of `amount` of `token`, 18 decimals, the way the vault values a market trade: a
 * stablecoin is a dollar, anything else is priced off the guard's feed. Null without a USD feed.
 */
async function feedValue(network: Network, token: Address, amount: bigint): Promise<bigint | null> {
  const client = publicClientFor(network);
  const decimals = BigInt(assetMeta(network, token).decimals);
  const category = await client.readContract({address: VAULT_GUARD, abi: GUARD_PRICE_ABI, functionName: 'assetCategory', args: [token]});
  if ((category & ASSET_STABLE_COIN) !== 0) return (amount * BigInt(10) ** BigInt(18)) / BigInt(10) ** decimals;
  const f = await client.readContract({address: VAULT_GUARD, abi: GUARD_PRICE_ABI, functionName: 'priceFeed', args: [token]});
  if (f.feed === '0x0000000000000000000000000000000000000000' || f.hasQuote) return null;
  const [, answer, , updatedAt] = await client.readContract({address: f.feed, abi: FEED_ABI, functionName: 'latestRoundData'});
  if (answer <= BigInt(0) || BigInt(Math.floor(Date.now() / 1000)) > updatedAt + BigInt(f.maxAge)) return null;
  return (amount * BigInt(answer) * BigInt(10) ** BigInt(18)) / (BigInt(10) ** decimals * BigInt(10) ** BigInt(f.decimals));
}

/**
 * Whether the order's floor is worth at least what is sold, less {MAX_FEED_SHORTFALL_BPS}, at the
 * guard's prices. False when either leg has no price: an order nothing can check is not sent.
 */
export async function withinFeed(o: {network: Network; sellToken: Address; buyToken: Address; sellAmount: string; quote: UniswapXQuote}): Promise<boolean> {
  const amountIn = parseUnits(o.sellAmount, assetMeta(o.network, o.sellToken).decimals);
  const [sold, bought] = await Promise.all([
    feedValue(o.network, o.sellToken, amountIn).catch(() => null),
    feedValue(o.network, o.buyToken, o.quote.minOut).catch(() => null),
  ]);
  if (sold == null || bought == null || sold === BigInt(0)) return false;
  return bought * BigInt(10_000) >= sold * (BigInt(10_000) - MAX_FEED_SHORTFALL_BPS);
}

/** Sign the quoted order for the vault and hand it to Uniswap. Returns the order hash. */
export async function placeUniswapXOrder(o: {account: Signer; network: Network; quote: UniswapXQuote}): Promise<Hex> {
  const {raw} = o.quote;
  const order = decodeOrder(raw.quote.encodedOrder);
  const {domain} = raw.permitData;
  if (domain.name !== 'Permit2') throw new Error('UniswapX order refused: domain');
  const typed = {
    domain: {name: domain.name, chainId: domain.chainId, verifyingContract: domain.verifyingContract},
    types: PERMIT_TYPES,
    primaryType: 'PermitWitnessTransferFrom' as const,
    message: {
      permitted: {token: order.baseInput.token, amount: order.baseInput.maxAmount},
      spender: order.info.reactor,
      nonce: order.info.nonce,
      deadline: order.info.deadline,
      witness: order,
    },
  };
  // Signed as typed data, so a wallet shows the order; the adapter rebuilds the same digest.
  const sig = await o.account.signTypedData(typed);
  const signature = encodeAbiParameters(ADAPTER_PAYLOAD, [order, orderSignerSig(o.account, sig)]);
  const res = await apiFetch(apiUrl('/api/ethereum/uniswapx/order', o.network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({quote: raw.quote, routing: raw.routing, signature}),
  });
  const j = (await res.json().catch(() => null)) as {orderHash?: string; error?: string} | null;
  if (!res.ok) throw new Error(`UniswapX rejected: ${j?.error ?? res.status}`);
  return (j?.orderHash ?? o.quote.orderId) as Hex;
}

export type UniswapXFill = {status: 'filled'; txHash?: Hex} | {status: 'expired' | 'cancelled' | 'error' | 'insufficient-funds'};

/**
 * Wait for the auction to end: filled (with the fill transaction), or why not. Polls the server
 * until the order leaves "open", or for `timeoutMs` — a little past the order's own deadline.
 */
export async function waitForUniswapX(network: Network, orderId: Hex, timeoutMs = 7 * 60_000): Promise<UniswapXFill> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await apiFetch(apiUrl(`/api/ethereum/uniswapx/order?orderId=${orderId}`, network)).catch(() => null);
    if (!res?.ok) continue;
    const s = (await res.json().catch(() => null)) as {orderStatus?: string; txHash?: string} | null;
    if (!s?.orderStatus || s.orderStatus === 'open' || s.orderStatus === 'unverified') continue;
    if (s.orderStatus === 'filled') return {status: 'filled', txHash: s.txHash as Hex | undefined};
    return {status: (s.orderStatus as 'expired') ?? 'error'};
  }
  return {status: 'expired'};
}

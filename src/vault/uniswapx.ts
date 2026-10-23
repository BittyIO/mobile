/**
 * UniswapX limit orders: Limit on a chain whose intent adapter is UniswapX (Robinhood). Gasless once
 * set up, like a CoW limit order:
 *  1. the server fetches a V3 Dutch order for the sell from Uniswap's Trading API — the API key
 *     never reaches the app — and it is decoded here from `encodedOrder`;
 *  2. it is made a limit order: a fixed output at the user's price (no auction decay) and a deadline
 *     at the order's expiry. The API only quotes ~5-minute auctions; after its decay an order rests
 *     at its floor until the deadline, so a flat floor and a long deadline are a limit order;
 *  3. the owner signs its Permit2 digest, built here from the order as changed, so what is signed is
 *     what was checked;
 *  4. `abi.encode(order, signerSig)` goes back through the server to Uniswap, which cosigns it and
 *     shows it to fillers until it fills, expires, or the vault cancels it on its adapter clone.
 *
 * UniswapXV1Protocol checks only the order's shape and fee, never a price — so the price is the
 * user's own, as it is for a CoW limit order.
 *
 * Prerequisite, as for CoW: the vault has cloned the adapter and approved its spender (Permit2) for
 * the sell token — {prepareIntent}. Uniswap's API looks orders up only by hash, so the orders this
 * device placed are kept here ({fetchUniswapXOrders}).
 */
import {MMKV} from 'react-native-mmkv';
import {decodeAbiParameters, encodeAbiParameters, hashStruct, parseAbiParameters, parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, apiUrl, type Network} from '@/core/chain';
import {orderSignerSig} from '@/core/cow';
import {adapterByName} from '@/core/protocols';
import {assetMeta} from '@/core/assets';
import type {CowOrder} from './limit';

/** UniswapXV1Protocol.FEE_RECIPIENT / FEE_BPS. */
const FEE_RECIPIENT = '0xf0e7f6998b362bd15cf819c7ebfcace8865feca0';
const FEE_BPS = BigInt(20);
// The fee is asked a unit over the adapter's floor, as the server asks the API, so rounding never
// leaves it short.
const FEE_ASK_BPS = BigInt(21);

/** The chain's UniswapX adapter, or null where there is none. */
export const uniswapXAdapter = (network: Network): Address | null => adapterByName(network, 'UniswapX');

const DECAY = '(uint256 relativeBlocks,int256[] relativeAmounts)';
const INFO = '(address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData)';
const INPUT = `(address token,uint256 startAmount,${DECAY} curve,uint256 maxAmount,uint256 adjustmentPerGweiBaseFee)`;
const OUTPUT = `(address token,uint256 startAmount,${DECAY} curve,address recipient,uint256 minAmount,uint256 adjustmentPerGweiBaseFee)`;
const SWAPPER_FIELDS = `${INFO} info,address cosigner,uint256 startingBaseFee,${INPUT} baseInput,${OUTPUT}[] baseOutputs`;
const COSIGNER_FIELDS = '(uint256 decayStartBlock,address exclusiveFiller,uint256 exclusivityOverrideBps,uint256 inputOverride,uint256[] outputOverrides) cosignerData,bytes cosignature';
// The reactor's whole order, as `encodedOrder` carries it: the swapper's fields, then the cosigner's.
const ENCODED_ORDER = parseAbiParameters(`(${SWAPPER_FIELDS},${COSIGNER_FIELDS})`);
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
  quote: {orderId: string; encodedOrder: Hex; orderInfo: Record<string, unknown>; [k: string]: unknown};
  permitData: {domain: {name: string; chainId: number; verifyingContract: Address}};
};

const lower = (a: string) => a.toLowerCase();
const FLAT = {relativeBlocks: BigInt(0), relativeAmounts: [] as readonly bigint[]};

/** An exact-in UniswapX order from the server; null when UniswapX will not quote the sell. */
async function quote(o: {network: Network; vault: Address; sellToken: Address; buyToken: Address; amountIn: bigint}): Promise<QuoteResponse | null> {
  const res = await apiFetch(apiUrl('/api/ethereum/uniswapx/quote', o.network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({vault: o.vault, tokenIn: o.sellToken, tokenOut: o.buyToken, amountIn: o.amountIn.toString()}),
  }).catch(() => null);
  if (!res?.ok) return null;
  const raw = (await res.json().catch(() => null)) as QuoteResponse | null;
  return raw?.quote?.encodedOrder && raw.routing === 'DUTCH_V3' ? raw : null;
}

/**
 * Sign and submit a limit sell: exactly `sellAmount` for at least `buyAmount` (HUMAN units, the
 * price the user set), valid for `validSeconds`. The 0.2% fee comes out of `buyAmount`, as it does
 * for a CoW limit order. Returns the order hash.
 */
export async function placeUniswapXLimit(o: {
  account: Signer;
  vault: Address;
  network: Network;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  buyAmount: string;
  validSeconds: number;
}): Promise<Hex> {
  const amountIn = parseUnits(o.sellAmount, assetMeta(o.network, o.sellToken).decimals);
  const total = parseUnits(o.buyAmount, assetMeta(o.network, o.buyToken).decimals);
  const raw = await quote({...o, amountIn});
  if (!raw) throw new Error('UniswapX would not quote this sell. It may be too small: try a larger amount.');

  const [full] = decodeAbiParameters(ENCODED_ORDER, raw.quote.encodedOrder);
  const {info, baseInput, baseOutputs} = full;
  // The quote's own frame, which the order keeps: the reactor, swapper, nonce and cosigner.
  if (lower(info.swapper) !== lower(o.vault) || lower(baseInput.token) !== lower(o.sellToken) || baseInput.maxAmount !== amountIn) {
    throw new Error('UniswapX order refused: not this sell');
  }
  if (baseOutputs.length !== 2 || lower(baseOutputs[0].token) !== lower(o.buyToken)) throw new Error('UniswapX order refused: outputs');

  // The fee, rounded up, out of the total; the vault keeps the rest. Both fixed: no auction.
  const fee = (total * FEE_ASK_BPS + BigInt(9_999)) / BigInt(10_000);
  const out = total - fee;
  if (out <= BigInt(0) || fee * (BigInt(10_000) - FEE_BPS) < out * FEE_BPS) throw new Error('UniswapX order refused: fee');
  const deadline = BigInt(Math.floor(Date.now() / 1000) + o.validSeconds);
  const output = (token: Address, recipient: Address, amount: bigint) => ({
    token,
    startAmount: amount,
    curve: FLAT,
    recipient,
    minAmount: amount,
    adjustmentPerGweiBaseFee: BigInt(0),
  });
  const order = {
    info: {...info, deadline},
    cosigner: full.cosigner,
    startingBaseFee: full.startingBaseFee,
    baseInput: {...baseInput, startAmount: amountIn, maxAmount: amountIn, curve: FLAT, adjustmentPerGweiBaseFee: BigInt(0)},
    baseOutputs: [output(o.buyToken, o.vault, out), output(o.buyToken, FEE_RECIPIENT as Address, fee)],
  };

  const {domain} = raw.permitData;
  if (domain.name !== 'Permit2') throw new Error('UniswapX order refused: domain');
  const sig = await o.account.signTypedData({
    domain: {name: domain.name, chainId: domain.chainId, verifyingContract: domain.verifyingContract},
    types: PERMIT_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: {token: order.baseInput.token, amount: order.baseInput.maxAmount},
      spender: order.info.reactor,
      nonce: order.info.nonce,
      deadline: order.info.deadline,
      witness: order,
    },
  });
  const orderId = hashStruct({data: order, types: PERMIT_TYPES, primaryType: 'V3DutchOrder'});
  const signature = encodeAbiParameters(ADAPTER_PAYLOAD, [order, orderSignerSig(o.account, sig)]);

  // The quote as the API gave it, carrying the order as changed: the cosigner signs what it is sent.
  const encodedOrder = encodeAbiParameters(ENCODED_ORDER, [{...order, cosignerData: full.cosignerData, cosignature: full.cosignature}]);
  const sent = {
    ...raw.quote,
    orderId,
    encodedOrder,
    orderInfo: {
      ...raw.quote.orderInfo,
      deadline: Number(deadline),
      input: {token: o.sellToken, startAmount: amountIn.toString(), maxAmount: amountIn.toString(), adjustmentPerGweiBaseFee: '0', curve: {relativeBlocks: [], relativeAmounts: []}},
      outputs: order.baseOutputs.map((x) => ({
        token: x.token,
        startAmount: x.startAmount.toString(),
        minAmount: x.minAmount.toString(),
        recipient: x.recipient,
        adjustmentPerGweiBaseFee: '0',
        curve: {relativeBlocks: [], relativeAmounts: []},
      })),
    },
  };
  const res = await apiFetch(apiUrl('/api/ethereum/uniswapx/order', o.network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({quote: sent, routing: raw.routing, signature}),
  });
  const j = (await res.json().catch(() => null)) as {orderHash?: string; error?: string} | null;
  if (!res.ok) throw new Error(`UniswapX rejected: ${j?.error ?? res.status}`);

  remember(o.network, o.vault, {
    uid: orderId,
    kind: 'sell',
    sellToken: o.sellToken,
    buyToken: o.buyToken,
    sellAmount: amountIn.toString(),
    // The order's own buy amount, net of the fee, as a CoW order's is.
    buyAmount: out.toString(),
    validTo: Number(deadline),
    status: 'open',
    creationDate: new Date().toISOString(),
  });
  return orderId;
}

// The orders this device placed, per vault: the Trading API finds an order only by its hash.
const store = new MMKV({id: 'bitty.uniswapx-orders'});
const key = (network: Network, vault: Address) => `${network}:${lower(vault)}`;
const MAX_KEPT = 100;

function stored(network: Network, vault: Address): CowOrder[] {
  try {
    return JSON.parse(store.getString(key(network, vault)) ?? '[]') as CowOrder[];
  } catch {
    return [];
  }
}

function remember(network: Network, vault: Address, order: CowOrder): void {
  store.set(key(network, vault), JSON.stringify([order, ...stored(network, vault)].slice(0, MAX_KEPT)));
}

// The Trading API's statuses in CoW's words, so the order rows read them as they read CoW's.
const STATUS: Record<string, string> = {
  open: 'open',
  filled: 'fulfilled',
  expired: 'expired',
  cancelled: 'cancelled',
  error: 'expired',
  'insufficient-funds': 'open',
};

/**
 * This vault's UniswapX orders, newest first, with their live status — the same shape as CoW's, so
 * they share its list. A filled order's amounts are its own fixed ones: a limit order fills whole.
 */
export async function fetchUniswapXOrders(vault: Address, network: Network): Promise<CowOrder[]> {
  const mine = stored(network, vault);
  if (mine.length === 0) return [];
  const now = Math.floor(Date.now() / 1000);
  const ask = mine.filter((o) => o.status === 'open').slice(0, 50);
  const live = new Map<string, string>();
  if (ask.length) {
    const res = await apiFetch(apiUrl(`/api/ethereum/uniswapx/order?orderIds=${ask.map((o) => o.uid).join(',')}`, network)).catch(() => null);
    const j = res?.ok ? ((await res.json().catch(() => null)) as {orders?: {orderId: string; orderStatus: string}[]} | null) : null;
    for (const s of j?.orders ?? []) live.set(lower(s.orderId), STATUS[s.orderStatus] ?? 'open');
  }
  const next = mine.map((o) => {
    const status = live.get(lower(o.uid)) ?? (o.status === 'open' && o.validTo < now ? 'expired' : o.status);
    return status === o.status ? o : {...o, status, ...(status === 'fulfilled' ? {executedSellAmount: o.sellAmount, executedBuyAmount: o.buyAmount} : {})};
  });
  // Settled answers are kept, so a finished order is never asked about again.
  store.set(key(network, vault), JSON.stringify(next));
  return next;
}

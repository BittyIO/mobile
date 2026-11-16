/**
 * Trading from the Tron wallet: TRX ⇄ USDT through SunSwap's V2 router, on Tron mainnet and Nile.
 *
 * The router is SunSwap's own (its `WETH()` is WTRX, its `factory()` SunSwap V2's), so a swap is the
 * wallet calling it directly: TRX goes in as the call's value and comes out unwrapped, so the wallet
 * never holds WTRX. USDT needs an allowance for the router first, set once to the maximum.
 *
 * Bitty's fee, 0.2% as on every market trade (Terms section 7), is taken in TRX, after the swap has
 * landed: a TRX transfer costs next to nothing, where a USDT one burns several TRX of energy, and
 * charging only once the swap succeeded means a failed swap costs no fee. Selling TRX, it is 0.2%
 * of the TRX sold, held back from what is swapped; selling USDT, 0.2% of the TRX it brought.
 */
import {encodeAbiParameters, encodeFunctionData, maxUint256, parseAbi, type Address} from 'viem';
import {constantCall, chainParams, hexText} from './client';
import {fromHex, tronToEvm} from './address';
import {withTronKey} from './sign';
import {SUN_PER_TRX, type TronNet} from './config';

/**
 * SunSwap V2's router, its WTRX (the router's `WETH()`) and the USDT traded, per Tron chain. Nile's
 * router answered WETH() with Nile's WTRX and priced TRX ⇄ the Nile USDT the wallet lists (Nov 2026).
 */
const SUNSWAP: Record<TronNet, {router: string; wtrx: string; usdt: string}> = {
  tron: {router: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax', wtrx: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'},
  'tron-nile': {router: 'TMn1qrmYUMSTXo9babrJLzepKZoPC7M6Sy', wtrx: 'TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a', usdt: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'},
};
/** Tron mainnet's USDT (the bridge's). */
export const USDT = SUNSWAP.tron.usdt;

/**
 * Where Bitty's 0.2% goes: Bitty's fee contract on Tron mainnet (deployed by TFFAMQLZybALaLb4uxHA9RBE7pxhUAjF3U).
 * A plain TRX transfer credits it without running its code. The EVM fee vault cannot stand in: its
 * address holds nothing on Tron. Null turns swapping off.
 */
export const TRON_FEE_RECIPIENT: string | null = 'TSkfN6ZKBGMpGpscwGmXwPXyoJMkwq5nyJ';
export const TRON_SWAP_FEE_BPS = 20n;

/** The most the price may move against the quote before the swap refuses: 0.5%. */
const SLIPPAGE_BPS = 50n;

export type SwapSide = 'TRX' | 'USDT';

export type SwapQuote = {
  net: TronNet;
  sell: SwapSide;
  /** What leaves the wallet, in the sold asset's base units (sun, or USDT's 6 decimals). */
  amountIn: bigint;
  /** What the router is given: all of it selling USDT; less Bitty's fee selling TRX. */
  swapIn: bigint;
  /** What the router quotes back, in the bought asset's units. */
  out: bigint;
  /** What the wallet ends with: `out`, less Bitty's fee when the fee comes out of it (selling USDT). */
  receive: bigint;
  /** The least the swap may return before it refuses. */
  minOut: bigint;
  /** Bitty's fee, in sun. */
  feeSun: bigint;
};

const ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const TRC20_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

const evm = (a: string): Address => {
  const h = tronToEvm(a);
  if (!h) throw new Error(`Not a Tron address: ${a}`);
  return h;
};
const pathOf = (net: TronNet, sell: SwapSide): Address[] => {
  const {wtrx, usdt} = SUNSWAP[net];
  return sell === 'TRX' ? [evm(wtrx), evm(usdt)] : [evm(usdt), evm(wtrx)];
};
const words = (hex: string) => Array.from({length: Math.floor(hex.length / 64)}, (_, i) => BigInt('0x' + hex.slice(i * 64, i * 64 + 64)));

export const swapAvailable = (net: TronNet) => !!SUNSWAP[net] && !!TRON_FEE_RECIPIENT;

/** The router's price for `amountIn` of `sell`: what comes out the other end, before slippage. */
async function amountOut(net: TronNet, owner: string, sell: SwapSide, amountIn: bigint): Promise<bigint> {
  const parameter = encodeAbiParameters([{type: 'uint256'}, {type: 'address[]'}], [amountIn, pathOf(net, sell)]).slice(2);
  const r = await constantCall(net, owner, SUNSWAP[net].router, 'getAmountsOut(uint256,address[])', parameter);
  const res = r.constant_result?.[0];
  if (!res || r.result?.result === false) throw new Error('SunSwap could not price this trade');
  const w = words(res);
  return w[w.length - 1];
}

export async function quoteSwap(net: TronNet, owner: string, sell: SwapSide, amountIn: bigint): Promise<SwapQuote> {
  const fee = (x: bigint) => (TRON_FEE_RECIPIENT ? (x * TRON_SWAP_FEE_BPS) / 10_000n : 0n);
  if (sell === 'TRX') {
    const feeSun = fee(amountIn);
    const swapIn = amountIn - feeSun;
    const out = await amountOut(net, owner, sell, swapIn);
    return {net, sell, amountIn, swapIn, out, receive: out, minOut: (out * (10_000n - SLIPPAGE_BPS)) / 10_000n, feeSun};
  }
  const out = await amountOut(net, owner, sell, amountIn);
  const feeSun = fee(out);
  return {net, sell, amountIn, swapIn: amountIn, out, receive: out - feeSun, minOut: (out * (10_000n - SLIPPAGE_BPS)) / 10_000n, feeSun};
}

/** USDT the router may already move for the wallet. */
async function allowance(net: TronNet, owner: string): Promise<bigint> {
  const parameter = encodeAbiParameters([{type: 'address'}, {type: 'address'}], [evm(owner), evm(SUNSWAP[net].router)]).slice(2);
  const r = await constantCall(net, owner, SUNSWAP[net].usdt, 'allowance(address,address)', parameter);
  return r.constant_result?.[0] ? BigInt('0x' + r.constant_result[0]) : 0n;
}

const swapData = (q: SwapQuote, owner: string) => {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  return q.sell === 'TRX'
    ? encodeFunctionData({abi: ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [q.minOut, pathOf(q.net, 'TRX'), evm(owner), deadline]})
    : encodeFunctionData({abi: ROUTER_ABI, functionName: 'swapExactTokensForETH', args: [q.amountIn, q.minOut, pathOf(q.net, 'USDT'), evm(owner), deadline]});
};

/** Energy a SunSwap V2 swap and a USDT approval take, for when the node cannot simulate one yet. */
const SWAP_ENERGY = 230_000;
const APPROVE_ENERGY = 30_000;

export type SwapCost = {
  /** TRX the swap (and an approval, if one is needed first) is expected to burn, in sun. */
  burnSun: bigint;
  /** The cap each contract call may burn (fee_limit). */
  feeLimitSun: bigint;
  needsApproval: boolean;
};

/** What the swap will burn in TRX, from the node's simulation where it can run one. */
export async function estimateSwap(net: TronNet, owner: string, q: SwapQuote): Promise<SwapCost> {
  const [params, allowed] = await Promise.all([chainParams(net), q.sell === 'USDT' ? allowance(net, owner) : Promise.resolve(maxUint256)]);
  const needsApproval = allowed < q.amountIn;
  let energy = SWAP_ENERGY;
  // Selling USDT without an allowance the router would refuse, so the simulation has nothing to say.
  if (!needsApproval) {
    const r = await simulateSwap(net, owner, q);
    if (r.ok === false) throw new Error(r.message || 'SunSwap refused this trade');
    if (r.energy) energy = r.energy;
  }
  const sunPerEnergy = BigInt(params.getEnergyFee ?? 100);
  const total = BigInt(energy + (needsApproval ? APPROVE_ENERGY : 0)) * sunPerEnergy;
  // Room for the energy price moving; never under 50 TRX (a call that runs out of fee limit fails and still burns what it used).
  const twice = BigInt(energy) * sunPerEnergy * 2n;
  const feeLimitSun = twice > 50n * SUN_PER_TRX ? twice : 50n * SUN_PER_TRX;
  return {burnSun: total, feeLimitSun, needsApproval};
}

/** The node's run of the swap as it would be sent: whether it goes through, and the energy it takes. */
async function simulateSwap(net: TronNet, owner: string, q: SwapQuote): Promise<{ok: boolean; energy?: number; message?: string}> {
  const selector = q.sell === 'TRX' ? 'swapExactETHForTokens(uint256,address[],address,uint256)' : 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)';
  const r = await constantCall(net, owner, SUNSWAP[net].router, selector, swapData(q, owner).slice(10), q.sell === 'TRX' ? q.swapIn : undefined);
  if (r.result?.result === false) return {ok: false, message: r.result.message ? hexText(r.result.message) : undefined};
  return {ok: true, energy: r.energy_used};
}

/**
 * Swap, behind one Face ID: the approval first when the router needs one, then the swap, then
 * Bitty's fee once the swap has landed. Resolves with the swap's transaction id.
 */
export async function swapTron(o: {net: TronNet; from: string; quote: SwapQuote; cost: SwapCost; onSwapSent?: (txID: string) => void}): Promise<string> {
  const {net, from, quote: q, cost} = o;
  if (!swapAvailable(net)) throw new Error('Trading is not available on this network yet.');
  return withTronKey(net, from, async (signer) => {
    if (cost.needsApproval) {
      const data = encodeFunctionData({abi: TRC20_ABI, functionName: 'approve', args: [evm(SUNSWAP[net].router), maxUint256]});
      const id = await signer.send({kind: 'call', from, contract: SUNSWAP[net].usdt, data: fromHex(data)}, 30n * SUN_PER_TRX);
      if (!(await signer.settle(id))) throw new Error('Allowing SunSwap to trade your USDT failed on chain.');
    }
    const data = swapData(q, from);
    const swapID = await signer.send({kind: 'call', from, contract: SUNSWAP[net].router, data: fromHex(data), callValueSun: q.sell === 'TRX' ? q.swapIn : undefined}, cost.feeLimitSun);
    o.onSwapSent?.(swapID);
    if (!(await signer.settle(swapID))) throw new Error('The swap failed on chain. No Bitty fee was charged.');
    if (q.feeSun > 0n && TRON_FEE_RECIPIENT) await signer.send({kind: 'trx', from, to: TRON_FEE_RECIPIENT, amountSun: q.feeSun});
    return swapID;
  });
}

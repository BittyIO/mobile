/**
 * Bridging out of the Tron wallet: USDT on Tron mainnet to the owner's vault on an EVM network,
 * through Across (across.to). One way only: the vaults bridge among EVM networks, never to Tron.
 *
 * The wallet calls Across's Tron SpokePool itself: `deposit`, with every address as a 32-byte word
 * (Across's universal form, which takes Tron and EVM addresses alike). Across's relayers pay the
 * vault on the other side within seconds and are repaid from the deposit. The USDT is allowed to
 * the SpokePool first, once, as SunSwap's is.
 *
 * Bitty's fee, 0.2% as on every bridge (Terms section 7), is taken in TRX after the deposit has
 * landed, at SunSwap's price for 0.2% of the USDT sent: a TRX transfer costs next to nothing, where
 * a second USDT one burns several TRX of energy.
 */
import {encodeAbiParameters, encodeFunctionData, maxUint256, pad, parseAbi, type Address} from 'viem';
import {CHAIN_ID, type Network} from '@/core/chain';
import {ASSETS} from '@/core/assets';
import {chainParams, constantCall, hexText} from './client';
import {evmToTron, fromHex, tronToEvm} from './address';
import {withTronKey} from './sign';
import {TRON_FEE_RECIPIENT, USDT} from './swap';
import {SUN_PER_TRX, type TronNet} from './config';


const ACROSS_API = 'https://app.across.to/api';
/** Across's chain id for Tron mainnet. */
const TRON_CHAIN_ID = 728126428;
/** Across's SpokePool on Tron mainnet. A quote naming any other is refused. */
export const TRON_SPOKE_POOL = evmToTron('0xc148aF9B50Bc03Cc0c616Cd85C66Aae9bD90cD80');
const SUNSWAP_ROUTER = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax';
const WTRX = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR';

export const TRON_BRIDGE_FEE_BPS = 20n;

/** Where USDT from Tron can go: the EVM mainnets Bitty runs on that Across serves from Tron. */
export const TRON_BRIDGE_DESTINATIONS: Network[] = ['mainnet', 'base', 'arbitrum', 'bsc'];

/** The USDT Bitty lists on `to`, which is the one Across delivers there. */
export function usdtOn(to: Network): {address: Address; decimals: number} | null {
  const a = ASSETS[to]?.find((x) => x.symbol === 'USDT');
  return a ? {address: a.address as Address, decimals: a.decimals} : null;
}

const SPOKE_ABI = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable',
]);
const TRC20_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

const evm = (a: string): Address => {
  const h = tronToEvm(a);
  if (!h) throw new Error(`Not a Tron address: ${a}`);
  return h;
};
const word = (a: Address) => pad(a, {size: 32});

export type TronBridgeQuote = {
  to: Network;
  /** The owner's vault on `to`: where Across pays out. */
  recipient: Address;
  /** USDT sent, 6 decimals. */
  amount: bigint;
  /** USDT that arrives, in the destination USDT's decimals (18 on BNB Chain). */
  outputAmount: bigint;
  outputDecimals: number;
  /** Bitty's fee, in sun: 0.2% of `amount` at SunSwap's price. */
  feeSun: bigint;
  fillSeconds: number;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusiveRelayer: Address;
  exclusivityParameter: number;
};

export class TronBridgeError extends Error {
  constructor(
    public key: 'too_low' | 'too_high' | 'quote_failed',
    public params: {min?: string; max?: string} = {},
  ) {
    super(key);
  }
}

/** Across's quote for `amount` USDT to the vault at `recipient` on `to`, and Bitty's fee in TRX. */
export async function quoteTronBridge(net: TronNet, owner: string, to: Network, amount: bigint, recipient: Address): Promise<TronBridgeQuote> {
  const out = usdtOn(to);
  if (net !== 'tron' || !out) throw new TronBridgeError('quote_failed');
  const q = new URLSearchParams({
    inputToken: USDT,
    outputToken: out.address,
    originChainId: String(TRON_CHAIN_ID),
    destinationChainId: String(CHAIN_ID[to]),
    amount: amount.toString(),
    recipient,
    // USDT on BNB Chain has 18 decimals: Across refuses the pair without this (amounts are scaled below).
    allowUnmatchedDecimals: 'true',
  });
  type Res = {
    outputAmount?: string;
    timestamp?: string;
    fillDeadline?: string;
    exclusiveRelayer?: string;
    exclusivityDeadline?: number;
    estimatedFillTimeSec?: number;
    isAmountTooLow?: boolean;
    spokePoolAddress?: string;
    limits?: {minDeposit?: string; maxDeposit?: string};
    code?: string;
  };
  let j: Res;
  try {
    j = (await (await fetch(`${ACROSS_API}/suggested-fees?${q.toString()}`)).json()) as Res;
  } catch {
    throw new TronBridgeError('quote_failed');
  }
  if (j.code === 'AMOUNT_TOO_LOW' || j.isAmountTooLow) throw new TronBridgeError('too_low', {min: j.limits?.minDeposit ?? '0'});
  if (j.code === 'AMOUNT_TOO_HIGH') throw new TronBridgeError('too_high', {max: j.limits?.maxDeposit ?? '0'});
  if (j.limits?.maxDeposit && amount > BigInt(j.limits.maxDeposit)) throw new TronBridgeError('too_high', {max: j.limits.maxDeposit});
  if (j.code || !j.outputAmount || !j.timestamp || !j.fillDeadline) throw new TronBridgeError('quote_failed');
  // The deposit goes to the SpokePool this build knows, whatever the quote says.
  if (j.spokePoolAddress && j.spokePoolAddress.toLowerCase() !== evm(TRON_SPOKE_POOL).toLowerCase()) throw new TronBridgeError('quote_failed');
  const outputAmount = BigInt(j.outputAmount);
  // What arrives, against what was sent, in the same units: never less than 97% (Across's cost cap
  // the vaults' bridge uses too). Guards a quote gone wrong.
  const scale = 10n ** BigInt(Math.max(0, out.decimals - 6));
  if (outputAmount === 0n || outputAmount * 100n < amount * scale * 97n) throw new TronBridgeError('quote_failed');
  return {
    to,
    recipient,
    amount,
    outputAmount,
    outputDecimals: out.decimals,
    feeSun: await feeInTrx(net, owner, (amount * TRON_BRIDGE_FEE_BPS) / 10_000n),
    fillSeconds: j.estimatedFillTimeSec ?? 0,
    quoteTimestamp: Number(j.timestamp),
    fillDeadline: Number(j.fillDeadline),
    exclusiveRelayer: (j.exclusiveRelayer ?? '0x0000000000000000000000000000000000000000') as Address,
    exclusivityParameter: Number(j.exclusivityDeadline ?? 0),
  };
}

/** `usdt` (6 decimals) in sun, at SunSwap's price. 0 when there is no fee address, or nothing to charge. */
async function feeInTrx(net: TronNet, owner: string, usdt: bigint): Promise<bigint> {
  if (!TRON_FEE_RECIPIENT || usdt === 0n) return 0n;
  const parameter = encodeAbiParameters([{type: 'uint256'}, {type: 'address[]'}], [usdt, [evm(USDT), evm(WTRX)]]).slice(2);
  const r = await constantCall(net, owner, SUNSWAP_ROUTER, 'getAmountsOut(uint256,address[])', parameter);
  const res = r.constant_result?.[0];
  if (!res) throw new TronBridgeError('quote_failed');
  return BigInt('0x' + res.slice(-64));
}

const depositData = (q: TronBridgeQuote, owner: string) =>
  encodeFunctionData({
    abi: SPOKE_ABI,
    functionName: 'deposit',
    args: [
      word(evm(owner)),
      word(q.recipient),
      word(evm(USDT)),
      word(usdtOn(q.to)!.address),
      q.amount,
      q.outputAmount,
      BigInt(CHAIN_ID[q.to]),
      word(q.exclusiveRelayer),
      q.quoteTimestamp,
      q.fillDeadline,
      q.exclusivityParameter,
      '0x',
    ],
  });

async function allowance(net: TronNet, owner: string): Promise<bigint> {
  const parameter = encodeAbiParameters([{type: 'address'}, {type: 'address'}], [evm(owner), evm(TRON_SPOKE_POOL)]).slice(2);
  const r = await constantCall(net, owner, USDT, 'allowance(address,address)', parameter);
  return r.constant_result?.[0] ? BigInt('0x' + r.constant_result[0]) : 0n;
}

/** Energy a SpokePool deposit and a USDT approval take, for when the node cannot simulate one. */
const DEPOSIT_ENERGY = 150_000;
const APPROVE_ENERGY = 30_000;

export type TronBridgeCost = {burnSun: bigint; feeLimitSun: bigint; needsApproval: boolean};

export async function estimateTronBridge(net: TronNet, owner: string, q: TronBridgeQuote): Promise<TronBridgeCost> {
  const [params, allowed] = await Promise.all([chainParams(net), allowance(net, owner)]);
  const needsApproval = allowed < q.amount;
  let energy = DEPOSIT_ENERGY;
  if (!needsApproval) {
    const data = depositData(q, owner);
    const r = await constantCall(
      net,
      owner,
      TRON_SPOKE_POOL,
      'deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)',
      data.slice(10),
    );
    if (r.result?.result === false) throw new Error(r.result.message ? hexText(r.result.message) : 'Across refused this deposit');
    if (r.energy_used) energy = r.energy_used;
  }
  const sunPerEnergy = BigInt(params.getEnergyFee ?? 100);
  const burnSun = BigInt(energy + (needsApproval ? APPROVE_ENERGY : 0)) * sunPerEnergy;
  const twice = BigInt(energy) * sunPerEnergy * 2n;
  return {burnSun, feeLimitSun: twice > 50n * SUN_PER_TRX ? twice : 50n * SUN_PER_TRX, needsApproval};
}

/**
 * Bridge, behind one Face ID: the approval first when the SpokePool needs one, then the deposit,
 * then Bitty's fee once the deposit has landed. Resolves with the deposit's transaction id.
 */
export async function bridgeFromTron(o: {net: TronNet; from: string; quote: TronBridgeQuote; cost: TronBridgeCost; onSent?: (txID: string) => void}): Promise<string> {
  const {net, from, quote: q, cost} = o;
  return withTronKey(net, from, async (signer) => {
    if (cost.needsApproval) {
      const data = encodeFunctionData({abi: TRC20_ABI, functionName: 'approve', args: [evm(TRON_SPOKE_POOL), maxUint256]});
      const id = await signer.send({kind: 'call', from, contract: USDT, data: fromHex(data)}, 30n * SUN_PER_TRX);
      if (!(await signer.settle(id))) throw new Error('Allowing Across to move your USDT failed on chain.');
    }
    const id = await signer.send({kind: 'call', from, contract: TRON_SPOKE_POOL, data: fromHex(depositData(q, from))}, cost.feeLimitSun);
    o.onSent?.(id);
    if (!(await signer.settle(id))) throw new Error('The bridge deposit failed on chain. No Bitty fee was charged.');
    if (q.feeSun > 0n && TRON_FEE_RECIPIENT) await signer.send({kind: 'trx', from, to: TRON_FEE_RECIPIENT, amountSun: q.feeSun});
    return id;
  });
}

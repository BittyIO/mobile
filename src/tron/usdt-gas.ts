/**
 * Rented energy for a Tron wallet's token transfer, through Bitty's server (web api/tron/usdt-gas),
 * the fee paid in TRX or — for a USDT transfer — in USDT.
 *
 * The wallet signs two transactions — the server's fee to its relayer (a TRX transfer, or a USDT
 * transfer for a wallet with no TRX at all), then its own transfer — and hands both over
 * unbroadcast. Paying in TRX is the cheaper: the fee itself then needs no energy. The server rents the energy
 * for both to the wallet (CatFee, then TronSave; it covers the burn itself when neither fills),
 * activates the address and tops up its bandwidth when needed, sends the fee, and sends the
 * transfer once the fee has succeeded. Nothing is broadcast from here.
 *
 * The rental services' keys live on the server, which is why this goes through it rather than to a
 * rental service directly.
 */
import type {Address, Hex} from 'viem';
import {apiFetch, apiUrl} from '@/core/chain';
import type {Signer} from '@/wallet/signer';
import {evmToTron} from './address';
import {refBlock} from './client';
import type {TronChain} from './config';
import {encodeRaw, encodeSigned, txIdOf} from './tx';

/** USDT per Tron network: the one token this pays gas in. */
export const USDT_GAS_TOKEN: Record<TronChain, Address> = {
  tron: '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C',
  'tron-nile': '0xECa9bC828A3005B9a3b909f2cc5c2a54794DE05F',
};

/**
 * How long the two signed transactions stay valid: the server needs time to top up, rent and wait
 * for the fee's receipt, and refuses a pair with less than its `minValiditySeconds` left.
 */
const VALID_MS = 10 * 60_000;

/** Rented energy is offered for any token transfer on Tron (not TRX itself, which needs none). */
export const rentalOffered = (net: string, token: Address | 'native'): net is TronChain => token !== 'native' && net in USDT_GAS_TOKEN;

/** Whether `token` is the network's USDT, the one coin the fee can also be paid in. */
export const isUsdtGasToken = (net: TronChain, token: Address): boolean => USDT_GAS_TOKEN[net].toLowerCase() === token.toLowerCase();

export type FeeCoin = 'TRX' | 'USDT';

export type UsdtGasQuote = {
  relayer: Address;
  /** Paid in TRX: the fee in sun, and what the wallet must hold for it (the fee and bandwidth). */
  trx: {fee: bigint; needSun: bigint; feeLimitSun: {transfer: bigint}};
  /** Paid in USDT (a USDT transfer only): the fee in USDT units (6 decimals). */
  usdt: {fee: bigint; feeLimitSun: {fee: bigint; transfer: bigint}} | null;
};

/** What sending `amount` of `token` from `from` to `to` costs on rented energy. Throws when the server refuses. */
export async function quoteUsdtGas(net: TronChain, from: Address, to: Address, amount: bigint, token: Address): Promise<UsdtGasQuote> {
  const res = await apiFetch(
    apiUrl('/api/tron/usdt-gas/quote', net),
    {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({from, to, amount: amount.toString(), token})},
    20_000,
  );
  type FeeLimit = {feeLimitSun: string};
  const r = (await res.json().catch(() => null)) as {
    ok?: boolean;
    reason?: string;
    relayer?: Address;
    fee?: string;
    feeTx?: FeeLimit;
    transferTx?: FeeLimit;
    trx?: {fee: string; needSun: string; transferTx: FeeLimit};
  } | null;
  if (!r?.ok || !r.relayer || !r.trx) throw new Error(r?.reason ?? `HTTP ${res.status}`);
  return {
    relayer: r.relayer,
    trx: {fee: BigInt(r.trx.fee), needSun: BigInt(r.trx.needSun), feeLimitSun: {transfer: BigInt(r.trx.transferTx.feeLimitSun)}},
    usdt:
      r.fee && r.feeTx && r.transferTx
        ? {fee: BigInt(r.fee), feeLimitSun: {fee: BigInt(r.feeTx.feeLimitSun), transfer: BigInt(r.transferTx.feeLimitSun)}}
        : null,
  };
}

/**
 * Send it: sign the fee (in `feeIn`) and the transfer, and hand both to the server. Resolves with
 * the transfer's hash.
 */
export async function sendWithUsdtGas(o: {
  net: TronChain;
  account: Signer;
  from: Address;
  to: Address;
  token: Address;
  amount: bigint;
  quote: UsdtGasQuote;
  feeIn: FeeCoin;
}): Promise<{hash: Hex}> {
  if (!o.account.sign) throw new Error('This key cannot sign a Tron transaction');
  const usdt = o.feeIn === 'USDT' ? o.quote.usdt : null;
  if (o.feeIn === 'USDT' && !usdt) throw new Error('This transfer cannot pay its fee in USDT');
  const ref = await refBlock(o.net);
  const me = evmToTron(o.from);
  const sign = async (raw: Uint8Array) => {
    const signature = await o.account.sign!({hash: `0x${txIdOf(raw)}`});
    return encodeSigned(raw, signature.replace(/^0x/, ''));
  };
  // Distinct timestamps, so two transactions alike in every other way cannot collide.
  const now = Date.now();
  const opts = (feeLimitSun: bigint, at: number) => ({feeLimitSun, now: at, expiresInMs: VALID_MS});
  const feeTx = usdt
    ? await sign(encodeRaw({kind: 'trc20', from: me, token: evmToTron(USDT_GAS_TOKEN[o.net]), to: evmToTron(o.quote.relayer), amount: usdt.fee}, ref, opts(usdt.feeLimitSun.fee, now)))
    : await sign(encodeRaw({kind: 'trx', from: me, to: evmToTron(o.quote.relayer), amountSun: o.quote.trx.fee}, ref, {now, expiresInMs: VALID_MS}));
  const transferLimit = usdt ? usdt.feeLimitSun.transfer : o.quote.trx.feeLimitSun.transfer;
  const transferTx = await sign(encodeRaw({kind: 'trc20', from: me, token: evmToTron(o.token), to: evmToTron(o.to), amount: o.amount}, ref, opts(transferLimit, now + 1)));
  // A write: no abort (see apiFetch). The server may take most of a minute (rental, fee receipt).
  const res = await fetch(apiUrl('/api/tron/usdt-gas/send', o.net), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({feeTx, transferTx}),
  });
  const r = (await res.json().catch(() => null)) as {ok?: boolean; hash?: Hex; reason?: string} | null;
  if (!r?.ok || !r.hash) throw new Error(usdtGasError(r?.reason ?? `HTTP ${res.status}`));
  return {hash: r.hash};
}

/** A refusal as something a person can act on. */
function usdtGasError(reason: string): string {
  switch (reason) {
    case 'insufficient-usdt':
      return 'Not enough USDT for the transfer and its fee.';
    case 'insufficient-trx':
      return 'Not enough TRX for the fee.';
    case 'insufficient-token':
      return 'Not enough of this token for the transfer.';
    case 'unsupported-token':
      return 'This token cannot be sent on rented energy. Pay the fee in TRX.';
    case 'fee-too-low':
    case 'fee-too-high':
      return 'The network fee changed. Try again.';
    case 'fee-failed':
      return 'The fee could not be paid, so nothing was sent.';
    case 'relayer-unfunded':
    case 'relayer-not-configured':
    case 'top-up-failed':
      return 'Rented energy is not available right now. Try again later, or turn it off to pay the network fee yourself.';
    default:
      return `The transfer could not be sent (${reason}).`;
  }
}

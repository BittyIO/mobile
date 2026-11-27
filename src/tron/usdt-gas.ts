/**
 * USDT as gas for a Tron wallet's USDT transfer, through Bitty's server (web api/tron/usdt-gas).
 *
 * The wallet holds no TRX and needs none: it signs two USDT transfers — the server's fee to its
 * relayer, then the transfer itself — and hands both over unbroadcast. The server rents the energy
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

export const usdtGasOffered = (net: string, token: Address | 'native'): net is TronChain =>
  token !== 'native' && (USDT_GAS_TOKEN as Record<string, Address | undefined>)[net]?.toLowerCase() === token.toLowerCase();

export type UsdtGasQuote = {
  /** The fee, in USDT units (6 decimals): the first transfer, to `relayer`. */
  fee: bigint;
  relayer: Address;
  feeLimitSun: {fee: bigint; transfer: bigint};
};

/** What sending `amount` USDT from `from` to `to` costs with USDT as gas. Throws when the server refuses. */
export async function quoteUsdtGas(net: TronChain, from: Address, to: Address, amount: bigint): Promise<UsdtGasQuote> {
  const res = await apiFetch(
    apiUrl('/api/tron/usdt-gas/quote', net),
    {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({from, to, amount: amount.toString()})},
    20_000,
  );
  const r = (await res.json().catch(() => null)) as {
    ok?: boolean;
    reason?: string;
    fee?: string;
    relayer?: Address;
    feeTx?: {feeLimitSun: string};
    transferTx?: {feeLimitSun: string};
  } | null;
  if (!r?.ok || !r.fee || !r.relayer || !r.feeTx || !r.transferTx) throw new Error(r?.reason ?? `HTTP ${res.status}`);
  return {fee: BigInt(r.fee), relayer: r.relayer, feeLimitSun: {fee: BigInt(r.feeTx.feeLimitSun), transfer: BigInt(r.transferTx.feeLimitSun)}};
}

/** Send it: sign the fee and the transfer, and hand both to the server. Resolves with the transfer's hash. */
export async function sendWithUsdtGas(o: {net: TronChain; account: Signer; from: Address; to: Address; amount: bigint; quote: UsdtGasQuote}): Promise<{hash: Hex}> {
  if (!o.account.sign) throw new Error('This key cannot sign a Tron transaction');
  const ref = await refBlock(o.net);
  const token = evmToTron(USDT_GAS_TOKEN[o.net]);
  const me = evmToTron(o.from);
  const signed = async (to: Address, amount: bigint, feeLimitSun: bigint, now: number) => {
    const raw = encodeRaw({kind: 'trc20', from: me, token, to: evmToTron(to), amount}, ref, {feeLimitSun, now, expiresInMs: VALID_MS});
    const signature = await o.account.sign!({hash: `0x${txIdOf(raw)}`});
    return encodeSigned(raw, signature.replace(/^0x/, ''));
  };
  // Distinct timestamps, so two transfers of the same amount to the same address cannot collide.
  const now = Date.now();
  const feeTx = await signed(o.quote.relayer, o.quote.fee, o.quote.feeLimitSun.fee, now);
  const transferTx = await signed(o.to, o.amount, o.quote.feeLimitSun.transfer, now + 1);
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
    case 'fee-too-low':
    case 'fee-too-high':
      return 'The network fee changed. Try again.';
    case 'fee-failed':
      return 'The fee could not be paid, so nothing was sent.';
    case 'relayer-unfunded':
    case 'relayer-not-configured':
    case 'top-up-failed':
      return 'Paying the fee in USDT is not available right now. Try again later, or pay it in TRX.';
    default:
      return `The transfer could not be sent (${reason}).`;
  }
}

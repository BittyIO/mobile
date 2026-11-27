/**
 * Energy rental on Tron through TronSave (docs.tronsave.io, API v2), so a token transfer spends
 * rented energy instead of burning TRX for it.
 *
 * The signed-transaction flow: no API key and no Bitty server. The wallet signs a TRX payment to
 * TronSave's fund address for the quoted price and hands it over with the order; TronSave
 * broadcasts the payment and its sellers delegate the energy to the wallet for {RENT_SECONDS}.
 * The send then waits until the energy shows on the account before it goes out.
 *
 * Offered on Nile first ({RENTAL_NETWORKS}); mainnet is the same API on another host.
 */
import {apiFetch} from '@/core/chain';
import type {Signer} from '@/wallet/signer';
import {accountEnergy, createTrxTransfer} from './client';
import type {TronChain} from './config';

/** TronSave's API per network: the same paths on both. */
const TRONSAVE_API: Record<TronChain, string> = {
  tron: 'https://api.tronsave.io',
  'tron-nile': 'https://api-dev.tronsave.io',
};

/** Where an order's TRX goes (TronSave's fund address; the Nile one is for testing only). */
const TRONSAVE_FUND: Record<TronChain, string> = {
  tron: 'TWZEhq5JuUVvGtutNgnRBATbF8BnHGyn4S',
  'tron-nile': 'TATT1UzHRikft98bRFqApFTsaSw73ycfoS',
};

/** Where the app offers rental: Nile for now. */
const RENTAL_NETWORKS: TronChain[] = ['tron-nile'];

/** How long the energy is rented: enough to wait for it and send. 5 and 15 minutes cost the same. */
export const RENT_SECONDS = 900;

/** Rented in steps of this much energy, never less than {MIN_RENT}: TRONSAVE's smallest order is 64,000. */
const STEP = 1_000;
const MIN_RENT = 64_000;

export const rentalOffered = (net: string): net is TronChain => (RENTAL_NETWORKS as string[]).includes(net);

/** The energy to rent for `need`, rounded up to the step. */
export const rentAmount = (need: number): number => Math.max(MIN_RENT, Math.ceil(need / STEP) * STEP);

export type RentQuote = {
  /** Energy being rented. */
  energy: number;
  /** What it costs, in sun: the TRX the payment sends. */
  costSun: bigint;
  /** Sun per energy, as quoted; the order is placed at this price. */
  unitPrice: number;
  /** How much of `energy` the market has right now. */
  available: number;
};

type Reply<T> = {error: boolean; message: string; data?: T};

async function call<T>(net: TronChain, path: string, body: unknown): Promise<T> {
  const res = await apiFetch(TRONSAVE_API[net] + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}, 15_000);
  const r = (await res.json().catch(() => null)) as Reply<T> | null;
  if (!res.ok || !r || r.error || !r.data) throw new Error(`TronSave: ${r?.message ?? `HTTP ${res.status}`}`);
  return r.data;
}

/** What renting `energy` for `receiver` costs right now. */
export async function quoteEnergy(net: TronChain, receiver: string, energy: number): Promise<RentQuote> {
  const d = await call<{unitPrice: number; estimateTrx: number; availableResource: number}>(net, '/v2/estimate-buy-resource', {
    resourceType: 'ENERGY',
    receiver,
    resourceAmount: energy,
    durationSec: RENT_SECONDS,
    unitPrice: 'MEDIUM',
  });
  return {energy, costSun: BigInt(Math.ceil(d.estimateTrx)), unitPrice: d.unitPrice, available: d.availableResource};
}

/**
 * Pay for and place the order: a TRX transfer of the quoted cost from `wallet` to TronSave's fund
 * address, signed here and sent with the order. Returns TronSave's order id.
 */
export async function rentEnergy(o: {net: TronChain; account: Signer; wallet: string; quote: RentQuote}): Promise<string> {
  if (!o.account.sign) throw new Error('This key cannot sign a Tron transaction');
  const tx = await createTrxTransfer(o.net, o.wallet, TRONSAVE_FUND[o.net], o.quote.costSun);
  const signature = (await o.account.sign({hash: `0x${tx.txID}`})).replace(/^0x/, '');
  const d = await call<{orderId: string}>(o.net, '/v2/buy-resource', {
    resourceType: 'ENERGY',
    receiver: o.wallet,
    resourceAmount: o.quote.energy,
    durationSec: RENT_SECONDS,
    unitPrice: o.quote.unitPrice,
    // Whole or not at all: a part-filled order would leave the transfer burning TRX anyway.
    options: {allowPartialFill: false, onlyCreateWhenFulfilled: true},
    signedTx: {...tx, signature: [signature]},
  });
  return d.orderId;
}

/** The energy `address` can spend now. */
export async function freeEnergy(net: TronChain, address: string): Promise<number> {
  const e = await accountEnergy(net, address);
  return Math.max(0, e.limit - e.used);
}

/**
 * Wait until `address` can spend at least `need` energy (the rental's delegation has landed).
 * TronSave delegates in about a block (3 s); checked every second, sent the moment it shows.
 * Resolves with the energy there; throws after `timeoutMs`.
 */
export async function untilEnergy(net: TronChain, address: string, need: number, timeoutMs = 30_000): Promise<number> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const have = await freeEnergy(net, address).catch(() => 0);
    if (have >= need) return have;
    if (Date.now() > end) throw new Error('The rented energy has not arrived yet. Nothing was sent; try again.');
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

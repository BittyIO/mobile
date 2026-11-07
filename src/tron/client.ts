/**
 * Reads and broadcasts against a Tron node (TronGrid). Every read is bounded by {apiFetch}'s timeout,
 * like the rest of the app's network calls, so a stalled node shows an error instead of a spinner.
 *
 * Nothing here signs: see ./tx for the bytes and ./send for putting the two together.
 */
import {apiFetch} from '@/core/chain';
import {fromTronHex, toHex, tronHex} from './address';
import {trc20TransferData, type RefBlock} from './tx';
import {SUN_PER_TRX, TRON_API, TRON_ASSETS, type TronAsset, type TronNet} from './config';

/**
 * The nodes to ask, in order.
 *
 * TronGrid without an API key refuses (429) a second request that arrives while the first is in
 * flight, so a page's handful of parallel reads failed all but one. Mainnet's node API (/wallet/…)
 * goes to PublicNode first, which serves the same API and takes bursts, with TronGrid behind it.
 * The account history (/v1/…) is TronGrid's own index with no second source; it and every other
 * TronGrid call go through {paced}, one at a time.
 */
const WALLET_NODES: Record<TronNet, string[]> = {
  tron: ['https://tron-rpc.publicnode.com', TRON_API.tron],
  'tron-nile': [TRON_API['tron-nile']],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TronGrid, one request at a time and a few hundred milliseconds apart: what it serves unkeyed. */
const TRONGRID_GAP_MS = 350;
let tronGridQueue: Promise<unknown> = Promise.resolve();
function paced<T>(host: string, run: () => Promise<T>): Promise<T> {
  if (!host.includes('trongrid.io')) return run();
  const next = tronGridQueue.then(run, run);
  tronGridQueue = next.then(
    () => sleep(TRONGRID_GAP_MS),
    () => sleep(TRONGRID_GAP_MS),
  );
  return next;
}

/** One request, retried on a rate limit or a node error, across the nodes for its path. */
async function request<T>(net: TronNet, path: string, init?: RequestInit): Promise<T> {
  const hosts = path.startsWith('/wallet/') ? WALLET_NODES[net] : [TRON_API[net]];
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const host of hosts) {
      try {
        const res = await paced(host, () => apiFetch(host + path, init, 15_000));
        if (res.ok) return (await res.json()) as T;
        last = new Error(`Tron node ${res.status}`);
        // A refusal of the request itself will not change on another try.
        if (res.status !== 429 && res.status < 500) throw last;
      } catch (e) {
        last = e;
        if (e instanceof Error && /^Tron node 4(?!29)/.test(e.message)) throw e;
      }
    }
    await sleep(600 * (attempt + 1));
  }
  throw last instanceof Error ? last : new Error('Tron network unreachable');
}

const post = <T,>(net: TronNet, path: string, body: unknown) =>
  request<T>(net, path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

const get = <T,>(net: TronNet, path: string) => request<T>(net, path);

/** The latest block, as the reference a new transaction anchors to. */
export async function refBlock(net: TronNet): Promise<RefBlock> {
  const b = await post<{blockID: string; block_header: {raw_data: {timestamp: number}}}>(net, '/wallet/getnowblock', {});
  if (!b?.blockID) throw new Error('Tron node returned no block');
  return {blockID: b.blockID, timestamp: b.block_header.raw_data.timestamp};
}

type Account = {balance?: number; address?: string};

/** The account, or null when the address has never received anything (Tron accounts exist only once activated). */
async function account(net: TronNet, address: string): Promise<Account | null> {
  const a = await post<Account>(net, '/wallet/getaccount', {address: tronHex(address)});
  return a && a.address ? a : null;
}

/** A constant (read-only) contract call, returning the first result word, or null when it reverted. */
async function constantCall(net: TronNet, owner: string, contract: string, selector: string, parameter: string) {
  const r = await post<{constant_result?: string[]; energy_used?: number; result?: {result?: boolean; message?: string}}>(net, '/wallet/triggerconstantcontract', {
    owner_address: tronHex(owner),
    contract_address: tronHex(contract),
    function_selector: selector,
    parameter,
  });
  return r;
}

const word = (hexAddr20: string) => hexAddr20.padStart(64, '0');

async function trc20Balance(net: TronNet, owner: string, token: string): Promise<bigint> {
  const r = await constantCall(net, owner, token, 'balanceOf(address)', word(tronHex(owner).slice(2)));
  const out = r.constant_result?.[0];
  return out ? BigInt('0x' + out) : 0n;
}

export type TronBalance = {asset: TronAsset; raw: bigint};

/** TRX and every token the wallet lists, in base units. */
export async function balances(net: TronNet, address: string): Promise<TronBalance[]> {
  const assets = TRON_ASSETS[net];
  return Promise.all(
    assets.map(async (asset) => ({
      asset,
      raw: asset.contract ? await trc20Balance(net, address, asset.contract) : BigInt((await account(net, address))?.balance ?? 0),
    })),
  );
}

type Resources = {freeNetLimit?: number; freeNetUsed?: number; NetLimit?: number; NetUsed?: number; EnergyLimit?: number; EnergyUsed?: number};
type ChainParams = {chainParameter: {key: string; value?: number}[]};

let paramsCache: {net: TronNet; at: number; p: Record<string, number>} | null = null;
async function chainParams(net: TronNet): Promise<Record<string, number>> {
  if (paramsCache && paramsCache.net === net && Date.now() - paramsCache.at < 10 * 60_000) return paramsCache.p;
  const r = await get<ChainParams>(net, '/wallet/getchainparameters');
  const p: Record<string, number> = {};
  for (const x of r.chainParameter ?? []) p[x.key] = x.value ?? 0;
  paramsCache = {net, at: Date.now(), p};
  return p;
}

/**
 * What a send will cost, in sun of TRX.
 *
 * Tron charges in resources, not gas: every transaction needs bandwidth (its size in bytes), and a
 * contract call such as a USDT transfer also needs energy. Each account gets some bandwidth free
 * every day and may hold more of either by staking; whatever it lacks is paid by burning TRX at the
 * chain's current price. Sending TRX to an address that has never been used also pays to create it.
 */
export type TronFee = {
  /** The TRX this send is expected to burn. 0 when the free bandwidth covers it. */
  burnSun: bigint;
  /** Part of {burnSun}: activating a recipient that has never been used. */
  activationSun: bigint;
  /** What to allow a contract call to burn at most (fee_limit). 0 for a TRX transfer, which has none. */
  feeLimitSun: bigint;
  energy: number;
  bandwidth: number;
};

// A signed TRX transfer is ~270 bytes on the wire, a TRC-20 transfer ~345; with headroom.
const BYTES = {trx: 280, trc20: 360};

export async function estimateFee(net: TronNet, from: string, to: string, asset: TronAsset, amount: bigint): Promise<TronFee> {
  const [res, params, recipient] = await Promise.all([
    post<Resources>(net, '/wallet/getaccountresource', {address: tronHex(from)}),
    chainParams(net),
    asset.contract ? Promise.resolve(true) : account(net, to).then(Boolean),
  ]);
  const freeBw = Math.max(0, (res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0)) + Math.max(0, (res.NetLimit ?? 0) - (res.NetUsed ?? 0));
  const bytes = asset.contract ? BYTES.trc20 : BYTES.trx;
  const sunPerByte = BigInt(params.getTransactionFee ?? 1000);

  if (!asset.contract) {
    // A new account's creation fee is charged instead of bandwidth, plus the system contract's own fee.
    const activationSun = recipient ? 0n : BigInt(params.getCreateAccountFee ?? 100_000) + BigInt(params.getCreateNewAccountFeeInSystemContract ?? 1_000_000);
    const bwSun = recipient ? (freeBw >= bytes ? 0n : BigInt(bytes) * sunPerByte) : 0n;
    return {burnSun: bwSun + activationSun, activationSun, feeLimitSun: 0n, energy: 0, bandwidth: bytes};
  }

  const call = await constantCall(net, from, asset.contract, 'transfer(address,uint256)', toHex(trc20TransferData(to, amount)).slice(8));
  if (call.result && call.result.result === false) {
    const msg = call.result.message ? hexText(call.result.message) : 'the token refused the transfer';
    throw new Error(msg);
  }
  // A transfer to an address that holds none of the token writes a new balance slot and costs about
  // twice as much; the simulation already counts that, so its figure is used as it is.
  const energy = call.energy_used ?? 0;
  const haveEnergy = Math.max(0, (res.EnergyLimit ?? 0) - (res.EnergyUsed ?? 0));
  const sunPerEnergy = BigInt(params.getEnergyFee ?? 100);
  const energySun = BigInt(Math.max(0, energy - haveEnergy)) * sunPerEnergy;
  const bwSun = freeBw >= bytes ? 0n : BigInt(bytes) * sunPerByte;
  // The cap the call may burn: the estimate with room for the energy price moving, never under
  // 10 TRX (a call that runs out of fee limit fails and still burns what it used).
  const est = BigInt(energy) * sunPerEnergy;
  const feeLimitSun = maxBig(10n * SUN_PER_TRX, (est * 3n) / 2n);
  return {burnSun: energySun + bwSun, activationSun: 0n, feeLimitSun, energy, bandwidth: bytes};
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/** The node returns some messages hex-encoded. */
function hexText(s: string): string {
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) return s;
  let out = '';
  for (let i = 0; i < s.length; i += 2) out += String.fromCharCode(parseInt(s.slice(i, i + 2), 16));
  return /^[\x20-\x7e]+$/.test(out) ? out : s;
}

/** Broadcast a signed transaction. Resolves with its id once a node has accepted it into the pool. */
export async function broadcast(net: TronNet, signedHex: string, txID: string): Promise<string> {
  const r = await post<{result?: boolean; code?: string; message?: string; txid?: string}>(net, '/wallet/broadcasthex', {transaction: signedHex});
  if (!r.result) throw new Error(r.message ? hexText(r.message) : r.code ?? 'The Tron node refused the transaction');
  return r.txid ?? txID;
}

/** Whether a broadcast transaction made it: 'pending' until it is in a block, then what it did. */
export async function txStatus(net: TronNet, txID: string): Promise<'pending' | 'success' | 'failed'> {
  const r = await post<{id?: string; receipt?: {result?: string}; result?: string}>(net, '/wallet/gettransactioninfobyid', {value: txID});
  if (!r?.id) return 'pending';
  // A TRX transfer has no receipt result; a contract call reports SUCCESS or why it stopped.
  if (r.result === 'FAILED') return 'failed';
  if (r.receipt?.result && r.receipt.result !== 'SUCCESS') return 'failed';
  return 'success';
}

export type TronTransfer = {
  txID: string;
  at: number;
  symbol: string;
  decimals: number;
  raw: bigint;
  direction: 'in' | 'out';
  counterparty: string;
  failed: boolean;
  /** What the wallet paid in TRX (sun) for an outgoing transfer — bandwidth and energy burned. */
  fee?: bigint;
};

type V1Tx = {
  txID: string;
  block_timestamp: number;
  ret?: {contractRet?: string; fee?: number}[];
  net_fee?: number;
  energy_fee?: number;
  raw_data: {contract: {type: string; parameter: {value: {amount?: number; owner_address?: string; to_address?: string}}}[]};
};
type V1Trc20 = {transaction_id: string; block_timestamp: number; from: string; to: string; value: string; token_info: {symbol: string; decimals: number; address: string}};

/**
 * The wallet's recent TRX and USDT transfers, newest first.
 *
 * Only the listed tokens: anyone can send any TRC-20 to any address, and the junk tokens scammers
 * airdrop to look like a payment are exactly what a wallet should not show next to the real one.
 */
export async function recentTransfers(net: TronNet, address: string, limit = 30): Promise<TronTransfer[]> {
  const me = address;
  const tokens = TRON_ASSETS[net].filter((a) => a.contract);
  /*
   * Not `only_confirmed`: TronGrid takes a minute or more to mark a transaction confirmed (solidified),
   * and with that filter a payment just sent was missing from the History the user opened to look
   * for it. A transaction in a block — every 3 s — is listed at once, its result already known.
   */
  const [trx, ...trc20] = await Promise.all([
    get<{data?: V1Tx[]}>(net, `/v1/accounts/${me}/transactions?limit=${limit}`),
    ...tokens.map((t) => get<{data?: V1Trc20[]}>(net, `/v1/accounts/${me}/transactions/trc20?limit=${limit}&contract_address=${t.contract}`)),
  ]);
  const out: TronTransfer[] = [];
  // Every transaction the wallet sent is in this list — a USDT transfer as a contract call — and
  // carries what it burned, so a TRC-20 send below finds its fee here by id.
  const fees = new Map<string, bigint>();
  for (const tx of trx.data ?? []) {
    const fee = tx.ret?.[0]?.fee ?? (tx.net_fee ?? 0) + (tx.energy_fee ?? 0);
    fees.set(tx.txID, BigInt(fee));
  }
  for (const tx of trx.data ?? []) {
    const c = tx.raw_data?.contract?.[0];
    if (c?.type !== 'TransferContract') continue;
    const v = c.parameter.value;
    if (!v.owner_address || !v.to_address) continue;
    const from = fromTronHex(v.owner_address);
    const to = fromTronHex(v.to_address);
    const out_ = from === me;
    out.push({
      txID: tx.txID,
      at: tx.block_timestamp,
      symbol: 'TRX',
      decimals: 6,
      raw: BigInt(v.amount ?? 0),
      direction: out_ ? 'out' : 'in',
      counterparty: out_ ? to : from,
      failed: !!tx.ret?.[0]?.contractRet && tx.ret[0].contractRet !== 'SUCCESS',
      fee: out_ ? fees.get(tx.txID) : undefined,
    });
  }
  trc20.forEach((list, i) => {
    for (const x of list.data ?? []) {
      // The listed contract only, whatever symbol a token gives itself.
      if (x.token_info?.address !== tokens[i].contract) continue;
      const out_ = x.from === me;
      out.push({
        txID: x.transaction_id,
        at: x.block_timestamp,
        symbol: tokens[i].symbol,
        decimals: tokens[i].decimals,
        raw: BigInt(x.value),
        direction: out_ ? 'out' : 'in',
        counterparty: out_ ? x.to : x.from,
        failed: false,
        fee: out_ ? fees.get(x.transaction_id) : undefined,
      });
    }
  });
  return out.filter((x) => !isDust(x)).sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * An incoming transfer too small to be a payment: address poisoning. Scammers send a few sun of TRX
 * or a ten-thousandth of a USDT from an address made to look like one the user pays, so that it sits
 * at the top of the history waiting to be copied. Under 0.1 of either is left out of the list.
 */
const isDust = (x: TronTransfer) => x.direction === 'in' && x.raw * 10n < 10n ** BigInt(x.decimals);

/** TRX in US dollars, from Coinbase (as the app's other spot prices), else Binance. Null when neither answers. */
export async function trxUsd(): Promise<number | null> {
  try {
    const r = await apiFetch('https://api.coinbase.com/v2/prices/TRX-USD/spot', undefined, 8000);
    const n = Number(((await r.json()) as {data?: {amount?: string}})?.data?.amount);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    const r = await apiFetch('https://api.binance.com/api/v3/ticker/price?symbol=TRXUSDT', undefined, 8000);
    const n = Number(((await r.json()) as {price?: string})?.price);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return null;
}

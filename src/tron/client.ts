/**
 * The java-tron node API (`/wallet/…`) the Tron Nile vault needs beyond JSON-RPC: the reference
 * block a transaction anchors to, the owner's energy, and broadcasting a signed transaction. Every
 * read is bounded by {apiFetch}'s timeout, like the rest of the app's network calls.
 *
 * Nothing here signs: see ./tx for the bytes and ./vault-tx for putting the two together.
 */
import {apiFetch} from '@/core/chain';
import {tronHex} from './address';
import type {RefBlock} from './tx';
import type {TronChain} from './config';
import {rpcUrlsFor, tronApiHost} from '@/core/rpc-store';

/**
 * The nodes to ask, in order: the ones switched on in Settings › RPC nodes (`core/rpc-store`), the
 * owner's own first. TronGrid without an API key refuses (429) a second request that arrives while
 * the first is in flight, so its calls go through {paced}, one at a time.
 */
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

/**
 * Where `/wallet/…` goes. Nile's node list is JSON-RPC (what every vault read goes to), so its API
 * is the same hosts without the `/jsonrpc` path — one list in Settings › RPC nodes, for reads and
 * broadcasts alike.
 */
const walletHosts = (net: TronChain): string[] => rpcUrlsFor(net).map(tronApiHost);

/** One request, retried on a rate limit or a node error, across the nodes for its path. */
async function request<T>(net: TronChain, path: string, init?: RequestInit): Promise<T> {
  const hosts = walletHosts(net);
  if (!hosts.length) throw new Error('No Tron node is on in Settings › RPC nodes');
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

const post = <T,>(net: TronChain, path: string, body: unknown) =>
  request<T>(net, path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

/** The latest block, as the reference a new transaction anchors to. */
export async function refBlock(net: TronChain): Promise<RefBlock> {
  const b = await post<{blockID: string; block_header: {raw_data: {timestamp: number}}}>(net, '/wallet/getnowblock', {});
  if (!b?.blockID) throw new Error('Tron node returned no block');
  return {blockID: b.blockID, timestamp: b.block_header.raw_data.timestamp};
}

type Resources = {
  freeNetLimit?: number;
  freeNetUsed?: number;
  NetLimit?: number;
  NetUsed?: number;
  EnergyLimit?: number;
  EnergyUsed?: number;
  /** The whole network's daily energy, and the TRX staked for it: their ratio is energy per TRX. */
  TotalEnergyLimit?: number;
  TotalEnergyWeight?: number;
};

export type TronEnergy = {
  /** The account's energy per day: what it has staked plus what is delegated to it. */
  limit: number;
  /** Spent in the last 24 hours; it recovers over a day. */
  used: number;
  /** Energy a day for each TRX staked, network-wide right now. Moves as others stake. */
  perTrxPerDay: number;
};

/** An account's energy, and what one staked TRX earns in energy today. */
export async function accountEnergy(net: TronChain, address: string): Promise<TronEnergy> {
  const r = await post<Resources>(net, '/wallet/getaccountresource', {address: tronHex(address)});
  const weight = r.TotalEnergyWeight ?? 0;
  return {
    limit: r.EnergyLimit ?? 0,
    used: r.EnergyUsed ?? 0,
    perTrxPerDay: weight > 0 ? (r.TotalEnergyLimit ?? 0) / weight : 0,
  };
}

/**
 * Whether `address` is an account on chain yet. Tron creates one on its first incoming TRX or
 * TRC-20, and charges the SENDER for it: 1 TRX burned on top of the transfer, plus 0.1 TRX for the
 * bandwidth of a TRX transfer that creates it.
 */
export async function accountExists(net: TronChain, address: string): Promise<boolean> {
  const r = await post<{address?: string}>(net, '/wallet/getaccount', {address: tronHex(address)});
  return !!r?.address;
}

/** An account's stake, as the node reports it: what is frozen, and what is unstaking or unlocked. */
export type TronStake = {
  /** TRX frozen for ENERGY under Stake 2.0, in sun. */
  energySun: bigint;
  /** Each unstake still in Tron's delay or unlocked and not withdrawn: sun, and when it unlocks (ms). */
  unfreezing: {amountSun: bigint; unlockMs: number}[];
  /** Staked for ENERGY and lent out (delegated) to other addresses, in sun: frozen too, not in energySun. */
  delegatedSun: bigint;
};

export async function accountStake(net: TronChain, address: string): Promise<TronStake> {
  type Acc = {
    frozenV2?: {type?: string; amount?: number}[];
    unfrozenV2?: {type?: string; unfreeze_amount?: number; unfreeze_expire_time?: number}[];
    account_resource?: {delegated_frozenV2_balance_for_energy?: number};
  };
  const r = await post<Acc>(net, '/wallet/getaccount', {address: tronHex(address)});
  const energy = (r.frozenV2 ?? []).filter((f) => f.type === 'ENERGY').reduce((n, f) => n + BigInt(f.amount ?? 0), BigInt(0));
  const unfreezing = (r.unfrozenV2 ?? [])
    .filter((u) => u.type === 'ENERGY' && (u.unfreeze_amount ?? 0) > 0)
    .map((u) => ({amountSun: BigInt(u.unfreeze_amount ?? 0), unlockMs: u.unfreeze_expire_time ?? 0}));
  return {energySun: energy, unfreezing, delegatedSun: BigInt(r.account_resource?.delegated_frozenV2_balance_for_energy ?? 0)};
}

/** The node returns some messages hex-encoded. */
export function hexText(s: string): string {
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) return s;
  let out = '';
  for (let i = 0; i < s.length; i += 2) out += String.fromCharCode(parseInt(s.slice(i, i + 2), 16));
  return /^[\x20-\x7e]+$/.test(out) ? out : s;
}

/** Broadcast a signed transaction. Resolves with its id once a node has accepted it into the pool. */
export async function broadcast(net: TronChain, signedHex: string, txID: string): Promise<string> {
  const r = await post<{result?: boolean; code?: string; message?: string; txid?: string}>(net, '/wallet/broadcasthex', {transaction: signedHex});
  if (!r.result) throw new Error(r.message ? hexText(r.message) : r.code ?? 'The Tron node refused the transaction');
  return r.txid ?? txID;
}

/** A TRX transfer as the node builds it, unsigned, in the JSON form (`visible`: base58 addresses). */
export type NodeTx = {visible: boolean; txID: string; raw_data: unknown; raw_data_hex: string};

/**
 * Have the node build an unsigned TRX transfer, for a service that wants the whole transaction
 * object rather than its bytes (tron/energy-rental: TronSave broadcasts the payment itself).
 */
export async function createTrxTransfer(net: TronChain, from: string, to: string, amountSun: bigint): Promise<NodeTx> {
  const tx = await post<NodeTx & {Error?: string}>(net, '/wallet/createtransaction', {
    owner_address: from,
    to_address: to,
    amount: Number(amountSun),
    visible: true,
  });
  if (!tx?.txID) throw new Error(tx?.Error ?? 'The Tron node did not build the transfer');
  return tx;
}

const memoFees: Partial<Record<TronChain, bigint>> = {};

/**
 * What Tron burns for a transaction with a note (the chain's `getMemoFee`, in sun: 1 TRX on mainnet
 * and Nile today). Read once per run.
 */
export async function memoFeeSun(net: TronChain): Promise<bigint> {
  const known = memoFees[net];
  if (known != null) return known;
  const r = await request<{chainParameter?: {key: string; value?: number}[]}>(net, '/wallet/getchainparameters');
  const fee = BigInt(r.chainParameter?.find((p) => p.key === 'getMemoFee')?.value ?? 1_000_000);
  memoFees[net] = fee;
  return fee;
}

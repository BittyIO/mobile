import {MMKV} from 'react-native-mmkv';
import {encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {TRON_API} from '@/tron/config';
import {evmToTron} from '@/tron/address';
import type {TronChain} from '@/tron/config';
import type {AccountCall} from './relay';
import {accountEvents} from './events';

/**
 * The Tron smart wallet's protections (BittyAccount): payees, a daily limit for everyone else, a
 * lock, and the timelock that everything loosening them waits out. Tightening is instant; loosening
 * (a higher or no limit, a shorter timelock, a call to another contract) is QUEUED by id and run once
 * the timelock has passed, unless a lock lands first. The chain keeps only the id, so the batch a
 * queued id stands for is kept here ({rememberQueued}) to run it later.
 */
export const GUARD_ABI = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'struct Payee { uint64 readyAt; uint64 removeAt; uint32 addEpoch; uint32 removeEpoch; }',
  'struct Queued { uint64 readyAt; uint32 epoch; }',
  'function locked() view returns (bool)',
  'function lockEpoch() view returns (uint32)',
  'function timelock() view returns (uint32)',
  'function unlockAt() view returns (uint64)',
  'function dailyLimit() view returns (uint256 limit, bool unlimited)',
  'function leftToday() view returns (uint256)',
  'function isPayee(address) view returns (bool)',
  'function payee(address) view returns (Payee)',
  'function queued(bytes32) view returns (Queued)',
  'function lock()',
  'function requestUnlock()',
  'function unlock()',
  'function setDailyLimit(uint256 limit, bool unlimited)',
  'function setTimelock(uint32 seconds_)',
  'function addPayee(address payee)',
  'function removePayee(address payee)',
  'function queue(bytes32 id)',
  'function cancelQueued(bytes32 id)',
  'function executeQueued(Call[] calls)',
]);

export type AccountGuard = {
  locked: boolean;
  /** Seconds. */
  timelock: number;
  /** Unix seconds an unlock asked for comes due; 0 for none. */
  unlockAt: number;
  /** USDT units; null for no limit. */
  limit: bigint | null;
  /** What is left of today's limit (USDT units); null for no limit. */
  left: bigint | null;
};

export async function readGuard(network: Network, account: Address): Promise<AccountGuard> {
  const c = publicClientFor(network);
  const r = <T>(functionName: string) => c.readContract({address: account, abi: GUARD_ABI, functionName: functionName as never}) as Promise<T>;
  const [locked, timelock, unlockAt, [limit, unlimited], left] = await Promise.all([
    r<boolean>('locked'),
    r<number>('timelock'),
    r<bigint>('unlockAt'),
    r<[bigint, boolean]>('dailyLimit'),
    r<bigint>('leftToday'),
  ]);
  return {locked, timelock: Number(timelock), unlockAt: Number(unlockAt), limit: unlimited ? null : limit, left: unlimited ? null : left};
}

export type PayeeState = {address: Address; readyAt: number; removeAt: number; payable: boolean};

/**
 * The account's payees. The contract keeps them in a mapping with no list, so who to ask about is
 * read from its PayeeAdded events (TronGrid), then each one's state from the chain itself.
 */
export async function readPayees(network: Network, account: Address): Promise<PayeeState[]> {
  // TronGrid can't name the account's events (no ABI published for a clone): decoded from its logs.
  const events = await accountEvents(network, account);
  const seen = [...new Set(events.filter((e) => e.event_name === 'PayeeAdded').map((e) => getAddress(e.result.payee)))];
  const c = publicClientFor(network);
  const rows = await Promise.all(
    seen.map(async (address) => {
      const [p, payable] = await Promise.all([
        c.readContract({address: account, abi: GUARD_ABI, functionName: 'payee', args: [address]}) as Promise<{readyAt: bigint; removeAt: bigint}>,
        c.readContract({address: account, abi: GUARD_ABI, functionName: 'isPayee', args: [address]}) as Promise<boolean>,
      ]);
      return {address, readyAt: Number(p.readyAt), removeAt: Number(p.removeAt), payable};
    }),
  );
  // Gone ones (removed, or a removal that has passed) drop out.
  const now = Math.floor(Date.now() / 1000);
  return rows.filter((p) => p.readyAt !== 0 && !(p.removeAt !== 0 && p.removeAt <= now && !p.payable));
}

/** A call on the account itself. */
const self = (account: Address, data: Hex): AccountCall => ({to: account, value: BigInt(0), data});
const enc = (functionName: string, args: readonly unknown[] = []) => encodeFunctionData({abi: GUARD_ABI, functionName: functionName as never, args: args as never});

export const lockCall = (a: Address) => self(a, enc('lock'));
export const requestUnlockCall = (a: Address) => self(a, enc('requestUnlock'));
export const unlockCall = (a: Address) => self(a, enc('unlock'));
export const addPayeeCall = (a: Address, payee: Address) => self(a, enc('addPayee', [payee]));
export const removePayeeCall = (a: Address, payee: Address) => self(a, enc('removePayee', [payee]));
export const setLimitCall = (a: Address, limit: bigint | null) => self(a, enc('setDailyLimit', [limit ?? BigInt(0), limit === null]));
export const setTimelockCall = (a: Address, seconds: number) => self(a, enc('setTimelock', [seconds]));

/** Whether a new limit loosens the current one (then it waits out the timelock). */
export const limitLoosens = (now: bigint | null, next: bigint | null) => now !== null && (next === null || next > now);

/** The id the account queues a batch under: keccak256(abi.encode(calls)). */
export function queuedId(calls: AccountCall[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [{type: 'tuple[]', components: [{name: 'to', type: 'address'}, {name: 'value', type: 'uint256'}, {name: 'data', type: 'bytes'}]}],
      [calls.map((c) => ({to: c.to, value: c.value, data: c.data}))],
    ),
  );
}

/** What a loosening becomes while there is a timelock: the batch queued, to run after it. */
export const queueCall = (a: Address, inner: AccountCall[]) => self(a, enc('queue', [queuedId(inner)]));
export const cancelQueuedCall = (a: Address, id: Hex) => self(a, enc('cancelQueued', [id]));
export const executeQueuedCall = (a: Address, inner: AccountCall[]) => self(a, enc('executeQueued', [inner.map((c) => ({to: c.to, value: c.value, data: c.data}))]));

/** A queued batch, as kept on this phone: what it does, so it can be named and run. */
export type QueuedBatch = {id: Hex; kind: 'limit' | 'timelock'; value: string | null; calls: {to: Address; value: string; data: Hex}[]; readyAt?: number};

const store = new MMKV({id: 'bitty.account-queued'});
const keyOf = (network: Network, account: Address) => `${network}:${account.toLowerCase()}`;

export function rememberQueued(network: Network, account: Address, b: QueuedBatch) {
  const all = queuedOnPhone(network, account).filter((x) => x.id !== b.id);
  store.set(keyOf(network, account), JSON.stringify([...all, b]));
}

export function forgetQueued(network: Network, account: Address, id: Hex) {
  store.set(keyOf(network, account), JSON.stringify(queuedOnPhone(network, account).filter((x) => x.id !== id)));
}

export function queuedOnPhone(network: Network, account: Address): QueuedBatch[] {
  try {
    return JSON.parse(store.getString(keyOf(network, account)) ?? '[]') as QueuedBatch[];
  } catch {
    return [];
  }
}

/** Each kept batch with its state on chain: when it comes due, or gone (run, cancelled, or a lock). */
export async function readQueued(network: Network, account: Address): Promise<(QueuedBatch & {readyAt: number})[]> {
  const c = publicClientFor(network);
  const out: (QueuedBatch & {readyAt: number})[] = [];
  for (const b of queuedOnPhone(network, account)) {
    const q = (await c.readContract({address: account, abi: GUARD_ABI, functionName: 'queued', args: [b.id]})) as {readyAt: bigint};
    if (Number(q.readyAt) === 0) forgetQueued(network, account, b.id);
    else out.push({...b, readyAt: Number(q.readyAt)});
  }
  return out;
}

export const innerCalls = (b: QueuedBatch): AccountCall[] => b.calls.map((c) => ({to: c.to, value: BigInt(c.value), data: c.data}));

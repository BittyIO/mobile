import {decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {TRON_API, type TronChain} from '@/tron/config';
import {evmToTron} from '@/tron/address';
import {NO_LIMIT} from '@/vault/capabilities';
import type {PendingChange, RiskConfig, SecurityHistoryItem, TimelockHistoryItem} from '@/vault/risk';
import type {WhitelistedRecipient} from '@/vault/payments';
import {WHITELIST_STATUS} from '@/core/abi';
import type {RiskValues} from '@/core/safety-levels';
import type {GuardValues} from '@/core/new-vault-defaults';
import {
  GUARD_ABI,
  cancelQueuedCall,
  executeQueuedCall,
  innerCalls,
  queueCall,
  queuedId,
  queuedOnPhone,
  readGuard,
  rememberQueued,
  setLimitCall,
  setTimelockCall,
  type AccountGuard,
  type QueuedBatch,
} from './guard';
import type {AccountCall} from './relay';
import {accountEvents, type AccountEvent as Ev} from './events';

/**
 * The Tron smart wallet's protections in the vault's own terms, so the EVM Guard pages
 * (PendingChangesScreen, GuardLevelScreen) draw it as they draw a vault: its timelock and daily
 * limit as RiskValues, what is waiting as PendingChange, what went through as the two histories.
 *
 * Units: the vault's limits are whole dollars and NO_LIMIT for none; the account's is USDT units
 * (6 decimals) or unlimited. The account has one limit, for sends to non-payees, so it stands for
 * both of the vault's (sending, and trading/bridging), which every Guard level sets alike.
 */
const USDT = BigInt(1_000_000);
export const limitToUsd = (limit: bigint | null): bigint => (limit === null ? NO_LIMIT : limit / USDT);
export const usdToLimit = (usd: bigint): bigint | null => (usd === NO_LIMIT ? null : usd * USDT);

export function accountRiskValues(g: AccountGuard): RiskValues {
  const usd = limitToUsd(g.limit);
  return {timelock: BigInt(g.timelock), sendDailyAllowance: usd, marketTradeDailyLossAllowance: usd};
}

/**
 * The calls that move the account to a Guard level's numbers: what tightens at once, and what
 * loosens queued behind the timelock in force (kept on this phone to run when due). Empty when the
 * account is there already.
 */
export function guardLevelCalls(network: Network, account: Address, g: AccountGuard, want: GuardValues): {calls: AccountCall[]; queued: QueuedBatch | null} {
  const now: bigint | null = g.limit;
  const next = usdToLimit(want.sendDailyAllowance);
  const tl = Number(want.timelock);
  const direct: AccountCall[] = [];
  const later: AccountCall[] = [];
  const limitLooser = now === null ? false : next === null || next > now;
  if (next !== now) (limitLooser && g.timelock > 0 ? later : direct).push(setLimitCall(account, next));
  // A longer timelock goes first, so anything queued in the same batch waits it out too.
  if (tl !== g.timelock) (tl < g.timelock ? later : direct).push(setTimelockCall(account, tl));
  if (!later.length) return {calls: direct, queued: null};
  const id = queuedId(later);
  return {
    calls: [...direct, queueCall(account, later)],
    queued: {id, kind: 'limit', value: null, calls: later.map((c) => ({to: c.to, value: c.value.toString(), data: c.data}))},
  };
}

export const rememberGuardBatch = (network: Network, account: Address, b: QueuedBatch) => rememberQueued(network, account, b);

/** A queued batch's own changes, as the vault names them; `from` the value in force now. */
function batchChanges(b: QueuedBatch, at: bigint, g: AccountGuard | null): PendingChange[] {
  const out: PendingChange[] = [];
  for (const c of innerCalls(b)) {
    try {
      const d = decodeFunctionData({abi: GUARD_ABI, data: c.data});
      if (d.functionName === 'setTimelock') out.push({kind: 'timelock', value: BigInt(d.args[0] as number), at, ...(g ? {from: BigInt(g.timelock)} : {})});
      if (d.functionName === 'setDailyLimit') {
        const [limit, unlimited] = d.args as readonly [bigint, boolean];
        out.push({kind: 'sendDailyAllowance', value: unlimited ? NO_LIMIT : limit / USDT, at, ...(g ? {from: limitToUsd(g.limit)} : {})});
      }
    } catch {
      /* a call this page does not name */
    }
  }
  return out;
}


/** Every event the account has emitted, oldest first (TronGrid; the Bitty server does not index Tron). */

const addr = (v: string): Address => getAddress(v.startsWith('0x') ? v : `0x${v.slice(-40)}`);

/** What is waiting: an extra the vault has no kind for (an unlock, a batch this phone did not queue). */
export type AccountExtra = {kind: 'unlock'; at: number} | {kind: 'unknown'; id: Hex; at: number};
/** A pending change, with the queued batch behind it where it is one (to cancel or run it). */
export type AccountPending = PendingChange & {batch?: QueuedBatch};

export async function getAccountPending(network: Network, account: Address): Promise<{items: AccountPending[]; extras: AccountExtra[]; guard: AccountGuard}> {
  const c = publicClientFor(network);
  const [guard, events, lockEpoch] = await Promise.all([
    readGuard(network, account),
    accountEvents(network, account).catch(() => [] as Ev[]),
    c.readContract({address: account, abi: GUARD_ABI, functionName: 'lockEpoch'}).catch(() => 0) as Promise<number>,
  ]);
  const now = Math.floor(Date.now() / 1000);
  const items: AccountPending[] = [];
  const extras: AccountExtra[] = [];

  // Queued batches: every id the chain says is still waiting, named where this phone queued it.
  const mine = new Map(queuedOnPhone(network, account).map((b) => [b.id.toLowerCase(), b]));
  const ids = [...new Set([...events.filter((e) => e.event_name === 'CallsQueued').map((e) => String(e.result.id ?? e.result['0']).toLowerCase()), ...mine.keys()])];
  for (const id of ids) {
    const q = (await c.readContract({address: account, abi: GUARD_ABI, functionName: 'queued', args: [id as Hex]}).catch(() => null)) as {readyAt: bigint; epoch: number} | null;
    if (!q) continue;
    // Run, cancelled, or voided by a lock since it was queued.
    if (Number(q.readyAt) === 0 || Number(q.epoch) < Number(lockEpoch)) continue;
    const b = mine.get(id);
    const changes = b ? batchChanges(b, q.readyAt, guard) : [];
    if (b && changes.length) changes.forEach((ch) => items.push({...ch, batch: b}));
    else extras.push({kind: 'unknown', id: id as Hex, at: Number(q.readyAt)});
  }

  // Payees: those still maturing, and those on their way out.
  const added = [...new Set(events.filter((e) => e.event_name === 'PayeeAdded').map((e) => addr(e.result.payee ?? e.result['0'])))];
  for (const p of added) {
    const s = (await c.readContract({address: account, abi: GUARD_ABI, functionName: 'payee', args: [p]}).catch(() => null)) as {readyAt: bigint; removeAt: bigint} | null;
    if (!s) continue;
    if (Number(s.readyAt) > now) items.push({kind: 'whitelistAdd', address: p, at: s.readyAt, id: p});
    if (Number(s.removeAt) > now) items.push({kind: 'whitelistRemove', address: p, at: s.removeAt, id: p});
  }

  if (guard.locked && guard.unlockAt > 0) extras.push({kind: 'unlock', at: guard.unlockAt});
  items.sort((a, b) => Number(a.at - b.at));
  return {items, extras, guard};
}

/** Cancel: a queued batch's cancelQueued; a maturing payee's removal (instant before it is payable). */
export function accountCancelCalls(account: Address, p: AccountPending): AccountCall[] | null {
  if (p.batch) return [cancelQueuedCall(account, p.batch.id)];
  if (p.kind === 'whitelistAdd') return [{to: account, value: BigInt(0), data: removePayeeData(p.address)}];
  return null;
}
export const accountApplyCalls = (account: Address, p: AccountPending): AccountCall[] | null => (p.batch ? [executeQueuedCall(account, innerCalls(p.batch))] : null);

const removePayeeData = (payee: Address): Hex => encodeFunctionData({abi: GUARD_ABI, functionName: 'removePayee', args: [payee]});

/**
 * The two histories, from the account's events. What waited: a queued batch run (its own
 * TimelockSet / DailyLimitSet in the same transaction), a payee that matured, one that left. What
 * made it stricter at once: a lock, a cancel, a limit or timelock set directly.
 */
export async function accountHistories(network: Network, account: Address): Promise<{delays: TimelockHistoryItem[]; strengthened: SecurityHistoryItem[]}> {
  const events = await accountEvents(network, account);
  const now = Math.floor(Date.now() / 1000);
  const ts = (e: Ev) => Math.floor(e.block_timestamp / 1000);
  const queuedAt = new Map(events.filter((e) => e.event_name === 'CallsQueued').map((e) => [String(e.result.id ?? e.result['0']).toLowerCase(), ts(e)]));
  const ranIn = new Set(events.filter((e) => e.event_name === 'QueuedExecuted').map((e) => e.transaction_id));
  const mine = new Map(queuedOnPhone(network, account).map((b) => [b.id.toLowerCase(), b]));
  const delays: TimelockHistoryItem[] = [];
  const strengthened: SecurityHistoryItem[] = [];
  // The values in force, followed through the events, for "from → to".
  let timelock: bigint | undefined;
  let limit: bigint | undefined;
  for (const e of events) {
    const r = e.result;
    const at = ts(e);
    switch (e.event_name) {
      case 'TimelockSet':
      case 'DailyLimitSet': {
        const kind = e.event_name === 'TimelockSet' ? 'timelock' : 'sendDailyAllowance';
        const value = kind === 'timelock' ? BigInt(r.timelock ?? r['0']) : (r.unlimited ?? r['1']) === 'true' ? NO_LIMIT : BigInt(r.limit ?? r['0']) / USDT;
        const from = kind === 'timelock' ? timelock : limit;
        if (ranIn.has(e.transaction_id)) {
          const qid = events.find((x) => x.transaction_id === e.transaction_id && x.event_name === 'QueuedExecuted');
          const q = qid ? queuedAt.get(String(qid.result.id ?? qid.result['0']).toLowerCase()) : undefined;
          delays.push({kind, value, ...(from !== undefined ? {from} : {}), at: BigInt(at), queuedAt: q ?? at, effectiveAt: at, txHash: e.transaction_id});
        } else {
          strengthened.push({kind, from: from as bigint, value, at, txHash: e.transaction_id});
        }
        if (kind === 'timelock') timelock = value;
        else limit = value;
        break;
      }
      case 'Locked':
        strengthened.push({kind: 'lock', level: 1, at, txHash: e.transaction_id});
        break;
      case 'QueuedCancelled': {
        const b = mine.get(String(r.id ?? r['0']).toLowerCase());
        const change = b ? batchChanges(b, BigInt(at), null)[0] : undefined;
        if (change) strengthened.push({kind: 'cancel', change, at, txHash: e.transaction_id});
        break;
      }
      case 'PayeeAdded': {
        const readyAt = Number(r.readyAt ?? r['1']);
        if (readyAt <= now) {
          const p = addr(r.payee ?? r['0']);
          delays.push({kind: 'whitelistAdd', address: p, id: p, at: BigInt(readyAt), queuedAt: at, effectiveAt: readyAt, txHash: e.transaction_id});
        }
        break;
      }
      case 'PayeeRemoved': {
        const removeAt = Number(r.removeAt ?? r['1']);
        if (removeAt <= now) {
          const p = addr(r.payee ?? r['0']);
          delays.push({kind: 'whitelistRemove', address: p, id: p, at: BigInt(removeAt), queuedAt: at, effectiveAt: removeAt, txHash: e.transaction_id});
        }
        break;
      }
    }
  }
  return {delays: delays.sort((a, b) => b.effectiveAt - a.effectiveAt), strengthened: strengthened.sort((a, b) => b.at - a.at)};
}

// ── the payee book, as the vault's Payees pages read it ─────────────────


/**
 * The account's payees as the vault's address book (WhitelistedRecipient): pending while the
 * timelock runs, payable, payable until a removal lands, or voided by a lock before it matured.
 * `id` is the address itself: the account keys its payees by address, not by number.
 */
export async function accountBook(network: Network, account: Address): Promise<WhitelistedRecipient[]> {
  const c = publicClientFor(network);
  const [events, lockEpoch, locked] = await Promise.all([
    accountEvents(network, account).catch(() => [] as Ev[]),
    c.readContract({address: account, abi: GUARD_ABI, functionName: 'lockEpoch'}).catch(() => 0) as Promise<number>,
    c.readContract({address: account, abi: GUARD_ABI, functionName: 'locked'}).catch(() => false) as Promise<boolean>,
  ]);
  const now = Math.floor(Date.now() / 1000);
  const seen = [...new Set(events.filter((e) => e.event_name === 'PayeeAdded').map((e) => addr(e.result.payee ?? e.result['0'])))];
  const rows = await Promise.all(
    seen.map(async (p): Promise<WhitelistedRecipient | null> => {
      const [s, payable] = await Promise.all([
        c.readContract({address: account, abi: GUARD_ABI, functionName: 'payee', args: [p]}) as Promise<{readyAt: bigint; removeAt: bigint; addEpoch: number}>,
        c.readContract({address: account, abi: GUARD_ABI, functionName: 'isPayee', args: [p]}) as Promise<boolean>,
      ]);
      const readyAt = Number(s.readyAt);
      const removeAt = Number(s.removeAt);
      if (readyAt === 0) return null; // removed
      const base = {id: p, recipientAddress: p, chain: 'here' as const, effectiveAt: readyAt};
      if (removeAt !== 0 && removeAt > now) return {...base, status: WHITELIST_STATUS.removalQueued, removeAt};
      if (payable) return {...base, status: WHITELIST_STATUS.payable};
      // Not payable yet: still waiting, or a lock landed before it matured (its epoch is past).
      if (readyAt > now && !(locked && Number(s.addEpoch) < Number(lockEpoch))) return {...base, status: WHITELIST_STATUS.pending};
      if (Number(s.addEpoch) < Number(lockEpoch)) return {...base, status: WHITELIST_STATUS.voided};
      return null;
    }),
  );
  return rows.filter((r): r is WhitelistedRecipient => r !== null);
}

/** The account's timelock and limit as the vault's RiskConfig, for the Payees pages' notes and limits. */
export async function accountRiskConfig(network: Network, account: Address): Promise<RiskConfig> {
  const g = await readGuard(network, account);
  const v = accountRiskValues(g);
  return {read: true, open: true, timelock: v.timelock, sendDailyAllowance: v.sendDailyAllowance, marketTradeDailyLossAllowance: v.marketTradeDailyLossAllowance} as unknown as RiskConfig;
}

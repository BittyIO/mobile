/**
 * Lifetime earned overlay. The server ledgers every stake/unstake (stake-flows) and supply/withdraw
 * (supply-flows); earned = current position + total unstaked − total staked. Hidden when ≤ 0 (a fresh
 * or net-withdrawn position hasn't earned yet). Ported from web use-stake-flows / use-supply-flows.
 */
import {create} from 'zustand';
import {apiFetch, apiUrl, isTronNetwork, publicClientFor, type Network} from '@/core/chain';
import type {Position} from './positions';

type Totals = {staked: bigint; unstaked: bigint};
/**
 * Keyed by `${protocol}:${asset}` (lowercased), matching the server's byProtocol keys.
 *
 * `staked` / `unstaked` are the generic in / out totals: for a lending position they hold what the
 * supply ledger calls supplied and withdrawn.
 */
export type FlowMap = Map<string, Totals>;
export type Flows = {stake: FlowMap; supply: FlowMap};

/** Tolerant BigInt: a missing or malformed total counts as zero rather than losing the whole map. */
const big = (v: unknown): bigint => {
  try {
    return typeof v === 'string' || typeof v === 'number' ? BigInt(v) : BigInt(0);
  } catch {
    return BigInt(0);
  }
};

/**
 * One flow ledger.
 *
 * The two endpoints name their totals differently — stake-flows answers `staked`/`unstaked`, and
 * supply-flows answers `supplied`/`withdrawn` — so both spellings are read here. Taking only the
 * staking pair meant every supply row parsed as BigInt(undefined), which threw, and the catch below
 * turned that into an empty map. Flexible Lend therefore never showed what it had earned, silently
 * and on every vault.
 */
async function fetchOne(path: string, vault: string, network: Network): Promise<FlowMap> {
  const m: FlowMap = new Map();
  try {
    const res = await apiFetch(apiUrl(`${path}?vault=${vault}`, network));
    if (!res.ok) return m;
    const j = (await res.json()) as {
      data?: {
        byProtocol?: Record<
          string,
          {staked?: string; unstaked?: string; supplied?: string; withdrawn?: string}
        >;
      };
    };
    for (const [k, v] of Object.entries(j?.data?.byProtocol ?? {})) {
      m.set(k.toLowerCase(), {staked: big(v.staked ?? v.supplied), unstaked: big(v.unstaked ?? v.withdrawn)});
    }
  } catch {
    /* empty on failure — earned just won't show */
  }
  return m;
}

export async function fetchFlows(vault: string, network: Network): Promise<Flows> {
  // The server keeps no Tron ledger (it indexes no Tron vault), and TRON Stake earns no yield to
  // measure against one.
  if (isTronNetwork(network)) return {stake: new Map(), supply: new Map()};
  const [stake, supply] = await Promise.all([
    fetchOne('/api/ethereum/vaults/stake-flows', vault, network),
    fetchOne('/api/ethereum/vaults/supply-flows', vault, network),
  ]);
  return {stake, supply};
}

/**
 * Earned above this share of the recorded principal is not yield, it is a hole in the ledger.
 *
 * The ledger is written by whichever client sent the deposit, so anything that never reported one
 * leaves the principal understated and the difference then reads as profit. A measured case: a Base
 * vault supplied 40 USDC to Aave with only 10 of it recorded, which would have shown "+30.00
 * earned" on a position that had actually made a seventh of a cent. These routes pay single-digit
 * percent, so a fifth of principal is years of yield and is far likelier to be a missing deposit.
 * Failing closed costs a real earner nothing but a hidden line; failing open prints a fiction.
 */
const MAX_PLAUSIBLE_EARNED_BPS = BigInt(2000); // 20% of principal
const BPS = BigInt(10000);

/**
 * Earned for a position in its asset's raw units, or null when there's nothing (positive) to show.
 *
 * A position withdrawn in full still earned what it earned: pass it with `raw` 0 (see
 * {closedPosition}) and the figure is what came out less what went in.
 */
export function earnedRaw(pos: Pick<Position, 'protocol' | 'asset' | 'kind' | 'raw'>, flows: Flows): bigint | null {
  const map = pos.kind === 'staked' ? flows.stake : flows.supply;
  const t = map.get(`${pos.protocol.toLowerCase()}:${pos.asset.toLowerCase()}`);
  if (!t) return null;
  const earned = pos.raw + t.unstaked - t.staked;
  if (earned <= BigInt(0)) return null;
  if (t.staked <= BigInt(0)) return null; // nothing recorded going in: no basis to call this yield
  // Measured against what is still in, or — once more has come out than went in, as it does when
  // a position is withdrawn with its yield — against everything that went in.
  const principal = t.staked - t.unstaked;
  const basis = principal > BigInt(0) ? principal : t.staked;
  if (earned * BPS > basis * MAX_PLAUSIBLE_EARNED_BPS) return null;
  return earned;
}

/** A route the vault no longer holds anything in, as {earnedRaw} takes it. */
export const closedPosition = (protocol: string, asset: string, kind: Position['kind']) =>
  ({protocol: protocol as Position['protocol'], asset: asset as Position['asset'], kind, raw: BigInt(0)});

/**
 * Moves this device has sent that the server's ledger may not hold yet, by tx hash.
 *
 * The server records a move only once it can read the transaction on chain, and the app reports it
 * the moment it is SENT — so that first report was refused, the row arrived only when the history
 * index caught up, and meanwhile the position (re-read on confirmation) was measured against the
 * principal from before the deposit: the deposit itself showed as earned. Held here, the move counts
 * in the principal from the moment it is sent. `recordedAt` is when the server accepted it; a ledger
 * read that starts after that already holds it, and useFlows drops it then.
 */
export type PendingFlow = {
  network: Network;
  vault: string;
  kind: 'stake' | 'supply';
  /** `${protocol}:${asset}`, lowercased, as {FlowMap} is keyed. */
  key: string;
  direction: 'in' | 'out';
  amount: bigint;
  sentAt: number;
  recordedAt?: number;
};
/** `accepted` counts the server's acceptances, only ever up: each is a cue to read the ledger again. */
export const usePendingFlows = create<{byTx: Record<string, PendingFlow[]>; accepted: number}>(() => ({byTx: {}, accepted: 0}));
/** One the server never accepted stops counting after this: the history index has it by then. */
const PENDING_FLOW_TTL_MS = 30 * 60_000;
const RECORD_TRIES = 5;
const RECORD_RETRY_MS = 3_000;

const setPending = (txHash: string, f: (rows: PendingFlow[]) => PendingFlow[]) =>
  usePendingFlows.setState((s) => {
    const rows = f(s.byTx[txHash] ?? []);
    const byTx = {...s.byTx};
    if (rows.length) byTx[txHash] = rows;
    else delete byTx[txHash];
    return {byTx};
  });

/** `server` with this vault's moves the server does not hold yet added in. See {usePendingFlows}. */
export function withPendingFlows(server: Flows, vault: string, network: Network, readFrom: number): Flows {
  const out: Flows = {stake: new Map(server.stake), supply: new Map(server.supply)};
  const now = Date.now();
  for (const rows of Object.values(usePendingFlows.getState().byTx)) {
    for (const r of rows) {
      if (r.network !== network || r.vault !== vault.toLowerCase()) continue;
      if (r.recordedAt != null && r.recordedAt <= readFrom) continue;
      if (r.recordedAt == null && now - r.sentAt > PENDING_FLOW_TTL_MS) continue;
      const map = r.kind === 'stake' ? out.stake : out.supply;
      const t = map.get(r.key) ?? {staked: BigInt(0), unstaked: BigInt(0)};
      map.set(r.key, r.direction === 'in' ? {...t, staked: t.staked + r.amount} : {...t, unstaked: t.unstaked + r.amount});
    }
  }
  return out;
}

/** Forget the moves a ledger read that started at `readFrom` already holds. */
export function prunePendingFlows(readFrom: number): void {
  const now = Date.now();
  for (const [tx, rows] of Object.entries(usePendingFlows.getState().byTx)) {
    if (rows.some((r) => (r.recordedAt != null && r.recordedAt <= readFrom) || (r.recordedAt == null && now - r.sentAt > PENDING_FLOW_TTL_MS))) {
      setPending(tx, (rs) => rs.filter((r) => !((r.recordedAt != null && r.recordedAt <= readFrom) || (r.recordedAt == null && now - r.sentAt > PENDING_FLOW_TTL_MS))));
    }
  }
}

/**
 * Tell the server about a deposit or withdrawal, so `earned` has a principal to measure against.
 *
 * The vault contract emits no Supply/Stake events, so these ledgers are written by the client that
 * sent the transaction and by nothing else. The app read them from the start but never wrote to
 * them, so every deposit made from the phone was invisible and the principal drifted further below
 * the position with each one. Best-effort on purpose: a failed write must not fail the deposit, and
 * the POST is idempotent per (tx, direction, asset), so a retry cannot double-count.
 */
export async function recordFlow(o: {
  vault: string;
  network: Network;
  protocol: string;
  asset: string;
  kind: 'stake' | 'supply';
  direction: 'in' | 'out';
  /** Raw units, as sent on chain. */
  amount: bigint;
  txHash: string;
}): Promise<void> {
  if (o.amount <= BigInt(0) || isTronNetwork(o.network)) return;
  const txHash = o.txHash.toLowerCase();
  const row: PendingFlow = {
    network: o.network,
    vault: o.vault.toLowerCase(),
    kind: o.kind,
    key: `${o.protocol.toLowerCase()}:${o.asset.toLowerCase()}`,
    direction: o.direction,
    amount: o.amount,
    sentAt: Date.now(),
  };
  setPending(txHash, (rows) => [...rows, row]);
  const path = o.kind === 'stake' ? '/api/ethereum/vaults/stake-flows' : '/api/ethereum/vaults/supply-flows';
  // Each endpoint names its own directions; sending the other's is rejected as an invalid payload.
  const direction =
    o.kind === 'stake' ? (o.direction === 'in' ? 'stake' : 'unstake') : o.direction === 'in' ? 'supply' : 'withdraw';
  // The server reads the move off the chain, so it can only take it once the transaction is mined.
  try {
    const receipt = await publicClientFor(o.network).waitForTransactionReceipt({hash: o.txHash as `0x${string}`, timeout: 180_000});
    if (receipt.status !== 'success') {
      setPending(txHash, (rows) => rows.filter((r) => r !== row));
      return;
    }
  } catch {
    return; // Not seen mined in time: the row stays until its TTL, as the index will hold it by then.
  }
  for (let i = 0; i < RECORD_TRIES; i++) {
    try {
      // The network tag matters on the WRITE as much as the read: without it the row lands under the
      // server's default chain and the position's own chain never sees it.
      const res = await fetch(apiUrl(path, o.network), {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          vault: o.vault,
          protocol: o.protocol,
          asset: o.asset,
          direction,
          amount: o.amount.toString(),
          txHash: o.txHash,
        }),
      });
      // 202: the server's node has not seen the transaction yet.
      if (res.status === 200) {
        const at = Date.now();
        setPending(txHash, (rows) => rows.map((r) => (r === row ? {...r, recordedAt: at} : r)));
        usePendingFlows.setState((s) => ({accepted: s.accepted + 1}));
        return;
      }
    } catch {
      /* best-effort ledger write: tried again below */
    }
    await new Promise((r) => setTimeout(r, RECORD_RETRY_MS));
  }
}

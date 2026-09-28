/**
 * Transaction history — the durable, server-indexed transfers feed (`/transfers/{vault}`), grouped by
 * tx into operations. The heavy indexing lives on the server; the app just groups + renders.
 */
import {apiUrl, type Network} from '@/core/chain';
import {fetchSettlements, type SettlementMeta} from './limit';

export type TransferRow = {
  txHash: string;
  direction: 'out' | 'in';
  counterparty: string | null;
  amount: string | null;
  assetSymbol: string | null;
  assetAddress: string | null;
  category: string;
  blockNum: number;
  timestamp: string | null;
};

export type VaultAction = {name: string; args: Record<string, string | string[]>};

export type Operation = {
  txHash: string;
  timestamp: string | null;
  blockNum: number;
  legs: TransferRow[];
  // What the transaction's calldata did, decoded server-side. Empty until the server has seen it.
  actions: VaultAction[];
  // Set when this transaction is a CoW settlement that filled one of the vault's orders.
  settlement?: SettlementMeta;
};

/** Fetch the vault's history, grouped by tx (rows arrive newest-first). */
export async function fetchTransactions(
  vault: string,
  network: Network,
): Promise<Operation[]> {
  const [res, settlements] = await Promise.all([
    fetch(apiUrl(`/api/ethereum/vaults/transfers/${vault}`, network)),
    fetchSettlements(vault as `0x${string}`, network),
  ]);
  if (!res.ok) throw new Error(`transfers ${res.status}`);
  const json = (await res.json()) as {data?: TransferRow[]; actions?: Record<string, VaultAction[]>};
  const rows = json.data ?? [];
  const actions = json.actions ?? {};

  const order: string[] = [];
  const map = new Map<string, Operation>();
  for (const r of rows) {
    let op = map.get(r.txHash);
    if (!op) {
      op = {txHash: r.txHash, timestamp: r.timestamp, blockNum: r.blockNum, legs: [], actions: actions[r.txHash.toLowerCase()] ?? actions[r.txHash] ?? [], settlement: settlements.get(r.txHash.toLowerCase())};
      map.set(r.txHash, op);
      order.push(r.txHash);
    }
    op.legs.push(r);
  }
  return order.map((h) => map.get(h)!);
}

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
  /**
   * Wei of gas the vault's OWNER paid for this one — set when the owner wallet sent it itself
   * rather than through the relayer, whose fee is a leg instead. From the server, which reads it
   * off the receipt.
   */
  ownerFee?: bigint;
  /** Who signed it: the relay request's signer, or a direct sender. From the server; lowercase. */
  signer?: string;
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
  const json = (await res.json()) as {
    data?: TransferRow[];
    actions?: Record<string, VaultAction[]>;
    /** The vault's transactions that moved no token — a settings change the owner paid for. */
    txs?: {txHash: string; blockNum: number; timestamp: string | null}[];
    ownerFees?: Record<string, string>;
    signers?: Record<string, string>;
  };
  const rows = json.data ?? [];
  const actions = json.actions ?? {};
  const ownerFees = json.ownerFees ?? {};
  const fee = (h: string) => {
    const v = ownerFees[h.toLowerCase()] ?? ownerFees[h];
    return v ? BigInt(v) : undefined;
  };
  const signers = json.signers ?? {};
  const signer = (h: string) => (signers[h.toLowerCase()] ?? signers[h])?.toLowerCase();

  const order: string[] = [];
  const map = new Map<string, Operation>();
  for (const r of rows) {
    let op = map.get(r.txHash);
    if (!op) {
      op = {txHash: r.txHash, timestamp: r.timestamp, blockNum: r.blockNum, legs: [], actions: actions[r.txHash.toLowerCase()] ?? actions[r.txHash] ?? [], settlement: settlements.get(r.txHash.toLowerCase()), ownerFee: fee(r.txHash), signer: signer(r.txHash)};
      map.set(r.txHash, op);
      order.push(r.txHash);
    }
    op.legs.push(r);
  }
  // A transaction with no legs is named by its call alone, as a fee-only row always was.
  for (const x of json.txs ?? []) {
    if (map.has(x.txHash)) continue;
    map.set(x.txHash, {txHash: x.txHash, timestamp: x.timestamp, blockNum: x.blockNum, legs: [], actions: actions[x.txHash.toLowerCase()] ?? actions[x.txHash] ?? [], ownerFee: fee(x.txHash), signer: signer(x.txHash)});
    order.push(x.txHash);
  }
  // Newest first across both: the legless ones arrive as their own list.
  return order.map((h) => map.get(h)!).sort((a, b) => b.blockNum - a.blockNum);
}

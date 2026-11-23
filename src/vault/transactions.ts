/**
 * Transaction history — the durable, server-indexed transfers feed (`/transfers/{vault}`), grouped by
 * tx into operations. The heavy indexing lives on the server; the app just groups + renders.
 */
import {formatUnits} from 'viem';
import {apiFetch, apiUrl, isTronNetwork, type Network} from '@/core/chain';
import {knownAssets} from '@/core/assets';
import {TRON_API, type TronChain} from '@/tron/config';
import {evmToTron, tronToEvm} from '@/tron/address';
import {fetchSettlements, type SettlementMeta} from './limit';
import {vaultActionsFor} from './decode-actions';
import {bridgeHistory, bridgeTxKey} from './bridge';

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
  /** An Across delivery into the vault: the network it was bridged from. See vault/bridge. */
  bridgedFrom?: Network;
  /** An Across deposit the vault made: the network it went to. See vault/bridge. */
  bridgedTo?: Network;
};

/** Fetch the vault's history, grouped by tx (rows arrive newest-first). */
export async function fetchTransactions(
  vault: string,
  network: Network,
): Promise<Operation[]> {
  if (isTronNetwork(network)) return fetchTronTransactions(vault, network);
  const [res, settlements, arrivals] = await Promise.all([
    fetch(apiUrl(`/api/ethereum/vaults/transfers/${vault}`, network)),
    fetchSettlements(vault as `0x${string}`, network),
    bridgeHistory(vault, network),
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
  /**
   * An Across delivery Bitty's server has not indexed yet (its feed can trail the chain by hours on
   * a busy network): drawn from Across's own record of it — the coin and amount it paid the vault —
   * so a bridge in shows on arrival. Only coins the app lists; the server's row replaces it once in.
   */
  const listed = new Map(knownAssets(network).map((a) => [a.address.toLowerCase(), a]));
  const have = new Set([...map.keys()].map(bridgeTxKey));
  for (const a of arrivals.arrivalRows) {
    const asset = listed.get(a.token.toLowerCase());
    if (!asset || have.has(bridgeTxKey(a.txHash))) continue;
    const leg: TransferRow = {
      txHash: a.txHash,
      direction: 'in',
      counterparty: null,
      amount: formatUnits(BigInt(a.amount), asset.decimals),
      assetSymbol: asset.symbol,
      assetAddress: asset.address,
      category: 'erc20',
      blockNum: a.blockNum,
      timestamp: a.timestamp,
    };
    map.set(a.txHash, {txHash: a.txHash, timestamp: a.timestamp, blockNum: a.blockNum, legs: [leg], actions: []});
    order.push(a.txHash);
    have.add(a.txHash.toLowerCase());
  }
  // Across's deliveries into the vault are named as bridges, not as payments received.
  for (const op of map.values()) {
    op.bridgedFrom = arrivals.arrivals.get(bridgeTxKey(op.txHash));
    op.bridgedTo = arrivals.departures.get(bridgeTxKey(op.txHash));
    if (!ownsCall(op)) op.actions = [];
  }
  // Newest first across both: the legless ones arrive as their own list.
  return order.map((h) => map.get(h)!).sort((a, b) => b.blockNum - a.blockNum);
}

/** Calls that bring tokens in and send nothing out of the vault: a claim from a withdrawal queue. */
const RECEIVE_ONLY_CALLS = new Set(['claimWithdrawal', 'claimWithdrawals']);

/**
 * Whether the decoded calls are this vault's own. The server decodes a transaction's calldata by
 * hash alone, so a vault that was only PAID in someone else's transaction gets that transaction's
 * calls too: the fee vault, paid a relay or adapter fee by every other vault's trade, deposit or
 * supply, read as having made each of them. A vault's own call almost always moves something out
 * of it (the relay fee at least, or the token it trades, deposits or burns); one that only received
 * owns the calls only when they are a claim.
 */
function ownsCall(op: Operation): boolean {
  if (op.legs.length === 0 || op.legs.some((l) => l.direction === 'out')) return true;
  return op.actions.every((a) => RECEIVE_ONLY_CALLS.has(a.name));
}

/**
 * GET from TronGrid, waiting out a rate limit rather than failing on it.
 *
 * Only TronGrid serves its `/v1` index (Alchemy and PublicNode answer 404 for it, checked
 * 2026-11-23), so there is no other host to fall through to. Unkeyed, it refuses a burst with 429 —
 * and the app's balance, price and gas reads go to the same host at the same moment the Activity
 * tab opens — which came back to the user as "transfers 429" over a history that loads a second
 * later. Four tries, 1s, 2s and 4s apart, honouring a Retry-After when TronGrid sends one.
 */
async function tronGridGet(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await apiFetch(url);
    if (res.status !== 429 || attempt === 3) return res;
    const after = Number(res.headers.get('retry-after'));
    const waitMs = after > 0 && after <= 10 ? after * 1000 : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

type V1Trc20 ={transaction_id: string; block_timestamp: number; from: string; to: string; value: string; type?: string; token_info?: {address?: string}};

/**
 * The vault's history on Tron, which the Bitty server does not index: TronGrid's own index of the
 * TRC-20 transfers in and out of the vault's address, one leg per transfer, grouped by transaction
 * as the server's feed is.
 *
 * Only the tokens the guard lists (the app's assets for the network): anyone can send any TRC-20 to
 * any address, and the junk airdropped to look like a payment is not the vault's history. What each
 * transaction CALLED is decoded here from its calldata (see ./decode-actions), as the server does for
 * the EVM chains — else the activation and an added payee, which move only the relay fee, read as a
 * send. What it still cannot show: a change that moved no token at all (one the owner paid in TRX).
 */
async function fetchTronTransactions(vault: string, network: TronChain): Promise<Operation[]> {
  const host = TRON_API[network];
  const tokens = new Map(knownAssets(network).map((a) => [a.address.toLowerCase(), a]));
  // Across's own record beside it, as on the EVM chains: what names a deposit to another network,
  // and a delivery from one, as a bridge rather than a send or a payment received.
  const [res, bridges] = await Promise.all([
    tronGridGet(`${host}/v1/accounts/${evmToTron(vault)}/transactions/trc20?limit=50`),
    bridgeHistory(vault, network),
  ]);
  if (!res.ok) throw new Error(`transfers ${res.status}`);
  const json = (await res.json()) as {data?: V1Trc20[]};
  const me = vault.toLowerCase();
  const map = new Map<string, Operation>();
  for (const x of json.data ?? []) {
    // The feed carries Approval events beside the transfers, as rows of the same shape: an approval
    // to the bridge read as a second "-20 USDT" next to the 20 USDT actually sent. Only a Transfer
    // moves money.
    if (x.type && x.type !== 'Transfer') continue;
    const token = tronToEvm(x.token_info?.address ?? '');
    const asset = token ? tokens.get(token.toLowerCase()) : undefined;
    if (!asset) continue;
    const from = tronToEvm(x.from)?.toLowerCase();
    const to = tronToEvm(x.to)?.toLowerCase();
    const out = from === me;
    if (!out && to !== me) continue;
    const hash = `0x${x.transaction_id}`;
    let op = map.get(hash);
    if (!op) {
      // No block number in this feed; the timestamp orders the rows just as well.
      op = {txHash: hash, timestamp: new Date(x.block_timestamp).toISOString(), blockNum: x.block_timestamp, legs: [], actions: []};
      map.set(hash, op);
    }
    op.legs.push({
      txHash: hash,
      direction: out ? 'out' : 'in',
      counterparty: (out ? to : from) ?? null,
      amount: formatUnits(BigInt(x.value), asset.decimals),
      assetSymbol: asset.symbol,
      assetAddress: asset.address,
      category: 'erc20',
      blockNum: x.block_timestamp,
      timestamp: op.timestamp,
    });
  }
  const ops = [...map.values()];
  // Best effort: a row whose calldata cannot be read yet is still shown by its transfers.
  const actions = await vaultActionsFor(ops.map((o) => o.txHash), vault, network).catch(() => new Map<string, VaultAction[]>());
  for (const op of ops) {
    op.actions = actions.get(op.txHash) ?? [];
    op.bridgedFrom = bridges.arrivals.get(bridgeTxKey(op.txHash));
    op.bridgedTo = bridges.departures.get(bridgeTxKey(op.txHash));
  }
  return ops.sort((a, b) => b.blockNum - a.blockNum);
}

/**
 * Transaction history — the durable, server-indexed transfers feed (`/transfers/{vault}`), grouped by
 * tx into operations. The heavy indexing lives on the server; the app just groups + renders.
 */
import {formatUnits, getAddress, parseAbiItem, type Address} from 'viem';
import {apiFetch, apiUrl, isTronNetwork, publicClientFor, type Network} from '@/core/chain';
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

/**
 * Fetch the account's history, grouped by tx (rows arrive newest-first): the vault's, or in wallet
 * mode (core/account-mode) the wallet's.
 */
export async function fetchTransactions(
  vault: string,
  network: Network,
  kind: 'vault' | 'wallet' = 'vault',
): Promise<Operation[]> {
  if (isTronNetwork(network)) return fetchTronTransactions(vault, network, kind === 'wallet');
  if (kind === 'wallet') return fetchWalletTransactions(vault, network);
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
  /**
   * The same for a bridge out: the vault's Across deposit, drawn from Across's record until the
   * server has indexed the transaction (minutes behind on BNB Chain), so a bridge just sent shows
   * at once. What crossed, as Across has it (Bitty's fee already off); the server's row replaces it.
   */
  for (const d of arrivals.departureRows) {
    const asset = listed.get(d.token.toLowerCase());
    if (!asset || have.has(bridgeTxKey(d.txHash))) continue;
    const leg: TransferRow = {
      txHash: d.txHash,
      direction: 'out',
      counterparty: d.recipient,
      amount: formatUnits(BigInt(d.amount), asset.decimals),
      assetSymbol: asset.symbol,
      assetAddress: asset.address,
      category: 'erc20',
      blockNum: d.blockNum,
      timestamp: d.timestamp,
    };
    map.set(d.txHash, {txHash: d.txHash, timestamp: d.timestamp, blockNum: d.blockNum, legs: [leg], actions: []});
    order.push(d.txHash);
    have.add(bridgeTxKey(d.txHash));
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
export async function tronGridGet(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await apiFetch(url);
    // TronGrid throttles an unkeyed caller with 429, and past that suspends the address for a while
    // with 403 ("… suspended for 30s"): both are waited out, not shown as an error.
    if ((res.status !== 429 && res.status !== 403) || attempt === 3) return res;
    const after = Number(res.headers.get('retry-after'));
    const said = res.status === 403 ? Number(/suspended for (\d+)\s*s/i.exec(await res.clone().text().catch(() => ''))?.[1]) : NaN;
    const waitMs = after > 0 && after <= 10 ? after * 1000 : said > 0 ? Math.min(said, 10) * 1000 : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** TronGrid still refusing after the retries: busy, not broken, and said so in words. */
export class TronHistoryBusy extends Error {}

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
async function fetchTronTransactions(vault: string, network: TronChain, wallet = false): Promise<Operation[]> {
  const host = TRON_API[network];
  const tokens = new Map(knownAssets(network).map((a) => [a.address.toLowerCase(), a]));
  // Across's own record beside it, as on the EVM chains: what names a deposit to another network,
  // and a delivery from one, as a bridge rather than a send or a payment received. A wallet's TRX
  // transfers too, which move no token and so are not in the TRC-20 feed; a vault holds no TRX.
  const [res, bridges, trx] = await Promise.all([
    tronGridGet(`${host}/v1/accounts/${evmToTron(vault)}/transactions/trc20?limit=50`),
    bridgeHistory(vault, network),
    wallet ? tronTrxTransfers(host, vault, network) : Promise.resolve({ops: [] as Operation[], fees: new Map<string, bigint>()}),
  ]);
  if (res.status === 403 || res.status === 429) throw new TronHistoryBusy(`transfers ${res.status}`);
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
  // A TRX transfer's row, or the same transaction's token row with the TRX leg's actions merged in.
  for (const op of trx.ops) {
    const have = map.get(op.txHash);
    if (!have) map.set(op.txHash, op);
    else if (op.actions.length) have.actions = [...have.actions, ...op.actions];
  }
  const ops = [...map.values()];
  // What the wallet burned in TRX for each transaction it sent: shown as the row's network fee.
  for (const op of ops) {
    const f = trx.fees.get(op.txHash);
    if (f) op.ownerFee = f;
  }
  // Best effort: a row whose calldata cannot be read yet is still shown by its transfers. A wallet
  // makes no vault calls, so there is nothing to decode.
  const actions = wallet
    ? new Map<string, VaultAction[]>()
    : await vaultActionsFor(ops.map((o) => o.txHash), vault, network).catch(() => new Map<string, VaultAction[]>());
  for (const op of ops) {
    op.actions = actions.get(op.txHash) ?? (op.actions.length ? op.actions : []);
    op.bridgedFrom = bridges.arrivals.get(bridgeTxKey(op.txHash));
    op.bridgedTo = bridges.departures.get(bridgeTxKey(op.txHash));
  }
  return ops.sort((a, b) => b.blockNum - a.blockNum);
}

type V1Tx = {
  txID: string;
  block_timestamp: number;
  blockNumber?: number;
  ret?: {contractRet?: string; fee?: number}[];
  raw_data?: {
    contract?: {type: string; parameter?: {value?: {amount?: number; owner_address?: string; to_address?: string; contract_address?: string; data?: string}}}[];
  };
};

/**
 * A Tron wallet's own transactions from TronGrid's index of the address:
 *
 *   - its TRX transfers (TransferContract), the chain's coin moving, which the TRC-20 feed never
 *     shows — one leg each, in WTRX's row, as the app shows TRX everywhere (core/format `displaySymbol`);
 *   - the TRX each transaction it sent burned (energy and bandwidth), by hash, for the row's fee.
 */
async function tronTrxTransfers(host: string, address: string, network: TronChain): Promise<{ops: Operation[]; fees: Map<string, bigint>}> {
  const {NATIVE} = require('@/core/chain') as typeof import('@/core/chain');
  const {fromTronHex} = require('@/tron/address') as typeof import('@/tron/address');
  const wrapped = knownAssets(network).find((a) => a.symbol === NATIVE[network].wrapped);
  const fees = new Map<string, bigint>();
  const res = await tronGridGet(`${host}/v1/accounts/${evmToTron(address)}/transactions?limit=50&only_confirmed=true`);
  if (!res.ok) return {ops: [], fees};
  const json = (await res.json()) as {data?: V1Tx[]};
  const me = address.toLowerCase();
  const ops: Operation[] = [];
  for (const x of json.data ?? []) {
    const c = x.raw_data?.contract?.[0];
    const v = c?.parameter?.value;
    if (!v?.owner_address) continue;
    const from = tronToEvm(fromTronHex(v.owner_address))?.toLowerCase();
    const hash = `0x${x.txID}`;
    const timestamp = new Date(x.block_timestamp).toISOString();
    const fee = x.ret?.[0]?.fee;
    if (from === me && fee) fees.set(hash, BigInt(fee));
    if (x.ret?.[0]?.contractRet && x.ret[0].contractRet !== 'SUCCESS') continue;
    if (c?.type !== 'TransferContract' || !v.amount || !v.to_address) continue;
    const to = tronToEvm(fromTronHex(v.to_address))?.toLowerCase();
    const out = from === me;
    if (!out && to !== me) continue;
    ops.push({
      txHash: hash,
      timestamp,
      blockNum: x.block_timestamp,
      actions: [],
      legs: [
        {
          txHash: hash,
          direction: out ? 'out' : 'in',
          counterparty: (out ? to : from) ?? null,
          amount: formatUnits(BigInt(v.amount), NATIVE[network].decimals),
          assetSymbol: NATIVE[network].wrapped,
          assetAddress: wrapped?.address ?? null,
          category: 'external',
          blockNum: x.block_timestamp,
          timestamp,
        },
      ],
    });
  }
  return {ops, fees};
}

/**
 * Blockscout's public explorers, by network: an etherscan-style API with no key, for the history
 * of any address. Base's and Arbitrum's sit behind a bot check that may turn the app away (seen
 * 2026-11-23); then, and on BSC and Robinhood Chain, which have none, the history is read from the
 * chain itself (see {walletFromLogs}).
 */
const BLOCKSCOUT: Partial<Record<Network, string>> = {
  mainnet: 'https://eth.blockscout.com',
  base: 'https://base.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  sepolia: 'https://eth-sepolia.blockscout.com',
  'base-sepolia': 'https://base-sepolia.blockscout.com',
};

type ExplorerRow = {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError?: string;
  contractAddress?: string;
};

async function explorerList(host: string, action: 'txlist' | 'txlistinternal' | 'tokentx', address: string): Promise<ExplorerRow[]> {
  const res = await apiFetch(`${host}/api?module=account&action=${action}&address=${address}&sort=desc&page=1&offset=100`);
  if (!res.ok) throw new Error(`transfers ${res.status}`);
  const json = (await res.json()) as {result?: ExplorerRow[] | string};
  return Array.isArray(json.result) ? json.result : [];
}

/**
 * An EVM wallet's history, read from the chain's Blockscout explorer: the coin moving (sent by the
 * wallet, or paid to it by a contract — a bridge delivery, a withdrawal) and the tokens the app
 * lists. Anything can be sent to an address, and airdropped junk is not the wallet's history.
 * Native ETH goes in WETH's row, as the app shows it everywhere.
 */
async function fetchWalletTransactions(address: string, network: Network): Promise<Operation[]> {
  const {NATIVE} = require('@/core/chain') as typeof import('@/core/chain');
  const {currentCatalog} = require('@/core/asset-catalog') as typeof import('@/core/asset-catalog');
  const host = BLOCKSCOUT[network];
  const bridgesP = bridgeHistory(address, network);
  const explorer = host
    ? await Promise.all([
        explorerList(host, 'txlist', address),
        explorerList(host, 'txlistinternal', address).catch(() => [] as ExplorerRow[]),
        explorerList(host, 'tokentx', address),
      ]).catch(() => null)
    : null;
  const bridges = await bridgesP;
  if (!explorer) return walletFromLogs(address, network, bridges);
  const [txs, internal, tokens] = explorer;
  const listed = new Map([...knownAssets(network), ...currentCatalog(network)].map((a) => [a.address.toLowerCase(), a]));
  const wrapped = [...listed.values()].find((a) => a.symbol === NATIVE[network].wrapped);
  const me = address.toLowerCase();
  const map = new Map<string, Operation>();
  const push = (x: ExplorerRow, symbol: string, assetAddress: string | null, decimals: number, category: string) => {
    const out = x.from.toLowerCase() === me;
    if (!out && x.to?.toLowerCase() !== me) return;
    const blockNum = Number(x.blockNumber);
    const timestamp = new Date(Number(x.timeStamp) * 1000).toISOString();
    let op = map.get(x.hash);
    if (!op) {
      op = {txHash: x.hash, timestamp, blockNum, legs: [], actions: []};
      map.set(x.hash, op);
    }
    op.legs.push({
      txHash: x.hash,
      direction: out ? 'out' : 'in',
      counterparty: (out ? x.to : x.from)?.toLowerCase() ?? null,
      amount: formatUnits(BigInt(x.value), decimals),
      assetSymbol: symbol,
      assetAddress,
      category,
      blockNum,
      timestamp,
    });
  };
  for (const x of [...txs, ...internal]) {
    if (x.isError === '1' || !x.value || x.value === '0') continue;
    push(x, NATIVE[network].wrapped, wrapped?.address ?? null, NATIVE[network].decimals, 'external');
  }
  for (const x of tokens) {
    const asset = x.contractAddress ? listed.get(x.contractAddress.toLowerCase()) : undefined;
    if (!asset || !x.value || x.value === '0') continue;
    push(x, asset.symbol, asset.address, asset.decimals, 'erc20');
  }
  for (const op of map.values()) {
    op.bridgedFrom = bridges.arrivals.get(bridgeTxKey(op.txHash));
    op.bridgedTo = bridges.departures.get(bridgeTxKey(op.txHash));
  }
  return [...map.values()].sort((a, b) => b.blockNum - a.blockNum);
}

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * The wallet's Transfer logs, in as many recent blocks as the node will scan in one request: the
 * free nodes cap a getLogs range (10,000 blocks on many, 50,000 on some), so the widest is asked
 * first and narrowed on refusal.
 */
async function recentTransfers(network: Network, args: {from: Address} | {to: Address}) {
  const client = publicClientFor(network);
  const head = await client.getBlockNumber();
  for (const span of [BigInt(50_000), BigInt(10_000), BigInt(2_000), BigInt(500)]) {
    try {
      return await client.getLogs({event: TRANSFER_EVENT, args, fromBlock: head > span ? head - span : BigInt(0), toBlock: head});
    } catch {
      // Range refused: try a narrower one.
    }
  }
  return [];
}

/**
 * A wallet's history where no index will serve it: read from the chain, with no key and no server.
 *
 * Tokens: the Transfer logs to and from the address in the recent blocks the node will scan,
 * kept to the tokens the app lists. The coin itself (ETH, BNB) leaves no log, so a send of it made
 * from this phone comes from the phone's own record (wallet/sent-log); one received from elsewhere
 * is not seen. Ordered by time — the record has no block — so `blockNum` holds milliseconds, as on
 * Tron.
 */
async function walletFromLogs(address: string, network: Network, bridges: Awaited<ReturnType<typeof bridgeHistory>>): Promise<Operation[]> {
  const {NATIVE, publicClientFor: clientFor} = require('@/core/chain') as typeof import('@/core/chain');
  const {currentCatalog} = require('@/core/asset-catalog') as typeof import('@/core/asset-catalog');
  const {sentFrom} = require('@/wallet/sent-log') as typeof import('@/wallet/sent-log');
  const me = getAddress(address);
  const listed = new Map([...knownAssets(network), ...currentCatalog(network)].map((a) => [a.address.toLowerCase(), a]));
  const [out, inn] = await Promise.all([recentTransfers(network, {from: me}).catch(() => []), recentTransfers(network, {to: me}).catch(() => [])]);
  const logs = [...out, ...inn].filter((l) => listed.has(l.address.toLowerCase()));

  // A timestamp for each block a row is in: the newest few dozen, which is what a page shows.
  const blocks = [...new Set(logs.map((l) => l.blockNumber!))].sort((a, b) => Number(b - a)).slice(0, 40);
  const client = clientFor(network);
  const times = new Map<bigint, number>();
  await Promise.all(
    blocks.map((n) =>
      client
        .getBlock({blockNumber: n})
        .then((b) => times.set(n, Number(b.timestamp) * 1000))
        .catch(() => {}),
    ),
  );

  const map = new Map<string, Operation>();
  const leg = (hash: string, at: number, l: Omit<TransferRow, 'txHash' | 'blockNum' | 'timestamp'>) => {
    const timestamp = new Date(at).toISOString();
    let op = map.get(hash);
    if (!op) {
      op = {txHash: hash, timestamp, blockNum: at, legs: [], actions: []};
      map.set(hash, op);
    }
    op.legs.push({...l, txHash: hash, blockNum: at, timestamp});
  };
  const seen = new Set<string>();
  for (const l of logs) {
    const at = times.get(l.blockNumber!);
    if (at == null) continue;
    const asset = listed.get(l.address.toLowerCase())!;
    const isOut = l.args.from?.toLowerCase() === me.toLowerCase();
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leg(l.transactionHash!, at, {
      direction: isOut ? 'out' : 'in',
      counterparty: (isOut ? l.args.to : l.args.from)?.toLowerCase() ?? null,
      amount: formatUnits(l.args.value ?? BigInt(0), asset.decimals),
      assetSymbol: asset.symbol,
      assetAddress: asset.address,
      category: 'erc20',
    });
  }
  // The coin sent from this phone, which no log shows; a token send it recorded is already a log.
  const wrapped = [...listed.values()].find((a) => a.symbol === NATIVE[network].wrapped);
  for (const r of sentFrom(address, network)) {
    if (r.token) {
      if (map.has(r.hash)) continue;
      const asset = listed.get(r.token.toLowerCase());
      if (!asset) continue;
      leg(r.hash, r.at, {direction: 'out', counterparty: r.to.toLowerCase(), amount: r.amount, assetSymbol: asset.symbol, assetAddress: asset.address, category: 'erc20'});
    } else {
      leg(r.hash, r.at, {direction: 'out', counterparty: r.to.toLowerCase(), amount: r.amount, assetSymbol: NATIVE[network].wrapped, assetAddress: wrapped?.address ?? null, category: 'external'});
    }
  }
  for (const op of map.values()) {
    op.bridgedFrom = bridges.arrivals.get(bridgeTxKey(op.txHash));
    op.bridgedTo = bridges.departures.get(bridgeTxKey(op.txHash));
  }
  return [...map.values()].sort((a, b) => b.blockNum - a.blockNum);
}

import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Network} from '@/core/chain';
import type {TronNet} from '@/tron/config';

/** A chain with a node list: the vault networks (Tron Nile among them), and Tron mainnet's wallet. */
export type NodeChain = Network | TronNet;

/**
 * The RPC nodes the app reads each chain from: Settings › RPC nodes.
 *
 * The built-in list is public nodes, several per network so one node rate-limiting or erroring
 * doesn't fail a read. The owner can switch any of them off and add nodes of their own (one they
 * run, or a provider they pay); their own are asked first. What reads go to is exactly the set
 * that is on — nothing falls back to a node the owner switched off, which is the point of being
 * able to switch it off. At least one node stays on per network, so the app can always read.
 *
 * Kept on this phone only (MMKV), never synced through the Bitty server: a setting the server
 * could push would let the server choose which node tells this app what the vault holds.
 */
export const BUILTIN_RPC: Record<NodeChain, string[]> = {
  // Every one answered chainId, the latest block and the guard's code when last checked (Nov 2026).
  // Dropped then for being dead: LlamaRPC (Cloudflare 525), Ankr (needs a key now), cloudflare-eth
  // (refuses eth_blockNumber), rpc.sepolia.org (times out), dRPC Sepolia (paid plan only). Not added:
  // Blast API (shutting down) and 1rpc / merkle / meowrpc (rate-limited on test).
  mainnet: ['https://ethereum-rpc.publicnode.com', 'https://gateway.tenderly.co/public/mainnet', 'https://rpc.flashbots.net', 'https://eth.drpc.org'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.gateway.tenderly.co', 'https://base.drpc.org'],
  sepolia: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co'],
  // The chain's own endpoint is the only public one; it rate-limits bursts. An owner's own node is
  // the way to a second one.
  robinhood: ['https://rpc.mainnet.chain.robinhood.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.gateway.tenderly.co', 'https://arbitrum.drpc.org'],
  // Measured Nov 2026 with 60 parallel batches: PublicNode answered all of them; BNB Chain's own
  // dataseed nodes, defibit and 1rpc a few each (rate limits). dRPC's free plan refused batches.
  bsc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://1rpc.io/bnb'],
  // Tron's own node API (java-tron's /wallet/…), not JSON-RPC. These read AND broadcast: Tron has no
  // relayer. TronGrid last: unkeyed it refuses a request that overlaps another (429). It is also the
  // only free source of the account history (/v1/…), which goes nowhere else. Not added: Tatum (5
  // requests a minute), dRPC / Ankr / 1rpc (paid only or no Tron).
  tron: ['https://tron-rpc.publicnode.com', 'https://api.tronstack.io', 'https://api.trongrid.io'],
  // Tron Nile is a vault network, so its nodes are what every vault read goes to: the node's
  // Ethereum-compatible JSON-RPC, at /jsonrpc. The same host serves java-tron's own API, which is
  // where a vault transaction is broadcast ({tronApiHost}). TronGrid is the only public Nile node
  // with JSON-RPC on (api.nileex.io answers /jsonrpc with 404, checked Nov 2026).
  'tron-nile': ['https://nile.trongrid.io/jsonrpc'],
};

/**
 * The java-tron API (`/wallet/…`) behind a Tron node's JSON-RPC URL: the same host, without the
 * `/jsonrpc` path. TronGrid, and any java-tron node behind a gateway, serves both on one host.
 */
export const tronApiHost = (jsonRpcUrl: string): string => jsonRpcUrl.replace(/\/jsonrpc\/?$/i, '');

/**
 * Tron has no chain id; its genesis block is how a node says which chain it serves. A node for
 * another chain is refused before it is saved, as an EVM node with the wrong chain id is.
 */
export const TRON_GENESIS: Record<TronNet, string> = {
  tron: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
};

type Nodes = {
  /** Built-in nodes switched off, per network. */
  off: Partial<Record<NodeChain, string[]>>;
  /** The owner's own nodes, per network, in the order added. */
  custom: Partial<Record<NodeChain, string[]>>;
};

const store = new MMKV({id: 'bitty.rpc'});
const KEY = 'nodes';

function loadNodes(): Nodes {
  try {
    const raw = store.getString(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Nodes;
      const off = p.off ?? {};
      const custom = p.custom ?? {};
      // Nile's nodes were java-tron API hosts while Nile was a wallet chain; a vault network reads
      // JSON-RPC, so those are dropped rather than asked for eth_call.
      if (off['tron-nile']) off['tron-nile'] = off['tron-nile'].filter((u) => /\/jsonrpc\/?$/i.test(u));
      if (custom['tron-nile']) custom['tron-nile'] = custom['tron-nile'].filter((u) => /\/jsonrpc\/?$/i.test(u));
      return {off, custom};
    }
  } catch {}
  return {off: {}, custom: {}};
}

type RpcState = Nodes & {
  /** Switch a built-in node on or off. Refused (false) when it is the last node on. */
  setBuiltin: (network: NodeChain, url: string, on: boolean) => boolean;
  addCustom: (network: NodeChain, url: string) => void;
  /** Refused (false) when it is the last node on. */
  removeCustom: (network: NodeChain, url: string) => boolean;
  /** Back to the built-in list, all on, no nodes of the owner's own. */
  reset: (network: NodeChain) => void;
};

const enabledIn = (s: Nodes, network: NodeChain): string[] => [
  ...(s.custom[network] ?? []),
  ...BUILTIN_RPC[network].filter((u) => !(s.off[network] ?? []).includes(u)),
];

export const useRpcNodes = create<RpcState>((set, get) => {
  const save = (next: Nodes) => {
    store.set(KEY, JSON.stringify({off: next.off, custom: next.custom}));
    set(next);
  };
  return {
    ...loadNodes(),
    setBuiltin: (network, url, on) => {
      const s = get();
      const off = s.off[network] ?? [];
      if (!on && enabledIn(s, network).length <= 1) return false;
      const nextOff = on ? off.filter((u) => u !== url) : [...off.filter((u) => u !== url), url];
      save({off: {...s.off, [network]: nextOff}, custom: s.custom});
      return true;
    },
    addCustom: (network, url) => {
      const s = get();
      const list = s.custom[network] ?? [];
      if (list.includes(url)) return;
      save({off: s.off, custom: {...s.custom, [network]: [...list, url]}});
    },
    removeCustom: (network, url) => {
      const s = get();
      if (enabledIn(s, network).length <= 1) return false;
      save({off: s.off, custom: {...s.custom, [network]: (s.custom[network] ?? []).filter((u) => u !== url)}});
      return true;
    },
    reset: (network) => {
      const s = get();
      save({off: {...s.off, [network]: []}, custom: {...s.custom, [network]: []}});
    },
  };
});

/**
 * The nodes reads go to, in order: the owner's own first, then the built-in ones still on.
 *
 * Read at the moment a client is made (every `publicClientFor` call), so a change in Settings
 * applies to the next read without a restart. Never empty in practice — the store refuses to turn
 * the last node off — but a damaged store falls back to the built-in list rather than leave the
 * app with nothing to read from.
 */
export function rpcUrlsFor(network: NodeChain): string[] {
  const urls = enabledIn(useRpcNodes.getState(), network);
  return urls.length ? urls : BUILTIN_RPC[network];
}

/** An https URL, the only kind iOS lets the app call. */
export const isRpcUrl = (url: string): boolean => /^https:\/\/[^\s/?#]+\.[^\s/?#]+(?::\d+)?(?:[/?#]\S*)?$/i.test(url);

/** The host, which is how a node is named on screen. */
export const rpcHost = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');

export type RpcProbe = {ok: true; block: bigint} | {ok: false; reason: 'unreachable' | 'wrong_chain'; chainId?: number};

/** Whether a node is on (the owner's own count as on), so a caller can respect a switch it doesn't own. */
export const isNodeOn = (network: NodeChain, url: string): boolean => enabledIn(useRpcNodes.getState(), network).includes(url);

async function rpcCall(url: string, method: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params: []}),
      signal: ctrl.signal,
    });
    const body = (await res.json()) as {result?: unknown};
    if (typeof body.result !== 'string') throw new Error('no result');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask a node which chain it serves and how far it has got. A node for another chain is refused
 * before it is saved — reads from it would describe a different vault, or none — and the block is
 * what the page shows, so a node that has fallen behind is visible as one.
 */
export async function probeRpc(url: string, chainId: number, timeoutMs = 5_000): Promise<RpcProbe> {
  try {
    const id = Number(BigInt(await rpcCall(url, 'eth_chainId', timeoutMs)));
    if (id !== chainId) return {ok: false, reason: 'wrong_chain', chainId: id};
    return {ok: true, block: BigInt(await rpcCall(url, 'eth_blockNumber', timeoutMs))};
  } catch {
    return {ok: false, reason: 'unreachable'};
  }
}

async function tronPost(url: string, path: string, body: unknown, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The Tron counterpart of {probeRpc}: the genesis block says which chain, the latest how far along. */
export async function probeTron(url: string, net: TronNet, timeoutMs = 5_000): Promise<RpcProbe> {
  try {
    const genesis = await tronPost(url, '/wallet/getblockbynum', {num: 0}, timeoutMs);
    if (typeof genesis?.blockID !== 'string') throw new Error('no block');
    if (genesis.blockID !== TRON_GENESIS[net]) return {ok: false, reason: 'wrong_chain'};
    const now = await tronPost(url, '/wallet/getnowblock', {}, timeoutMs);
    const n = now?.block_header?.raw_data?.number;
    if (typeof n !== 'number') throw new Error('no block');
    return {ok: true, block: BigInt(n)};
  } catch {
    return {ok: false, reason: 'unreachable'};
  }
}

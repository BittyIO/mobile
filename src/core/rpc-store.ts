import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Network} from '@/core/chain';

/** A chain with a node list: every vault network, Tron's among them. */
export type NodeChain = Network;

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
  // Each answered chain id 84532 when added (Nov 2026).
  'base-sepolia': ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.gateway.tenderly.co', 'https://base-sepolia.api.onfinality.io/public'],
  // The chain's own endpoint is the only public one; it rate-limits bursts. An owner's own node is
  // the way to a second one.
  robinhood: ['https://rpc.mainnet.chain.robinhood.com'],
  arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.gateway.tenderly.co', 'https://arbitrum.drpc.org'],
  // Measured Nov 2026 with 60 parallel batches: PublicNode answered all of them; BNB Chain's own
  // dataseed nodes, defibit and 1rpc a few each (rate limits). dRPC's free plan refused batches.
  bsc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://1rpc.io/bnb'],
  // Tron Nile is a vault network, so its nodes are what every vault read goes to: the node's
  // Ethereum-compatible JSON-RPC, at /jsonrpc. The same host serves java-tron's own API, which is
  // where a vault transaction is broadcast ({tronApiHost}). TronGrid is the only public Nile node
  // with JSON-RPC on (api.nileex.io answers /jsonrpc with 404, checked Nov 2026).
  'tron-nile': ['https://nile.trongrid.io/jsonrpc'],
  // Mainnet: TronGrid and PublicNode, the two public nodes found serving JSON-RPC and java-tron's
  // API on one host (checked 2026-11-22; dRPC, Ankr and TronStack serve no /jsonrpc). TronGrid
  // unkeyed rate-limits bursts (429), so PublicNode is the second node rather than a spare.
  tron: ['https://api.trongrid.io/jsonrpc', 'https://tron-rpc.publicnode.com/jsonrpc'],
};

/**
 * The java-tron API (`/wallet/…`) behind a Tron node's JSON-RPC URL: the same host, without the
 * `/jsonrpc` path. TronGrid, and any java-tron node behind a gateway, serves both on one host.
 */
export const tronApiHost = (jsonRpcUrl: string): string => jsonRpcUrl.replace(/\/jsonrpc\/?$/i, '');

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
      // Tron's nodes were java-tron API hosts while Tron was a wallet chain; a vault network reads
      // JSON-RPC, so those are dropped rather than asked for eth_call.
      for (const n of ['tron', 'tron-nile'] as const) {
        if (off[n]) off[n] = off[n].filter((u) => /\/jsonrpc\/?$/i.test(u));
        if (custom[n]) custom[n] = custom[n].filter((u) => /\/jsonrpc\/?$/i.test(u));
      }
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

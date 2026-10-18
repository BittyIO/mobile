/**
 * Chain + backend config for the mobile app.
 *
 * REUSE: these values mirror `web/src/utils/config.js`. For the foundation they are vendored here (a
 * small, stable surface) rather than imported across repos — reaching into `web/src` would drag Next's
 * server-only modules into the Metro bundle. When the shared `packages/core` is extracted, this file
 * becomes a thin re-export. Keep the addresses in sync with the web config until then.
 */
import {createPublicClient, http, fallback, type PublicClient} from 'viem';
import {mainnet, base, sepolia} from 'viem/chains';
import {defineChain} from 'viem';
import {MMKV} from 'react-native-mmkv';
import {generationConfig} from '@/core/vault-generation';

// Sepolia is the testnet — included so the app can be exercised end to end (activate, deposit, trade)
// without real funds. "Ethereum" in the UI means Sepolia on a testnet build, mainnet on production.
export type Network = 'mainnet' | 'base' | 'sepolia' | 'robinhood';

// Robinhood Chain: an Arbitrum Orbit L2 (id 4663) with ETH as gas, built for tokenized stocks. Not in
// viem's chain list, so defined here (mirrors web `lib/chains.ts`).
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
  rpcUrls: {default: {http: ['https://rpc.mainnet.chain.robinhood.com']}},
  blockExplorers: {default: {name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com'}},
  contracts: {multicall3: {address: '0xcA11bde05977b3631167028862bE2a173976CA11'}},
});

// The guard, factory and bootstrap differ per vault GENERATION, so they live with the generation
// the user has chosen — see `core/vault-generation`.

// Public RPCs as a default; point these at the app's own indexer endpoints before release (the web
// app uses per-provider keys to stay under free getLogs caps). Several per network so a single node
// rate-limiting or erroring doesn't fail a read — viem's fallback transport tries the next in order.
const RPC_URLS: Record<Network, string[]> = {
  mainnet: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://eth.drpc.org',
    'https://cloudflare-eth.com',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://base.drpc.org',
  ],
  sepolia: [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://sepolia.drpc.org',
    'https://rpc.sepolia.org',
  ],
  // The chain's own endpoint is the only public one; it rate-limits bursts (see the web's fallback list).
  robinhood: ['https://rpc.mainnet.chain.robinhood.com'],
};

const VIEM_CHAIN = {mainnet, base, sepolia, robinhood} as const;

// EIP-712 domain chainId per network — the ForwardRequest is signed against this (see vault/relay.ts).
export const CHAIN_ID: Record<Network, number> = {
  mainnet: mainnet.id,
  base: base.id,
  sepolia: sepolia.id,
  robinhood: robinhood.id,
};

// Uniswap V3 QuoterV2 (official deployments) — prices a market order through the actual pool, so the
// slippage guard reflects real price impact. From web use-vault.ts UNISWAP_QUOTER_V2.
export const QUOTER_V2: Record<Network, `0x${string}`> = {
  mainnet: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  sepolia: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  robinhood: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
};

/**
 * The owner's own RPC per network (Settings › RPC), or null for the public defaults above.
 *
 * Every on-chain read goes through {publicClientFor}, so this decides who answers the reads the
 * owner relies on to judge risk — the address book, pending changes, balances. A node the owner
 * runs or trusts cannot be made to lie about them the way a public endpoint could.
 */
const rpcStore = new MMKV({id: 'bitty.rpc'});
export const customRpc = (network: Network): string | null => rpcStore.getString(network) ?? null;
export function setCustomRpc(network: Network, url: string | null): void {
  if (url) rpcStore.set(network, url);
  else rpcStore.delete(network);
}

/** Does `url` answer as `network`? Run before saving, so a typo or the wrong chain never sticks. */
export async function rpcServes(url: string, network: Network): Promise<boolean> {
  const id = await createPublicClient({transport: http(url, {timeout: 10_000, retryCount: 0})})
    .getChainId()
    .catch(() => null);
  return id === CHAIN_ID[network];
}

/** A read-only viem client for the given network, resilient to a single RPC failing. */
export function publicClientFor(network: Network): PublicClient {
  const own = customRpc(network);
  return createPublicClient({
    chain: VIEM_CHAIN[network],
    // The owner's own node ALONE when set: falling back to a public one would hand the reads it was
    // chosen to protect to exactly the endpoints it replaces. Otherwise try the defaults in order
    // (rank off = keep the primary first); on error/timeout fall through.
    transport: own
      ? http(own, {retryCount: 1})
      : fallback(
          RPC_URLS[network].map((url) => http(url)),
          {rank: false, retryCount: 1},
        ),
  }) as PublicClient;
}

// Block explorer tx pages, per network.
export const EXPLORER_TX: Record<Network, string> = {
  mainnet: 'https://etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  sepolia: 'https://sepolia.etherscan.io/tx/',
  robinhood: 'https://robinhoodchain.blockscout.com/tx/',
};

// The existing Next.js API (data feeds: transfers, stake/supply flows, sync, …). The mobile app is a
// CLIENT of the same backend — routes stay on the server and are called over HTTP.
export const API_BASE = 'https://bitty.io';

/**
 * A read that cannot hang.
 *
 * Nothing in this app bounded a `fetch`. On iOS one inherits NSURLSession's 60-second timeout and
 * reports nothing at all until it expires, so a backend that stalls pins a screen's `loading` flag
 * for a minute with no error and no way out — which is what left Earn and Trade apparently loading
 * for ever: both are built almost entirely from server reads (positions, LP, flows, APY; orders,
 * market trades, the chart), where the Overview can draw itself from the chain read alone. An abort
 * turns a stall into a rejection, which every caller here already knows how to show.
 *
 * READS ONLY. Never wrap a relay, an order submission or any other write in this: the request may
 * well have been received, and a client that gives up reports a failure for something that is
 * about to happen anyway.
 *
 * The limit is a SAFETY NET against a stall, not a latency budget. It was 15s, which is a budget —
 * and a cold read of the positions endpoint on a chain with thirty registered assets beats it, so
 * the first visit to Earn aborted and showed nothing while the second, answered from the server's
 * warm cache, was instant. A caller that knows it is asking something slow passes its own.
 */
export async function apiFetch(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {...init, signal: ctrl.signal});
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build an API URL, tagging the chain (`?network=`) and the vault generation (`&version=`) the same
 * way the web app does. The version is what the server resolves the factory, guard and catalog by,
 * so it rides on every call rather than on the few that happened to need it first.
 */
export function apiUrl(path: string, network: Network): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${API_BASE}${path}${sep}network=${network}&version=${generationConfig().apiVersion}`;
}

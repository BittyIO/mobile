/**
 * Chain + backend config for the mobile app.
 *
 * REUSE: these values mirror `web/src/utils/config.js`. For the foundation they are vendored here (a
 * small, stable surface) rather than imported across repos — reaching into `web/src` would drag Next's
 * server-only modules into the Metro bundle. When the shared `packages/core` is extracted, this file
 * becomes a thin re-export. Keep the addresses in sync with the web config until then.
 */
import {createPublicClient, http, fallback, type PublicClient} from 'viem';
import {mainnet, base, sepolia, arbitrum} from 'viem/chains';
import {defineChain} from 'viem';
import {API_VERSION} from '@/core/vault-contracts';
import {rpcUrlsFor} from '@/core/rpc-store';
import {evmToTron} from '@/tron/address';

// Sepolia is the testnet — included so the app can be exercised end to end (activate, deposit, trade)
// without real funds. "Ethereum" in the UI means Sepolia on a testnet build, mainnet on production.
export type Network = 'mainnet' | 'base' | 'sepolia' | 'robinhood' | 'arbitrum' | 'tron-nile';

/**
 * Tron's testnet, Nile, as a VAULT network: the vault stack is deployed there (vault repo
 * `tron/`), so every vault screen runs on it as on any EVM chain, read through the node's
 * Ethereum-compatible JSON-RPC (`/jsonrpc`).
 *
 * What that JSON-RPC does not do, and what the app does instead:
 * - It accepts no transactions (no eth_sendRawTransaction, no nonces). A transaction is a Tron
 *   transaction, encoded and signed on this phone and broadcast to the node's own API: see
 *   `tron/vault-tx`, reached only from vault/direct `sendFromOwner`.
 * - Only the `latest` block tag; there is no `pending`.
 * - No Multicall3 contract, so {publicClientFor} answers `multicall` with one read per call.
 * - Addresses are the same 20 bytes, but people read and type Tron's base58 `T…` form: see
 *   core/address `displayAddress` / `parseAddress`.
 * - The native coin is TRX at 6 decimals, and fees are energy and bandwidth, priced in sun.
 *
 * Tron MAINNET is not here: no vault is deployed there yet, so it stays the plain wallet in `tron/`.
 */
export const isTronNetwork = (n: Network): n is 'tron-nile' => n === 'tron-nile';

export const tronNile = defineChain({
  id: 3448148188,
  name: 'Tron Nile',
  nativeCurrency: {name: 'Tron', symbol: 'TRX', decimals: 6},
  rpcUrls: {default: {http: ['https://nile.trongrid.io/jsonrpc']}},
  blockExplorers: {default: {name: 'Tronscan', url: 'https://nile.tronscan.org'}},
  testnet: true,
});

/**
 * The chain's own coin — what an owner pays fees in, and what the vault's `native` balance is — and
 * the token that wraps it, which is what a vault holds it as (the guard's CFG_GAS_WRAPPED: WETH on
 * the EVM chains, WTRX on Tron).
 */
export const NATIVE: Record<Network, {symbol: string; decimals: number; wrapped: string}> = {
  mainnet: {symbol: 'ETH', decimals: 18, wrapped: 'WETH'},
  base: {symbol: 'ETH', decimals: 18, wrapped: 'WETH'},
  sepolia: {symbol: 'ETH', decimals: 18, wrapped: 'WETH'},
  robinhood: {symbol: 'ETH', decimals: 18, wrapped: 'WETH'},
  arbitrum: {symbol: 'ETH', decimals: 18, wrapped: 'WETH'},
  'tron-nile': {symbol: 'TRX', decimals: 6, wrapped: 'WTRX'},
};

/**
 * What the network can do beyond holding, sending and paying. Nile has no protocol deployed (none
 * ships with the vault on Tron), so Earn and Trade have nothing to offer there.
 */
export const NETWORK_FEATURES: Record<Network, {defi: boolean}> = {
  mainnet: {defi: true},
  base: {defi: true},
  sepolia: {defi: true},
  robinhood: {defi: true},
  arbitrum: {defi: true},
  'tron-nile': {defi: false},
};

/** The test networks, which hold no real money. */
export const isTestnet = (n: Network): boolean => n === 'sepolia' || n === 'tron-nile';

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

// The guard, factory and bootstrap are in `core/vault-contracts`.

// The nodes each chain is read from — the built-in public list, less any the owner switched off, plus
// their own — live in `core/rpc-store` (Settings › RPC nodes).

const VIEM_CHAIN = {mainnet, base, sepolia, robinhood, arbitrum, 'tron-nile': tronNile} as const;

// EIP-712 domain chainId per network — the ForwardRequest is signed against this (see vault/relay.ts).
export const CHAIN_ID: Record<Network, number> = {
  mainnet: mainnet.id,
  base: base.id,
  sepolia: sepolia.id,
  robinhood: robinhood.id,
  arbitrum: arbitrum.id,
  'tron-nile': tronNile.id,
};

// Uniswap V3 QuoterV2 (official deployments) — prices a market order through the actual pool, so the
// slippage guard reflects real price impact. From web use-vault.ts UNISWAP_QUOTER_V2.
export const QUOTER_V2: Partial<Record<Network, `0x${string}`>> = {
  mainnet: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  sepolia: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  robinhood: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
};

/**
 * A read-only viem client for the given network, resilient to a single RPC failing.
 *
 * Made per call, from the nodes switched on in Settings › RPC nodes at that moment — the owner's own
 * first, then the built-in ones — so a change there applies to the next read. Only those: a node the
 * owner switched off is never asked, not even when every other one fails.
 */
/**
 * A fetch that calls the node at `url` exactly as configured.
 *
 * viem normalizes every RPC URL through `new URL(url).toString()`, and React Native's own URL appends
 * a slash to the path: `https://nile.trongrid.io/jsonrpc` went out as `…/jsonrpc/`. Most EVM nodes
 * shrug that off; TronGrid answers it 405 Not Allowed, so every Nile read failed on a device and
 * showed as a zero balance — while the same code under Node, whose URL adds nothing, read fine. Only
 * the slash this adds is taken back off: a URL configured with one keeps it.
 */
const asConfigured =
  (url: string): typeof fetch =>
  (input, init) =>
    fetch(typeof input === 'string' && !url.endsWith('/') && input === `${url}/` ? url : input, init);

export function publicClientFor(network: Network): PublicClient {
  const client = createPublicClient({
    chain: VIEM_CHAIN[network],
    // In order (rank off = keep the first first); on error/timeout fall through to the next.
    transport: fallback(
      rpcUrlsFor(network).map((url) => http(url, {fetchFn: asConfigured(url)})),
      {rank: false, retryCount: 1},
    ),
  }) as PublicClient;
  return isTronNetwork(network) ? withoutMulticall3(client) : client;
}

/**
 * A client whose `multicall` makes one `eth_call` per contract read, for a chain with no Multicall3
 * (Tron). Same answer shape as viem's: with `allowFailure` (the default) each entry is
 * `{status, result}` or `{status: 'failure', error}`; without it the first failure throws.
 */
function withoutMulticall3(client: PublicClient): PublicClient {
  type Args = Parameters<PublicClient['multicall']>[0];
  const multicall = async (args: Args) => {
    const {contracts, allowFailure = true, blockNumber, blockTag} = args as Args & {allowFailure?: boolean};
    const settled = await Promise.allSettled(
      (contracts as readonly Record<string, unknown>[]).map((c) =>
        client.readContract({...(c as Parameters<PublicClient['readContract']>[0]), blockNumber, blockTag} as Parameters<PublicClient['readContract']>[0]),
      ),
    );
    if (!allowFailure) {
      return settled.map((r) => {
        if (r.status === 'rejected') throw r.reason;
        return r.value;
      });
    }
    return settled.map((r) => (r.status === 'fulfilled' ? {status: 'success', result: r.value} : {status: 'failure', error: r.reason, result: undefined}));
  };
  return {...client, multicall: multicall as PublicClient['multicall']} as PublicClient;
}

// Block explorer tx pages, per network.
export const EXPLORER_TX: Record<Network, string> = {
  mainnet: 'https://etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  sepolia: 'https://sepolia.etherscan.io/tx/',
  robinhood: 'https://robinhoodchain.blockscout.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  'tron-nile': 'https://nile.tronscan.org/#/transaction/',
};

/** A transaction's page. Tronscan names a transaction by its id without the `0x`. */
export const explorerTxUrl = (network: Network, hash: string): string =>
  EXPLORER_TX[network] + (isTronNetwork(network) ? hash.replace(/^0x/, '') : hash);

/**
 * An address's page on the network's block explorer. Every EVM explorer above keeps them at
 * /address/; Tronscan at #/address/, by the base58 `T…` form.
 */
export const explorerAddressUrl = (network: Network, address: string): string =>
  isTronNetwork(network)
    ? `https://nile.tronscan.org/#/address/${evmToTron(address)}`
    : EXPLORER_TX[network].replace(/\/tx\/$/, '/address/') + address;

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
 * Build an API URL, tagging the chain (`?network=`) and the vault deployment (`&version=`) the same
 * way the web app does. The version is what the server resolves the factory, guard and catalog by,
 * so it rides on every call rather than on the few that happened to need it first.
 */
export function apiUrl(path: string, network: Network): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${API_BASE}${path}${sep}network=${network}&version=${API_VERSION}`;
}

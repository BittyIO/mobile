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

// The vault generation these addresses belong to. The positions API reads differently per generation,
// so it must be told which one (mirrors web `DEFAULT_VAULT_VERSION`).
export const DEFAULT_VAULT_VERSION = 'v1.0.0' as const;

// The Bitty guard — the stable ERC1967 anchor; SAME address on every chain by construction.
export const GUARD_ADDRESS =
  '0x00006Dc0000DBB00d9bd462ad2005E20007e0Dc7' as const;

// v1.0.x vault factory — a deterministic ERC1967 proxy, SAME address on every chain (web `factory`).
export const FACTORY_ADDRESS: Record<Network, `0x${string}`> = {
  mainnet: '0xCe9c32Bf9720027EE0137153A3C5BC803570DCbf',
  base: '0xCe9c32Bf9720027EE0137153A3C5BC803570DCbf',
  sepolia: '0xCe9c32Bf9720027EE0137153A3C5BC803570DCbf',
  robinhood: '0xCe9c32Bf9720027EE0137153A3C5BC803570DCbf',
};

// BITTY_VAULT_BOOTSTRAP — the constant implementation every vault proxy is BORN on. A vault's address
// is fixed by (factory, bootstrap, owner) and never moves when the vault implementation upgrades. Same
// on every chain (web `bootstrap`). Used by predict-vault.ts for local CREATE2 address prediction.
export const BOOTSTRAP_ADDRESS =
  '0x06dBcce6A83230B1Ea281F449f960c8F7124cc72' as const;

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

/** A read-only viem client for the given network, resilient to a single RPC failing. */
export function publicClientFor(network: Network): PublicClient {
  return createPublicClient({
    chain: VIEM_CHAIN[network],
    // Try the endpoints in order (rank off = keep the primary first); on error/timeout fall through.
    transport: fallback(
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

/** Build an API URL, tagging the chain the same way the web app does (`?network=`). */
export function apiUrl(path: string, network: Network): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${API_BASE}${path}${sep}network=${network}`;
}

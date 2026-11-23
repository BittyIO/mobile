/**
 * The Tron chain this app talks to through java-tron's own node API (`/wallet/…`) as well as
 * JSON-RPC: mainnet and Nile, its testnet, vault networks like any other (see core/chain). There is no Tron
 * wallet in the app: the phrase's own Tron address was removed, so only the vault reaches Tron.
 */
export type TronChain = 'tron' | 'tron-nile';

/** TronGrid, the Tron Foundation's public node API: a vault's account history (/v1/…) comes from it. */
export const TRON_API: Record<TronChain, string> = {
  tron: 'https://api.trongrid.io',
  'tron-nile': 'https://nile.trongrid.io',
};

/** 1 TRX = 1,000,000 sun. */
export const SUN_PER_TRX = 1_000_000n;

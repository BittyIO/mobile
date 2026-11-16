/**
 * The Tron chains this app talks to through java-tron's own node API (`/wallet/…`, `/v1/…`):
 * mainnet, and its testnet Nile. Low level only — what a chain IS in the app is decided below.
 */
export type TronChain = 'tron' | 'tron-nile';

/**
 * The Tron chains as this app uses them: plain wallets on the same recovery phrase, which send,
 * stake (Stake 2.0) and, on mainnet, trade on SunSwap and bridge out by Across. No vault — no
 * timelock, no allowance, no relayer — so nothing in `src/vault` applies to them.
 *
 * Nile was a vault network for a while ('tron-nile' is still a member of the vault `Network` type,
 * and its vault code is still there), but the app reaches it only as a wallet now.
 */
export type TronNet = 'tron' | 'tron-nile';

export const TRON_NETS: TronNet[] = ['tron', 'tron-nile'];

export const isTronNet = (n: string): n is TronNet => (TRON_NETS as string[]).includes(n);

/** TronGrid, the Tron Foundation's public node API. Unkeyed it is rate limited, which a wallet's few reads stay well under. */
export const TRON_API: Record<TronChain, string> = {
  tron: 'https://api.trongrid.io',
  'tron-nile': 'https://nile.trongrid.io',
};

export const TRON_LABEL: Record<TronNet, string> = {
  tron: 'Tron',
  'tron-nile': 'Tron Nile',
};

/** Transaction pages on Tronscan. */
export const TRON_EXPLORER_TX: Record<TronChain, string> = {
  tron: 'https://tronscan.org/#/transaction/',
  'tron-nile': 'https://nile.tronscan.org/#/transaction/',
};

export type TronAsset = {
  symbol: string;
  name: string;
  decimals: number;
  /** The TRC-20 contract (base58); absent for TRX itself. */
  contract?: string;
};

export const TRX: TronAsset = {symbol: 'TRX', name: 'Tron', decimals: 6};

/** What the wallet shows and can send: TRX, and USDT — the token most payments on Tron are made in. */
export const TRON_ASSETS: Record<TronNet, TronAsset[]> = {
  tron: [TRX, {symbol: 'USDT', name: 'Tether USD', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'}],
  // Nile's test USDT: the one the Nile vault listed (0xECa9bC…), so test money held there shows here.
  'tron-nile': [TRX, {symbol: 'USDT', name: 'Tether USD', decimals: 6, contract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'}],
};

/** 1 TRX = 1,000,000 sun. */
export const SUN_PER_TRX = 1_000_000n;

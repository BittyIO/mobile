/**
 * Tron, as this app uses it: a plain wallet on the same recovery phrase, for paying out of. There is
 * no vault contract on Tron — no timelock, no allowance, no relayer — so nothing in `src/vault`
 * applies here, and Tron is deliberately NOT a member of the EVM `Network` type: every screen that
 * reads that type talks to a vault, and none of them should ever be handed a Tron chain.
 */
export type TronNet = 'tron' | 'tron-nile';

export const TRON_NETS: TronNet[] = ['tron', 'tron-nile'];

export const isTronNet = (n: string): n is TronNet => (TRON_NETS as string[]).includes(n);

/** TronGrid, the Tron Foundation's public node API. Unkeyed it is rate limited, which a wallet's few reads stay well under. */
export const TRON_API: Record<TronNet, string> = {
  tron: 'https://api.trongrid.io',
  'tron-nile': 'https://nile.trongrid.io',
};

export const TRON_LABEL: Record<TronNet, string> = {
  tron: 'Tron',
  'tron-nile': 'Tron Nile',
};

/** Transaction pages on Tronscan. */
export const TRON_EXPLORER_TX: Record<TronNet, string> = {
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
  'tron-nile': [TRX, {symbol: 'USDT', name: 'Tether USD', decimals: 6, contract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'}],
};

/** 1 TRX = 1,000,000 sun. */
export const SUN_PER_TRX = 1_000_000n;

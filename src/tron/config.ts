/**
 * The Tron chains this app talks to through java-tron's own node API (`/wallet/…`, `/v1/…`):
 * mainnet, and its testnet Nile. Low level only — what a chain IS in the app is decided below.
 */
export type TronChain = 'tron' | 'tron-nile';

/**
 * Tron mainnet, as this app uses it today: a plain wallet on the same recovery phrase, for paying
 * out of. No vault is deployed there yet — no timelock, no allowance, no relayer — so nothing in
 * `src/vault` applies, and it is deliberately NOT a member of the vault `Network` type.
 *
 * Nile is different: the vault IS deployed there, so Nile is a vault `Network` ('tron-nile', see
 * core/chain) and not a wallet. When the vault reaches mainnet, 'tron' moves the same way.
 */
export type TronNet = 'tron';

export const TRON_NETS: TronNet[] = ['tron'];

export const isTronNet = (n: string): n is TronNet => (TRON_NETS as string[]).includes(n);

/** TronGrid, the Tron Foundation's public node API. Unkeyed it is rate limited, which a wallet's few reads stay well under. */
export const TRON_API: Record<TronChain, string> = {
  tron: 'https://api.trongrid.io',
  'tron-nile': 'https://nile.trongrid.io',
};

export const TRON_LABEL: Record<TronNet, string> = {
  tron: 'Tron',
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
};

/** 1 TRX = 1,000,000 sun. */
export const SUN_PER_TRX = 1_000_000n;

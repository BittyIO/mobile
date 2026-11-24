import {MMKV} from 'react-native-mmkv';
import type {Network} from '@/core/chain';

/**
 * What this phone sent from a WALLET (core/account-mode), kept on the phone.
 *
 * On the chains with no history index the app can read without a key (Base, Arbitrum, BSC,
 * Robinhood — see vault/transactions `fetchWalletTransactions`), the wallet's history is read from
 * the chain's Transfer logs, and a coin sent (ETH, BNB) leaves no log. Recording every send at the
 * moment it is broadcast fills that in for the sends made here. Public data only: hashes,
 * addresses, amounts.
 */
export type SentRecord = {
  hash: string;
  network: Network;
  /** The wallet it was sent from, lowercase. */
  from: string;
  to: string;
  symbol: string;
  /** The token's contract, or null for the chain's coin. */
  token: string | null;
  /** Human amount, as typed. */
  amount: string;
  at: number;
};

const store = new MMKV({id: 'bitty.wallet-sends'});
const KEY = 'sends';
/** Plenty for a history page; the oldest go first. */
const MAX = 500;

function load(): SentRecord[] {
  try {
    return JSON.parse(store.getString(KEY) ?? '[]') as SentRecord[];
  } catch {
    return [];
  }
}

export function recordSent(r: Omit<SentRecord, 'at' | 'from'> & {from: string}): void {
  const next = [{...r, from: r.from.toLowerCase(), at: Date.now()}, ...load().filter((x) => x.hash !== r.hash)].slice(0, MAX);
  store.set(KEY, JSON.stringify(next));
}

/** The sends from `wallet` on `network`, newest first. */
export function sentFrom(wallet: string, network: Network): SentRecord[] {
  const w = wallet.toLowerCase();
  return load().filter((r) => r.from === w && r.network === network);
}

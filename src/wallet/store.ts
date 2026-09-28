/**
 * Wallet session state (zustand) for the EMBEDDED keyring. The private key lives in the Keychain (see
 * ./keyring); the in-memory {@link HDAccount} is dropped on lock. The public address is cached (MMKV) so
 * the locked UI knows "who am I" without a biometric prompt. The mnemonic is NEVER in here.
 *
 * A write re-reads the key from the Keychain (see {@link WalletState.signer}), so every fund-moving
 * action is individually Face-ID / passcode gated — a single unlock doesn't authorize everything after.
 */
import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {HDAccount} from 'viem/accounts';
import type {Signer} from './signer';
import * as keyring from './keyring';

const cache = new MMKV();
const ADDRESS_KEY = 'address';

export type WalletStatus = 'unknown' | 'no-wallet' | 'locked' | 'unlocked';

interface WalletState {
  status: WalletStatus;
  /**
   * Why the wallet is locked: 'launch' (the app started or was never unlocked) lets the lock screen
   * start Face ID on its own; 'user' (Lock tapped in Settings) keeps it locked until the user taps
   * Unlock, otherwise the prompt would fire at once and undo the lock.
   */
  lockedBy: 'launch' | 'user';
  address: `0x${string}` | null;
  /** Present only while unlocked; carries the key. Dropped on lock(). */
  account: HDAccount | null;
  init: () => Promise<void>;
  createWallet: () => Promise<{mnemonic: string}>;
  importWallet: (mnemonic: string) => Promise<void>;
  unlock: () => Promise<void>;
  lock: () => void;
  wipe: () => Promise<void>;
  /** A fresh signer for a WRITE — re-read from the Keychain so every action is biometric-gated. */
  signer: () => Promise<Signer>;
}

function remember(account: HDAccount) {
  cache.set(ADDRESS_KEY, account.address);
}

export const useWallet = create<WalletState>((set) => ({
  status: 'unknown',
  lockedBy: 'launch',
  address: (cache.getString(ADDRESS_KEY) as `0x${string}` | undefined) ?? null,
  account: null,

  init: async () => {
    const exists = await keyring.hasWallet();
    set({status: exists ? 'locked' : 'no-wallet', lockedBy: 'launch'});
  },

  createWallet: async () => {
    const {mnemonic, account} = await keyring.createWallet();
    remember(account);
    set({account, address: account.address, status: 'unlocked'});
    return {mnemonic};
  },

  importWallet: async (mnemonic: string) => {
    const account = await keyring.importWallet(mnemonic);
    remember(account);
    set({account, address: account.address, status: 'unlocked'});
  },

  unlock: async () => {
    const account = await keyring.unlock();
    if (account) {
      remember(account);
      set({account, address: account.address, status: 'unlocked'});
    }
  },

  lock: () => set({account: null, status: 'locked', lockedBy: 'user'}),

  wipe: async () => {
    await keyring.wipe();
    cache.delete(ADDRESS_KEY);
    set({account: null, address: null, status: 'no-wallet'});
  },

  signer: async () => {
    const account = await keyring.unlock();
    if (!account) throw new Error('Unlock cancelled');
    return account;
  },
}));

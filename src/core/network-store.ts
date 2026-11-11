import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Network} from '@/core/chain';
import {isTronNet, TRON_LABEL, type TronNet} from '@/tron/config';

// Persist the chosen network so it survives relaunch.
const store = new MMKV({id: 'bitty.network'});
const KEY = 'network';
const TRON_KEY = 'tron';

type NetworkState = {
  /** The EVM chain the vault screens talk to. Kept while Tron is in front, so leaving Tron returns to it. */
  network: Network;
  /**
   * Tron mainnet, when it is the chain in front: the app shows the Tron wallet instead of the vault
   * tabs. (Tron Nile is not this: it has the vault, so it is a {network} like any other.)
   * Separate from {network} on purpose — every vault screen reads that one, and none of them can be
   * handed a chain with no vault on it.
   */
  tron: TronNet | null;
  setNetwork: (n: Network) => void;
  setTron: (n: TronNet) => void;
};

/**
 * Tron in this build: both Tron mainnet's wallet and the Tron Nile vault. Off for the store releases,
 * which ship the EVM chains only — the picker does not offer Tron, and a phone left on it opens on
 * Ethereum. The code stays; only the way in is closed.
 */
export const TRON_ENABLED = false;

/** Sepolia, the Ethereum testnet: off for the store releases too, the same way. */
export const SEPOLIA_ENABLED = false;

/** Whether this build offers `n` (see {TRON_ENABLED}, {SEPOLIA_ENABLED}). */
const offered = (n: Network): boolean => (n === 'tron-nile' ? TRON_ENABLED : n === 'sepolia' ? SEPOLIA_ENABLED : true);

const storedTron = TRON_ENABLED ? store.getString(TRON_KEY) : undefined;
const storedNetwork = store.getString(KEY) as Network | undefined;

/** The active network (mainnet / base / …, or Tron), shared by every screen. */
export const useNetwork = create<NetworkState>((set) => ({
  // Nile used to be a Tron wallet chain, stored under TRON_KEY; it is a vault network now, so a phone
  // left on it opens on Nile's vault rather than falling back to the last EVM chain.
  network:
    storedTron === 'tron-nile'
      ? 'tron-nile'
      : storedNetwork && offered(storedNetwork)
        ? storedNetwork
        : 'mainnet',
  tron: storedTron && isTronNet(storedTron) ? storedTron : null,
  setNetwork: (network) => {
    store.set(KEY, network);
    store.delete(TRON_KEY);
    set({network, tron: null});
  },
  setTron: (tron) => {
    store.set(TRON_KEY, tron);
    set({tron});
  },
}));

/** What the picker offers: the vault chains (Tron Nile among them), and Tron mainnet's wallet. */
export type ChainChoice = Network | TronNet;

export const NETWORKS: Network[] = (['mainnet', 'base', 'arbitrum', 'bsc', 'robinhood', 'sepolia', 'tron-nile'] as Network[]).filter(offered);
/** The networks to offer. */
export const useNetworks = (): Network[] => NETWORKS;

export const NETWORK_LABEL: Record<Network, string> = {
  mainnet: 'Ethereum',
  base: 'Base',
  sepolia: 'Ethereum Sepolia',
  robinhood: 'Robinhood',
  arbitrum: 'Arbitrum',
  bsc: 'BNB Chain',
  'tron-nile': 'Tron Nile',
};

/** The network's name for display, translated where the language has its own word for it. */
export function networkLabel(n: ChainChoice, t: (key: string) => string): string {
  if (isTronNet(n)) return TRON_LABEL[n];
  if (n === 'mainnet') return t('mobile.app.ethereum');
  if (n === 'robinhood') return t('mobile.app.robinhood');
  if (n === 'sepolia') return t('mobile.app.sepolia');
  return NETWORK_LABEL[n];
}

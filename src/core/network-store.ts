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
   * Tron, when it is the chain in front: the app shows the Tron wallet instead of the vault tabs.
   * Separate from {network} on purpose — every vault screen reads that one, and none of them can be
   * handed a chain with no vault on it.
   */
  tron: TronNet | null;
  setNetwork: (n: Network) => void;
  setTron: (n: TronNet) => void;
};

const storedTron = store.getString(TRON_KEY);

/** The active network (mainnet / base / …, or Tron), shared by every screen. */
export const useNetwork = create<NetworkState>((set) => ({
  network: (store.getString(KEY) as Network) ?? 'mainnet',
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

/** What the picker offers: the vault chains, then Tron's wallet. */
export type ChainChoice = Network | TronNet;

export const NETWORKS: Network[] = ['mainnet', 'base', 'arbitrum', 'robinhood', 'sepolia'];
/** The networks to offer. */
export const useNetworks = (): Network[] => NETWORKS;

export const NETWORK_LABEL: Record<Network, string> = {
  mainnet: 'Ethereum',
  base: 'Base',
  sepolia: 'Ethereum Sepolia',
  robinhood: 'Robinhood',
  arbitrum: 'Arbitrum',
};

/** The network's name for display, translated where the language has its own word for it. */
export function networkLabel(n: ChainChoice, t: (key: string) => string): string {
  if (isTronNet(n)) return TRON_LABEL[n];
  if (n === 'mainnet') return t('mobile.app.ethereum');
  if (n === 'robinhood') return t('mobile.app.robinhood');
  if (n === 'sepolia') return t('mobile.app.sepolia');
  return NETWORK_LABEL[n];
}

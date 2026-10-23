import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Network} from '@/core/chain';

// Persist the chosen network so it survives relaunch.
const store = new MMKV({id: 'bitty.network'});
const KEY = 'network';

type NetworkState = {
  network: Network;
  setNetwork: (n: Network) => void;
};

/** The active network (mainnet / base), shared by every screen. */
export const useNetwork = create<NetworkState>((set) => ({
  network: (store.getString(KEY) as Network) ?? 'mainnet',
  setNetwork: (network) => {
    store.set(KEY, network);
    set({network});
  },
}));

export const NETWORKS: Network[] = ['mainnet', 'base', 'arbitrum', 'robinhood', 'sepolia'];
/** The networks to offer. */
export const useNetworks = (): Network[] => NETWORKS;

export const NETWORK_LABEL: Record<Network, string> = {
  mainnet: 'Ethereum',
  base: 'Base',
  sepolia: 'Sepolia',
  robinhood: 'Robinhood',
  arbitrum: 'Arbitrum',
};

/** The network's name for display, translated where the language has its own word for it. */
export function networkLabel(n: Network, t: (key: string) => string): string {
  if (n === 'mainnet') return t('mobile.app.ethereum');
  if (n === 'robinhood') return t('mobile.app.robinhood');
  if (n === 'sepolia') return t('mobile.app.sepolia');
  return NETWORK_LABEL[n];
}

import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Network} from '@/core/chain';
import {useVaultGeneration, type VaultGeneration} from '@/core/vault-generation';

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
/** The networks a generation is deployed on: the old one never shipped to Arbitrum. */
export const networksFor = (g: VaultGeneration): Network[] =>
  g === 'v1.0.3' ? NETWORKS.filter((n) => n !== 'arbitrum') : NETWORKS;

/** The networks to offer, for the generation in use. */
export const useNetworks = (): Network[] => networksFor(useVaultGeneration((s) => s.generation));

// Switching to a generation that is not on the current network leaves it for Ethereum.
useVaultGeneration.subscribe(({generation}) => {
  const {network, setNetwork} = useNetwork.getState();
  if (!networksFor(generation).includes(network)) setNetwork('mainnet');
});

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

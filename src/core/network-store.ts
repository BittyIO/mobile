import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Network} from '@/core/chain';

// Persist the chosen network so it survives relaunch.
const store = new MMKV({id: 'bitty.network'});
const KEY = 'network';
/** Where the Tron wallet, now removed, kept which Tron chain was in front. Read once, to move off it. */
const TRON_KEY = 'tron';

type NetworkState = {
  /** The chain every vault screen talks to — Tron Nile among them. */
  network: Network;
  /** Settings › Network › Show networks (see {isShown}). */
  shown: Shown;
  setNetwork: (n: Network) => void;
  setShown: (n: Network, on: boolean) => void;
};

/** Testnets: offered, but hidden from the network picker until the user turns them on. */
export const TESTNETS: ReadonlySet<Network> = new Set<Network>(['sepolia', 'base-sepolia', 'tron-nile']);

/**
 * Settings › Network › Show networks: which networks the picker lists, one stored switch each.
 * Unset means the default — on, except a testnet.
 */
const SHOWN_KEY = 'shown';
type Shown = Partial<Record<Network, boolean>>;
const readShown = (): Shown => {
  try {
    return JSON.parse(store.getString(SHOWN_KEY) ?? '{}') as Shown;
  } catch {
    return {};
  }
};
const isShown = (shown: Shown, n: Network): boolean => shown[n] ?? !TESTNETS.has(n);

/** Every vault network, listed in the picker or not (see {useNetworks}), in the picker's order. */
export const NETWORKS: Network[] = ['mainnet', 'tron', 'base', 'arbitrum', 'bsc', 'robinhood', 'sepolia', 'base-sepolia', 'tron-nile'];

/*
 * The Tron wallet has left the app. A phone left on Nile's wallet opens on Nile's vault; one left on
 * Tron mainnet's wallet, on the vault network it had behind it.
 */
const storedTron = store.getString(TRON_KEY);
store.delete(TRON_KEY);
const storedRaw = storedTron === 'tron-nile' ? 'tron-nile' : (store.getString(KEY) as Network | undefined);
const storedNetwork = storedRaw && NETWORKS.includes(storedRaw) ? storedRaw : undefined;
if (storedNetwork) store.set(KEY, storedNetwork);

const initialNetwork: Network = storedNetwork ?? 'mainnet';

/** `shown` with `n` on: the network in front is always one the picker lists. */
const withShown = (shown: Shown, n: Network): Shown => {
  if (isShown(shown, n)) return shown;
  const next = {...shown, [n]: true};
  store.set(SHOWN_KEY, JSON.stringify(next));
  return next;
};

/** The active network (mainnet / base / … / Tron Nile), shared by every screen. */
export const useNetwork = create<NetworkState>((set, get) => ({
  network: initialNetwork,
  // A phone already on a testnet keeps it listed, rather than opening on a network it can't pick.
  shown: withShown(readShown(), initialNetwork),
  setNetwork: (network) => {
    store.set(KEY, network);
    // Reached another way (a vault on a hidden network): listed again, so the picker shows where you are.
    set({network, shown: withShown(get().shown, network)});
  },
  setShown: (n, on) => {
    // The network in front stays listed; the page doesn't offer turning it off.
    if (!on && n === get().network) return;
    const shown = {...get().shown, [n]: on};
    store.set(SHOWN_KEY, JSON.stringify(shown));
    set({shown});
  },
}));

/** The networks the picker lists: those switched on in Settings › Network. */
export const useNetworks = (): Network[] => {
  const shown = useNetwork((s) => s.shown);
  return NETWORKS.filter((n) => isShown(shown, n));
};
/** Whether `n` is listed in the picker. */
export const useIsShown = (n: Network): boolean => useNetwork((s) => isShown(s.shown, n));

export const NETWORK_LABEL: Record<Network, string> = {
  mainnet: 'Ethereum',
  base: 'Base',
  sepolia: 'Ethereum Sepolia',
  'base-sepolia': 'Base Sepolia',
  robinhood: 'Robinhood',
  arbitrum: 'Arbitrum',
  bsc: 'BNB Chain',
  tron: 'Tron',
  'tron-nile': 'Tron Nile',
};

/** The network's name for display, translated where the language has its own word for it. */
export function networkLabel(n: Network, t: (key: string) => string): string {
  if (n === 'mainnet') return t('mobile.app.ethereum');
  if (n === 'robinhood') return t('mobile.app.robinhood');
  if (n === 'sepolia') return t('mobile.app.sepolia');
  return NETWORK_LABEL[n];
}

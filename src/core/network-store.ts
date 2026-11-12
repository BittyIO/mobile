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
  /** Settings › Network › Show networks (see {isShown}). */
  shown: Shown;
  setNetwork: (n: Network) => void;
  setShown: (n: Network, on: boolean) => void;
  setTron: (n: TronNet) => void;
};

/**
 * Tron mainnet's wallet in this build. Off for the store releases — the picker does not offer it, and
 * a phone left on it opens on Ethereum. The code stays; only the way in is closed. Tron Nile's vault
 * is not behind this: it is a testnet like Sepolia, hidden until turned on in Settings › Network.
 */
export const TRON_ENABLED = false;

/** Testnets: offered, but hidden from the network picker until the user turns them on. */
export const TESTNETS: ReadonlySet<Network> = new Set<Network>(['sepolia', 'tron-nile']);

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

// Tron mainnet only when this build has it; Nile, stored here once, is a vault network either way.
const storedTronRaw = store.getString(TRON_KEY);
const storedTron = TRON_ENABLED || storedTronRaw === 'tron-nile' ? storedTronRaw : undefined;
const storedNetwork = store.getString(KEY) as Network | undefined;

// Nile used to be a Tron wallet chain, stored under TRON_KEY; it is a vault network now, so a phone
// left on it opens on Nile's vault rather than falling back to the last EVM chain.
const initialNetwork: Network =
  storedTron === 'tron-nile' ? 'tron-nile' : (storedNetwork ?? 'mainnet');

/** `shown` with `n` on: the network in front is always one the picker lists. */
const withShown = (shown: Shown, n: Network): Shown => {
  if (isShown(shown, n)) return shown;
  const next = {...shown, [n]: true};
  store.set(SHOWN_KEY, JSON.stringify(next));
  return next;
};

/** The active network (mainnet / base / …, or Tron), shared by every screen. */
export const useNetwork = create<NetworkState>((set, get) => ({
  network: initialNetwork,
  tron: storedTron && storedTron !== 'tron-nile' && isTronNet(storedTron) ? storedTron : null,
  // A phone already on a testnet keeps it listed, rather than opening on a network it can't pick.
  shown: withShown(readShown(), initialNetwork),
  setNetwork: (network) => {
    store.set(KEY, network);
    store.delete(TRON_KEY);
    // Reached another way (a vault on a hidden network): listed again, so the picker shows where you are.
    set({network, tron: null, shown: withShown(get().shown, network)});
  },
  setShown: (n, on) => {
    // The network in front stays listed; the page doesn't offer turning it off.
    if (!on && n === get().network) return;
    const shown = {...get().shown, [n]: on};
    store.set(SHOWN_KEY, JSON.stringify(shown));
    set({shown});
  },
  setTron: (tron) => {
    store.set(TRON_KEY, tron);
    set({tron});
  },
}));

/** What the picker offers: the vault chains (Tron Nile among them), and Tron mainnet's wallet. */
export type ChainChoice = Network | TronNet;

/** Every vault network, listed in the picker or not (see {useNetworks}). */
export const NETWORKS: Network[] = ['mainnet', 'base', 'arbitrum', 'bsc', 'robinhood', 'sepolia', 'tron-nile'];
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

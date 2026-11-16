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
 * Tron mainnet's wallet in this build: the phrase's own Tron address, which sends, stakes (Stake
 * 2.0) and trades on SunSwap itself. No vault there; Tron's vault is Nile's only, a testnet like
 * Sepolia, hidden until turned on in Settings › Network. Off, the picker does not offer mainnet and
 * a phone left on it opens on Ethereum.
 */
export const TRON_ENABLED = true;

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

// The Tron wallets only when this build has them.
const storedTronRaw = store.getString(TRON_KEY);
const storedNetworkRaw = store.getString(KEY) as Network | undefined;
// Nile was a vault network for a while, stored under KEY: a phone left on it opens on Nile's wallet.
const storedTron = TRON_ENABLED ? (storedNetworkRaw === 'tron-nile' ? 'tron-nile' : storedTronRaw) : undefined;
const storedNetwork = storedNetworkRaw === 'tron-nile' ? undefined : storedNetworkRaw;

const initialNetwork: Network = storedNetwork ?? 'mainnet';

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
  tron: storedTron && isTronNet(storedTron) ? storedTron : null,
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
    // Nile's wallet, a testnet, stays listed while it is in front, as a vault testnet does.
    set({tron, shown: tron === 'tron-nile' ? withShown(get().shown, 'tron-nile') : get().shown});
  },
}));

/** What the picker offers: the vault chains, and the Tron wallets (mainnet and Nile). */
export type ChainChoice = Network | TronNet;

/** Every vault network, listed in the picker or not (see {useNetworks}). Tron Nile is a wallet now, not here. */
export const NETWORKS: Network[] = ['mainnet', 'base', 'arbitrum', 'bsc', 'robinhood', 'sepolia', 'base-sepolia'];

/**
 * Everything the picker can list, in its order: Tron's wallet straight after Ethereum, as the other
 * chain people most often hold dollars on, and Nile's wallet last, beside the other testnets.
 * Settings › Network lists the same, each with its switch ('tron-nile' keeps its stored one).
 */
export const PICKER_CHAINS: ChainChoice[] = TRON_ENABLED ? [NETWORKS[0], 'tron', ...NETWORKS.slice(1), 'tron-nile'] : NETWORKS;
/** Whether `n` is listed in the picker. Tron mainnet always is; the rest by their switch. */
const listedIn = (shown: Shown, n: ChainChoice) => n === 'tron' || isShown(shown, n as Network);
/** The picker's list, as switched on in Settings › Network. */
export const usePickerChains = (): ChainChoice[] => {
  const shown = useNetwork((s) => s.shown);
  return PICKER_CHAINS.filter((n) => listedIn(shown, n));
};
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

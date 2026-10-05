import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Network} from '@/core/chain';

/**
 * Names the user has given to addresses, kept on this device and nowhere else.
 *
 * The vault's whitelist is a list of ADDRESSES — that is all the contract stores, and all it can
 * store, because a label on chain would cost gas to write and be public to everyone who reads
 * the vault. So a name here is a local convenience: it survives relaunch and it never leaves the
 * phone, which is exactly what the screen that collects it says.
 *
 * Keyed by network and address, because the same address can be a different counterparty on a
 * different chain, and lowercased so a checksummed address and a pasted one are the same key.
 */
const store = new MMKV({id: 'bitty.recipients'});
const KEY = 'names';

const key = (network: Network, address: string) => `${network}:${address.toLowerCase()}`;

function load(): Record<string, string> {
  try {
    const raw = store.getString(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

type State = {
  names: Record<string, string>;
  /** An empty name forgets the entry rather than storing a blank. */
  setName: (network: Network, address: string, name: string) => void;
};

export const useRecipientNames = create<State>((set, get) => ({
  names: load(),
  setName: (network, address, name) => {
    const next = {...get().names};
    const k = key(network, address);
    const trimmed = name.trim();
    if (trimmed) next[k] = trimmed;
    else delete next[k];
    store.set(KEY, JSON.stringify(next));
    set({names: next});
  },
}));

/** The name for one address, or undefined. Subscribes, so a rename redraws the row. */
export const useRecipientName = (network: Network, address: string | null | undefined) =>
  useRecipientNames((s) => (address ? s.names[key(network, address)] : undefined));

/** Non-reactive lookup, for building a list in a memo. */
export const recipientName = (names: Record<string, string>, network: Network, address: string) =>
  names[key(network, address)];

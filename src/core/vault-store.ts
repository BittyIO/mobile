import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

/**
 * The vaults this device can open, and which one is in front.
 *
 * The factory salts on the owner's address, so an owner has exactly one vault and always will —
 * a second vault is a second owner. Both come from the same recovery phrase at different BIP-44
 * account indexes, so the phrase still restores every vault, and nothing new has to be written
 * down. A vault is therefore just an index plus whatever the user decided to call it.
 *
 * Names are local. There is nowhere on chain to put one, and a label the user picked for their
 * own bookkeeping is not something to publish; a new device shows "Vault 2" again until renamed.
 *
 * Owner addresses are cached here as well, which is what keeps switching free: deriving one needs
 * the mnemonic and therefore Face ID, so it is done once when the vault is added and read from
 * here every time after.
 */
const store = new MMKV({id: 'bitty.vaults'});
const KEY = 'vaults';
const ACTIVE = 'active';

export type VaultRef = {
  /** BIP-44 account index. 0 is the wallet that existed before there was more than one. */
  index: number;
  /** What the user calls it. Empty means "not named", and the UI falls back to Vault {n}. */
  name: string;
  /** The owner address at that index, cached so a switch costs no biometric prompt. */
  owner: `0x${string}` | null;
};

function load(): VaultRef[] {
  const raw = store.getString(KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length) return parsed as VaultRef[];
    } catch {
      /* corrupt entry: fall through to the single default */
    }
  }
  return [{index: 0, name: '', owner: null}];
}

type State = {
  vaults: VaultRef[];
  activeIndex: number;
  /** Record the owner address for an index, the first time it is derived. */
  setOwner: (index: number, owner: `0x${string}`) => void;
  rename: (index: number, name: string) => void;
  select: (index: number) => void;
  /** Append the next index. The caller supplies the owner it just derived. */
  add: (owner: `0x${string}`) => number;
};

export const useVaults = create<State>((set, get) => ({
  vaults: load(),
  activeIndex: store.getNumber(ACTIVE) ?? 0,

  setOwner: (index, owner) => {
    const vaults = get().vaults.map((v) => (v.index === index ? {...v, owner} : v));
    store.set(KEY, JSON.stringify(vaults));
    set({vaults});
  },

  rename: (index, name) => {
    const vaults = get().vaults.map((v) => (v.index === index ? {...v, name: name.trim()} : v));
    store.set(KEY, JSON.stringify(vaults));
    set({vaults});
  },

  select: (index) => {
    store.set(ACTIVE, index);
    set({activeIndex: index});
  },

  add: (owner) => {
    const next = Math.max(...get().vaults.map((v) => v.index)) + 1;
    const vaults = [...get().vaults, {index: next, name: '', owner}];
    store.set(KEY, JSON.stringify(vaults));
    store.set(ACTIVE, next);
    set({vaults, activeIndex: next});
    return next;
  },
}));

/** The label to show: what the user named it, or "Vault {n}" counting from one. */
export function vaultLabel(v: VaultRef, fallback: (n: number) => string): string {
  return v.name || fallback(v.index + 1);
}

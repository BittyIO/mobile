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
 *
 * A vault can also be owned by a Safe. Its owner is then the Safe's address — the factory salts on
 * that, so the vault is the Safe's, at the same address any owner of the Safe computes — and the
 * key on this device is just one of the Safe's owners, at `signerIndex` of the same phrase. Nothing
 * else about it is stored: the Safe's owners and threshold are read from the chain when signing.
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
  /**
   * Set when the vault is owned by a Safe: the Safe's address, which is then also `owner`. The
   * index is this entry's own id and never derives a key.
   */
  safe?: `0x${string}`;
  /** For a Safe vault, the BIP-44 index of this device's key that is an owner of the Safe. */
  signerIndex?: number;
  /** That key's address, cached like `owner` so the approvals screen can tell what it signed. */
  signer?: `0x${string}`;
  /**
   * For a Safe vault signed for by a key imported on its own (see wallet/keyring `importPrivateKey`)
   * rather than one of the phrase's: true, and `signer` is that key's address. `signerIndex` is
   * then not set.
   */
  imported?: boolean;
  /**
   * Set for a vault this device's key RECEIVED by an ownership transfer: the vault's own address.
   *
   * Every other vault sits at the address the factory derives from its owner, so it is computed
   * and never stored. A received one does not: it keeps the address its first owner's key derived,
   * on the one chain the transfer happened on. Its key is `signerIndex` (and `owner`/`signer`).
   */
  vault?: `0x${string}`;
  /**
   * The chain a received vault is on. It does not exist at that address anywhere else. Also set,
   * with `vault`, for a Safe vault that was transferred to its Safe rather than created by it.
   */
  network?: string;
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
  /**
   * Append a vault owned by `safe`, signed for by this device's key: the phrase's at `signer.index`,
   * or an imported one (no index). Its index is a fresh id, like any other vault's. `at` is the
   * vault's address and chain when it is not the one the factory derives from the Safe. Adding a
   * Safe that is already here updates and selects that one instead.
   */
  addSafe: (safe: `0x${string}`, signer: {index?: number; address: `0x${string}`}, at?: {vault: `0x${string}`; network: string}) => number;
  /**
   * Append a vault this device's key at `signerIndex` owns by transfer, at `vault` on `network`.
   * Adding one already listed only refreshes its key. Returns its index; does not select it.
   */
  addReceived: (vault: `0x${string}`, network: string, signerIndex: number, owner: `0x${string}`) => number;
  /** Take a vault off this device's list. Nothing changes on chain. The last one stays. */
  remove: (index: number) => void;
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

  addSafe: (safe, signer, at) => {
    const existing = get().vaults.find((v) => v.safe?.toLowerCase() === safe.toLowerCase());
    const index = existing?.index ?? Math.max(...get().vaults.map((v) => v.index)) + 1;
    const key: Partial<VaultRef> =
      signer.index === undefined
        ? {signer: signer.address, imported: true, signerIndex: undefined}
        : {signer: signer.address, signerIndex: signer.index, imported: undefined};
    const vaults = existing
      ? get().vaults.map((v) => (v.index === index ? {...v, ...key, ...at} : v))
      : [...get().vaults, {index, name: '', owner: safe, safe, ...key, ...at}];
    store.set(KEY, JSON.stringify(vaults));
    store.set(ACTIVE, index);
    set({vaults, activeIndex: index});
    return index;
  },

  addReceived: (vault, network, signerIndex, owner) => {
    const same = (v: VaultRef) => v.vault?.toLowerCase() === vault.toLowerCase() && v.network === network;
    const existing = get().vaults.find(same);
    const index = existing?.index ?? Math.max(...get().vaults.map((v) => v.index)) + 1;
    const vaults = existing
      ? get().vaults.map((v) => (v.index === index ? {...v, signerIndex, signer: owner, owner} : v))
      : [...get().vaults, {index, name: '', owner, vault, network, signerIndex, signer: owner}];
    store.set(KEY, JSON.stringify(vaults));
    set({vaults});
    return index;
  },

  remove: (index) => {
    const vaults = get().vaults.filter((v) => v.index !== index);
    if (vaults.length === 0) return;
    store.set(KEY, JSON.stringify(vaults));
    const activeIndex = get().activeIndex === index ? vaults[0].index : get().activeIndex;
    store.set(ACTIVE, activeIndex);
    set({vaults, activeIndex});
  },
}));

/**
 * The BIP-44 index whose key signs for a vault: its own, or — for a Safe vault, or one received by
 * transfer — the key's that owns it on this device.
 */
export const keyIndexOf = (v: VaultRef): number => (v.safe || v.vault ? (v.signerIndex ?? 0) : v.index);

/** The label to show: what the user named it, or "Vault {n}" counting from one. */
export function vaultLabel(v: VaultRef, fallback: (n: number) => string): string {
  return v.name || fallback(v.index + 1);
}

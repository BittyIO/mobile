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
  /**
   * This entry's id on the list, and for a vault of the main phrase its BIP-44 account index too.
   * 0 is the wallet that existed before there was more than one. A vault of another phrase keeps
   * its account in `account`, since the ids are shared across phrases.
   */
  index: number;
  /**
   * The recovery phrase whose key signs for it (wallet/keyring `listPhrases`): its own key, or for a
   * Safe or received vault the key at `signerIndex`. Unset means the main phrase.
   */
  phrase?: string;
  /** The BIP-44 account index on `phrase`, for a vault created from a phrase other than the main one. */
  account?: number;
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
  /**
   * Append the next index. The caller supplies the owner it just derived, and for a phrase other
   * than the main one, which phrase and account it is.
   */
  add: (owner: `0x${string}`, key?: {phrase: string; account: number}) => number;
  /** Take every vault of `phrase` off the list (the phrase is being deleted). The last one stays. */
  removePhrase: (phrase: string) => void;
  /**
   * Append a vault owned by `safe`, signed for by this device's key: the phrase's at `signer.index`,
   * or an imported one (no index). Its index is a fresh id, like any other vault's. `at` is the
   * vault's address and chain when it is not the one the factory derives from the Safe. Adding a
   * Safe that is already here updates and selects that one instead.
   */
  addSafe: (safe: `0x${string}`, signer: {index?: number; address: `0x${string}`; phrase?: string}, at?: {vault: `0x${string}`; network: string}) => number;
  /**
   * Append a vault this device's key at `signerIndex` owns by transfer, at `vault` on `network`.
   * Adding one already listed only refreshes its key. Returns its index; does not select it.
   */
  addReceived: (vault: `0x${string}`, network: string, signerIndex: number, owner: `0x${string}`, phrase?: string) => number;
  /** Take a vault off this device's list. Nothing changes on chain. The last one stays. */
  remove: (index: number) => void;
  /** Back to the single first vault: the wallet has been deleted from this phone. */
  reset: () => void;
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

  add: (owner, key) => {
    const next = Math.max(...get().vaults.map((v) => v.index)) + 1;
    // A main-phrase vault's account is its list index, unless it says otherwise (its first account,
    // added back after it was taken off the list).
    const extra = !key ? {} : key.phrase !== MAIN ? {phrase: key.phrase, account: key.account} : key.account !== next ? {account: key.account} : {};
    const vaults = [...get().vaults, {index: next, name: '', owner, ...extra}];
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
        ? {signer: signer.address, imported: true, signerIndex: undefined, phrase: undefined}
        : {signer: signer.address, signerIndex: signer.index, imported: undefined, phrase: signer.phrase && signer.phrase !== MAIN ? signer.phrase : undefined};
    const vaults = existing
      ? get().vaults.map((v) => (v.index === index ? {...v, ...key, ...at} : v))
      : [...get().vaults, {index, name: '', owner: safe, safe, ...key, ...at}];
    store.set(KEY, JSON.stringify(vaults));
    store.set(ACTIVE, index);
    set({vaults, activeIndex: index});
    return index;
  },

  addReceived: (vault, network, signerIndex, owner, phrase) => {
    const ph = phrase && phrase !== MAIN ? {phrase} : {phrase: undefined};
    const same = (v: VaultRef) => v.vault?.toLowerCase() === vault.toLowerCase() && v.network === network;
    const existing = get().vaults.find(same);
    const index = existing?.index ?? Math.max(...get().vaults.map((v) => v.index)) + 1;
    const vaults = existing
      ? get().vaults.map((v) => (v.index === index ? {...v, signerIndex, signer: owner, owner, ...ph} : v))
      : [...get().vaults, {index, name: '', owner, vault, network, signerIndex, signer: owner, ...ph}];
    store.set(KEY, JSON.stringify(vaults));
    set({vaults});
    return index;
  },

  removePhrase: (phrase) => {
    const vaults = get().vaults.filter((v) => v.imported || phraseOf(v) !== phrase);
    if (vaults.length === 0) return;
    store.set(KEY, JSON.stringify(vaults));
    const activeIndex = vaults.some((v) => v.index === get().activeIndex) ? get().activeIndex : vaults[0].index;
    store.set(ACTIVE, activeIndex);
    set({vaults, activeIndex});
  },

  reset: () => {
    store.delete(KEY);
    store.set(ACTIVE, 0);
    set({vaults: load(), activeIndex: 0});
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
export const keyIndexOf = (v: VaultRef): number => (v.safe || v.vault ? (v.signerIndex ?? 0) : (v.account ?? v.index));

/** The main phrase's id (wallet/keyring MAIN_PHRASE), repeated here so the store needs no keyring. */
const MAIN = 'main';

/** The recovery phrase a vault's key comes from. */
export const phraseOf = (v: VaultRef): string => v.phrase ?? MAIN;

/** The next unused account of `phrase`: one past the highest any of its vaults uses. */
export function nextAccountOf(vaults: VaultRef[], phrase: string): number {
  const used = vaults.filter((v) => !v.imported && phraseOf(v) === phrase).map(keyIndexOf);
  return used.length ? Math.max(...used) + 1 : 0;
}

/** The section a vault is counted in: its phrase, or for a Safe signed by an imported key, those keys. */
const sectionOf = (v: VaultRef): string => (v.imported ? 'imported' : phraseOf(v));
/** A vault the phrase's key owns because the factory derives it from that key (not a Safe, not received). */
const isCreated = (v: VaultRef) => !v.safe && !v.vault;

/**
 * Which vault of its recovery phrase this is, counting from one: each phrase numbers its own.
 *
 * A vault the phrase's key created is its account plus one — Vault 1 is account 0, whatever else the
 * phone holds, so the number is the same on every phone the phrase is restored to. A Safe or
 * received vault has no account of its own; those come after the phrase's created vaults, in the
 * order they were added.
 */
export function vaultNumber(v: VaultRef, vaults: VaultRef[] = useVaults.getState().vaults): number {
  if (isCreated(v) && !v.imported) return keyIndexOf(v) + 1;
  const section = vaults.filter((x) => sectionOf(x) === sectionOf(v));
  const created = section.filter((x) => isCreated(x) && !x.imported).map(keyIndexOf);
  const base = created.length ? Math.max(...created) + 1 : 0;
  const others = section.filter((x) => !(isCreated(x) && !x.imported));
  return base + others.findIndex((x) => x.index === v.index) + 1;
}

/**
 * The number the next vault added to `section` (a phrase id, or 'imported') would get, plus
 * `ahead` already promised to others: for naming vaults the list offers before they are added.
 */
export function nextNumberOf(vaults: VaultRef[], section: string, ahead = 0): number {
  const nums = vaults.filter((x) => sectionOf(x) === section).map((x) => vaultNumber(x, vaults));
  return (nums.length ? Math.max(...nums) : 0) + 1 + ahead;
}

/** The label to show: what the user named it, or "Vault {n}", numbered within its phrase. */
export function vaultLabel(v: VaultRef, fallback: (n: number) => string, vaults?: VaultRef[]): string {
  return v.name || fallback(vaultNumber(v, vaults));
}

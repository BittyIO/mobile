/**
 * Wallet session state (zustand) for the EMBEDDED keyring. The private key lives in the Keychain (see
 * ./keyring); the in-memory {@link HDAccount} is dropped on lock. The public address is cached (MMKV) so
 * the locked UI knows "who am I" without a biometric prompt. The mnemonic is NEVER in here.
 *
 * A write re-reads the key from the Keychain (see {@link WalletState.signer}), so every fund-moving
 * action is individually Face-ID / passcode gated — a single unlock doesn't authorize everything after.
 */
import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {LocalAccount} from 'viem';
import type {HDAccount} from 'viem/accounts';
import type {Signer} from './signer';
import * as keyring from './keyring';
import {learnKeys, vaultSigner} from './rotation';
import {keyIndexOf, phraseOf, useVaults, type VaultRef} from '@/core/vault-store';
import {activeVaultAddress} from '@/core/active-vault';
import {walletAddressOf} from '@/core/account-mode';
import {useNetwork} from '@/core/network-store';
import {fetchSafe, safeSigner} from '@/vault/safe';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';
import {forgetPhraseVerified, markPhraseVerified} from './phrase-backup';

const cache = new MMKV();
// The Tron wallet's cached addresses, from builds that had one: public, but nothing reads them now.
new MMKV({id: 'bitty.tron'}).clearAll();
const ADDRESS_KEY = 'address';

export type WalletStatus = 'unknown' | 'no-wallet' | 'locked' | 'unlocked';

interface WalletState {
  status: WalletStatus;
  /**
   * Why the wallet is locked: 'launch' (the app started or was never unlocked) lets the lock screen
   * start Face ID on its own; 'user' (Lock tapped in Settings) keeps it locked until the user taps
   * Unlock, otherwise the prompt would fire at once and undo the lock.
   */
  lockedBy: 'launch' | 'user';
  address: `0x${string}` | null;
  /**
   * Whether this session has been unlocked.
   *
   * Separate from {@link account} on purpose. Screens used the account's presence to mean "can
   * act", which was true while there was one vault and one owner — switching vaults has to drop
   * the account, because it belongs to the vault being left, and that silently disabled every
   * button in the app. Unlocking is a property of the session (one Keychain entry, one phrase),
   * not of the vault in front, so it is held as one.
   */
  unlocked: boolean;
  /**
   * The active vault owner's key, while unlocked and while it is still theirs.
   *
   * Never sign with this: it is dropped on a vault switch and is not re-derived until the next
   * write. {@link WalletState.signer} is the only way to get a key, and it reads the Keychain at
   * the ACTIVE index every time.
   */
  account: HDAccount | null;
  init: () => Promise<void>;
  createWallet: (mnemonic: string) => Promise<void>;
  unlock: () => Promise<void>;
  lock: () => void;
  wipe: () => Promise<void>;
  /** A fresh signer for a WRITE — re-read from the Keychain so every action is biometric-gated. */
  signer: () => Promise<Signer>;
  /**
   * The key itself, for a WRITE in wallet mode (see core/account-mode): the entry's own account
   * key, or its imported key — never a one-time key the vault was handed to, and never a Safe.
   * Biometric-gated like {signer}.
   */
  walletSigner: () => Promise<LocalAccount>;
  /** Put another vault in front. Free: its owner address was cached when it was added. */
  selectVault: (index: number) => void;
  /**
   * Keep another recovery phrase on this phone and put its first vault in front. A phrase already
   * here is not added again: its first vault is chosen instead, and `existing` says so.
   */
  addPhrase: (mnemonic: string) => Promise<{id: string; existing: boolean}>;
  /** Keep a private key on this phone behind Face ID and put the vault it owns in front. */
  importKey: (key: `0x${string}`) => Promise<void>;
  /** Delete an imported private key from this phone, with every vault it signs for on the list. */
  removeKey: (address: `0x${string}`) => Promise<void>;
  /**
   * Delete a recovery phrase from this phone, with every vault of it on the list. The last phrase
   * takes the wallet with it (back to onboarding). Nothing changes on chain.
   */
  removePhrase: (id: string) => Promise<void>;
}

/** The vault in front, if the list has it. */
const activeVault = () => {
  const {vaults, activeIndex} = useVaults.getState();
  return vaults.find((v) => v.index === activeIndex);
};

/**
 * The vault owner's address for the vault in front, given the key just derived for it: that key's
 * address — or, for a vault owned by a Safe, the Safe, which the key is merely one owner of.
 */
const ownerFor = (account: HDAccount): `0x${string}` => activeVault()?.safe ?? account.address;

/**
 * Cache the address of the vault in front, and record it against that vault.
 *
 * The locked UI needs "who am I" without a prompt, and switching vaults needs the next owner's
 * address without one either — so every address this app derives is kept, and the key is not.
 * A Safe vault's owner is the Safe and was recorded when it was added; the key derived for it is a
 * co-owner's and must not overwrite that.
 */
function remember(account: HDAccount) {
  cache.set(ADDRESS_KEY, ownerFor(account));
  if (activeVault()?.safe) return;
  const {activeIndex, setOwner} = useVaults.getState();
  setOwner(activeIndex, account.address);
}

/**
 * The BIP-44 index whose key signs for the vault in front. Every derivation goes through this: the
 * vault's own index, or for a Safe vault the index of this device's key among the Safe's owners.
 */
const active = () => {
  const v = activeVault();
  return v ? keyIndexOf(v) : useVaults.getState().activeIndex;
};

/** The recovery phrase whose key signs for the vault in front. */
const activePhrase = () => {
  const v = activeVault();
  return v ? phraseOf(v) : keyring.MAIN_PHRASE;
};

/** The phrase as rotation-store keys it: unset for the main one. */
const rotationPhrase = (id: string) => (id === keyring.MAIN_PHRASE ? undefined : id);

/**
 * This phone's key among a Safe vault's owners, behind Face ID: the key imported for it, or the
 * phrase's account at its `signerIndex`. Null if cancelled.
 */
export async function safeDeviceKey(v: VaultRef): Promise<LocalAccount | null> {
  if (v.imported && v.signer) return keyring.unlockImported(v.signer);
  return keyring.unlock(v.signerIndex ?? 0, phraseOf(v));
}

export const useWallet = create<WalletState>((set) => ({
  status: 'unknown',
  lockedBy: 'launch',
  unlocked: false,
  address: (cache.getString(ADDRESS_KEY) as `0x${string}` | undefined) ?? null,
  account: null,

  init: async () => {
    const exists = await keyring.hasWallet();
    set({status: exists ? 'locked' : 'no-wallet', lockedBy: 'launch'});
  },

  createWallet: async (mnemonic: string) => {
    const account = await keyring.createWallet(mnemonic);
    remember(account);
    set({account, address: account.address, status: 'unlocked', unlocked: true});
  },

  unlock: async () => {
    // A vault an imported private key owns: Face ID opens that key, there is no phrase to read.
    const front = activeVault();
    if (front?.imported && !front.safe) {
      const key = front.signer ?? front.owner;
      const account = key ? await keyring.unlockImported(key) : null;
      if (!account) return;
      set({account: null, address: front.owner, status: 'unlocked', unlocked: true});
      return;
    }
    const phrase = activePhrase();
    const root = await keyring.unlockRoot(phrase);
    if (!root) return;
    const account = keyring.accountAt(root, active());
    remember(account);
    if (phrase === keyring.MAIN_PHRASE) keyring.recordMainPhrase(keyring.accountAt(root, 0).address);
    set({account, address: ownerFor(account), status: 'unlocked', unlocked: true});
    // So a vault already handed to one of this phrase's one-time keys reads as this phone's own.
    // Only this phrase's: another phrase's keys would need its own Face ID prompt.
    const mine = useVaults.getState().vaults.filter((v) => !v.safe && !v.imported && phraseOf(v) === phrase);
    learnKeys(root, mine.map(keyIndexOf), rotationPhrase(phrase));
  },

  lock: () => set({account: null, unlocked: false, status: 'locked', lockedBy: 'user'}),

  wipe: async () => {
    const phrases = keyring.listPhrases();
    await keyring.wipe();
    cache.delete(ADDRESS_KEY);
    forgetPhraseVerified();
    for (const p of phrases) forgetPhraseVerified(p.id);
    // Every vault on the list was one of the phrases' or keys' just deleted.
    useVaults.getState().reset();
    set({account: null, unlocked: false, address: null, status: 'no-wallet'});
  },

  walletSigner: async () => {
    const ref = activeVault();
    const wallet = walletAddressOf(ref);
    if (!ref || !wallet) throw new Error('No key for this smart wallet');
    if (ref.imported) {
      const account = await keyring.unlockImported(wallet);
      if (!account) throw new Error('Unlock cancelled');
      return account;
    }
    const root = await keyring.unlockRoot(activePhrase());
    if (!root) throw new Error('Unlock cancelled');
    // The account key at this entry's index (signerIndex for a received vault): never a one-time key.
    const account = keyring.accountAt(root, active());
    // What the page showed is what signs, or nothing does.
    if (account.address.toLowerCase() !== wallet.toLowerCase()) throw new Error('This phone’s key does not match the wallet on screen');
    return account;
  },

  signer: async () => {
    const ref = activeVault();
    const safe = ref?.safe;
    const network = useNetwork.getState().network;
    if (!safe && ref?.imported) {
      // Owned by an imported private key: that key signs. It has no one-time keys to hand the
      // vault on to, so quantum-safe keys do not apply (Security hides them for it).
      const key = ref.signer ?? ref.owner;
      const account = key ? await keyring.unlockImported(key) : null;
      if (!account) throw new Error('Unlock cancelled');
      return account;
    }
    if (!safe) {
      // The ACTIVE index, not index 0: a write must be signed by the owner of the vault on screen.
      const phrase = activePhrase();
      const root = await keyring.unlockRoot(phrase);
      if (!root) throw new Error('Unlock cancelled');
      // Whichever of this account's keys owns the vault now: on quantum-safe keys, that is the
      // one-time key it was last handed, not the account's own (see ./rotation).
      const vault = activeVaultAddress(network);
      return vault
        ? vaultSigner({root, index: active(), network, vault, phrase: rotationPhrase(phrase)})
        : keyring.accountAt(root, active());
    }
    const account = await safeDeviceKey(ref);
    if (!account) throw new Error('Unlock cancelled');
    // A Safe vault signs as the Safe. Its owners and threshold are read now, for this operation:
    // they can change on chain at any time, and a key that has been removed must not sign.
    const info = await fetchSafe(network, safe);
    const t = (key: string, params?: Record<string, string | number>) => translate(useLanguage.getState().language, key, params);
    if (!info.supported) throw new Error(t('mobile.safe.unsupported', {problems: info.problems.join(', ')}));
    if (!info.owners.some((o) => o.toLowerCase() === account.address.toLowerCase())) {
      throw new Error(t('mobile.safe.not_owner', {address: account.address}));
    }
    return safeSigner({device: account, safe, network, threshold: info.threshold});
  },

  /**
   * Switch to another vault.
   *
   * Its owner address is already known — cached when the vault was added — so this is a state
   * change, not a key operation, and asks for nothing. The in-memory account is dropped: it
   * belongs to the vault we just left, and the next write will re-derive for the new one.
   */
  selectVault: (index: number) => {
    const v = useVaults.getState().vaults.find((x) => x.index === index);
    if (!v?.owner) return;
    useVaults.getState().select(index);
    cache.set(ADDRESS_KEY, v.owner);
    // The account goes, the session does not: the next write re-derives at the new index.
    set({account: null, address: v.owner});
  },

  addPhrase: async (mnemonic) => {
    const {id, account, existing} = await keyring.addPhrase(mnemonic);
    const vaults = useVaults.getState().vaults;
    const first = vaults.find((v) => !v.safe && !v.vault && phraseOf(v) === id && keyIndexOf(v) === 0);
    const index = first
      ? first.index
      : useVaults.getState().add(account.address, {phrase: id, account: 0});
    // Typed in from its backup, or generated and checked word by word: either way, proven.
    markPhraseVerified(id);
    useWallet.getState().selectVault(index);
    return {id, existing};
  },

  importKey: async (key) => {
    const address = await keyring.importPrivateKey(key);
    useWallet.getState().selectVault(useVaults.getState().addImported(address));
  },

  removeKey: async (address) => {
    const signs = (v: VaultRef) => !!v.imported && (v.signer ?? v.owner)?.toLowerCase() === address.toLowerCase();
    // Nothing else left on the phone: the wallet goes with it, as deleting the last phrase does.
    if (!useVaults.getState().vaults.some((v) => !signs(v))) {
      await useWallet.getState().wipe();
      return;
    }
    useVaults.getState().removeKey(address);
    await keyring.removeImportedKey(address);
    useWallet.getState().selectVault(useVaults.getState().activeIndex);
  },

  removePhrase: async (id) => {
    // Whatever else still holds a vault — another phrase, an imported key — stays; with nothing
    // left, the wallet goes.
    const keeps = useVaults.getState().vaults.some((v) => v.imported || phraseOf(v) !== id);
    if (!keeps) {
      await useWallet.getState().wipe();
      return;
    }
    useVaults.getState().removePhrase(id);
    await keyring.removePhrase(id);
    forgetPhraseVerified(id);
    // The vault in front may have been one of them: put the one now in front up, owner and all.
    useWallet.getState().selectVault(useVaults.getState().activeIndex);
  },
}));

/**
 * Seed the first vault's owner from the address this device already had.
 *
 * Before there was more than one vault the address was cached on its own, with no vault to file
 * it under. A device upgrading into this starts locked, so nothing would derive it again until
 * the next unlock — and until then the picker would offer the vault the user is already in as
 * un-selectable. The address is public and already on disk; this just files it.
 */
{
  const cached = cache.getString(ADDRESS_KEY) as `0x${string}` | undefined;
  const {vaults, activeIndex, setOwner} = useVaults.getState();
  if (cached && !vaults.find((v) => v.index === activeIndex)?.owner) setOwner(activeIndex, cached);
  // The main phrase's first account, for recognising it if it is imported again: the owner of its
  // first vault, already on disk, so no prompt is needed to know it.
  const first = useVaults.getState().vaults.find((v) => v.index === 0 && !v.phrase && !v.safe && !v.vault)?.owner;
  if (first) keyring.recordMainPhrase(first);
}

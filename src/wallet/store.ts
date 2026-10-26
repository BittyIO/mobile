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
import {keyIndexOf, useVaults, type VaultRef} from '@/core/vault-store';
import {activeVaultAddress} from '@/core/active-vault';
import {useNetwork} from '@/core/network-store';
import {fetchSafe, safeSigner} from '@/vault/safe';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';

const cache = new MMKV();
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
  /** Put another vault in front. Free: its owner address was cached when it was added. */
  selectVault: (index: number) => void;
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

/**
 * This phone's key among a Safe vault's owners, behind Face ID: the key imported for it, or the
 * phrase's account at its `signerIndex`. Null if cancelled.
 */
export async function safeDeviceKey(v: VaultRef): Promise<LocalAccount | null> {
  if (v.imported && v.signer) return keyring.unlockImported(v.signer);
  return keyring.unlock(v.signerIndex ?? 0);
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
    const root = await keyring.unlockRoot();
    if (!root) return;
    const account = keyring.accountAt(root, active());
    remember(account);
    set({account, address: ownerFor(account), status: 'unlocked', unlocked: true});
    // So a vault already handed to one of this phrase's one-time keys reads as this phone's own.
    learnKeys(root, useVaults.getState().vaults.filter((v) => !v.safe).map(keyIndexOf));
  },

  lock: () => set({account: null, unlocked: false, status: 'locked', lockedBy: 'user'}),

  wipe: async () => {
    await keyring.wipe();
    cache.delete(ADDRESS_KEY);
    set({account: null, unlocked: false, address: null, status: 'no-wallet'});
  },

  signer: async () => {
    const ref = activeVault();
    const safe = ref?.safe;
    const network = useNetwork.getState().network;
    if (!safe) {
      // The ACTIVE index, not index 0: a write must be signed by the owner of the vault on screen.
      const root = await keyring.unlockRoot();
      if (!root) throw new Error('Unlock cancelled');
      // Whichever of this account's keys owns the vault now: on quantum-safe keys, that is the
      // one-time key it was last handed, not the account's own (see ./rotation).
      const vault = activeVaultAddress(network);
      return vault ? vaultSigner({root, index: active(), network, vault}) : keyring.accountAt(root, active());
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
}

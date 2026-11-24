import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Address} from 'viem';
import {isTronNetwork, type Network} from '@/core/chain';
import {useNetwork} from '@/core/network-store';
import {keyIndexOf, phraseOf, useVaults, vaultNumber, type VaultRef} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';

/**
 * Which of an entry's two accounts is in front: its VAULT (the contract, which the relayer pays
 * for and the guard watches) or its WALLET (the key itself, an ordinary address that holds funds
 * and sends its own transactions, paying its own gas).
 *
 * The wallet is the entry's own key — m/44'/60'/i'/0/0, the key the vault was created from, on
 * Tron the same key as a T-address. On quantum-safe keys the vault has been handed on to one-time
 * keys and this key no longer owns it; without them it is the vault's owner too, and signing as
 * the wallet signs with the owner key.
 *
 * Per network AND entry, kept on the phone; unset follows {useDefaultAccount}, the kind last
 * switched to (the general wallet until the first switch).
 */
export type AccountKind = 'vault' | 'wallet';

const store = new MMKV({id: 'bitty.account-mode'});
/**
 * Keyed by the WALLET's address, not the list entry: one key can stand behind two entries — its own
 * vault, and a vault it was handed by transfer — and it is one wallet either way.
 */
const keyOf = (network: string, wallet: string) => `${network}:${wallet.toLowerCase()}`;

/**
 * Which account every wallet opens on: the general wallet (the key's own address) at first, then
 * whichever the user last switched to on Overview. App-wide, every network alike.
 */
const defaultStore = new MMKV({id: 'bitty.default-account'});
const DEFAULT_KEY = 'kind';

export const useDefaultAccount = create<{kind: AccountKind; set: (kind: AccountKind) => void}>((set) => ({
  kind: defaultStore.getString(DEFAULT_KEY) === 'vault' ? 'vault' : 'wallet',
  set: (kind) => {
    defaultStore.set(DEFAULT_KEY, kind);
    // A new default is the answer for every wallet: the switch's earlier per-wallet picks go, so the
    // choice shows at once rather than only on wallets never switched.
    useAccountModes.getState().clear();
    set({kind});
  },
}));

type State = {
  modes: Record<string, AccountKind>;
  set: (network: Network, wallet: Address, kind: AccountKind) => void;
  clear: () => void;
};

function load(): Record<string, AccountKind> {
  const out: Record<string, AccountKind> = {};
  for (const k of store.getAllKeys()) {
    const v = store.getString(k);
    if (v === 'vault' || v === 'wallet') out[k] = v;
  }
  return out;
}

export const useAccountModes = create<State>((set, get) => ({
  modes: load(),
  set: (network, wallet, kind) => {
    const key = keyOf(network, wallet);
    store.set(key, kind);
    set({modes: {...get().modes, [key]: kind}});
  },
  clear: () => {
    store.clearAll();
    set({modes: {}});
  },
}));

/**
 * Wallets taken off this phone's Choose wallet list (by address, lowercase). Only the list: the key,
 * its money and its vault are untouched, and a hidden wallet comes back from ⋯ › Hidden wallets. A
 * hidden wallet is not offered by the vault / wallet switch either — it is not on the phone's list.
 */
const hiddenStore = new MMKV({id: 'bitty.hidden-wallets'});
const HIDDEN = 'hidden';

function loadHidden(): string[] {
  try {
    return JSON.parse(hiddenStore.getString(HIDDEN) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export const useHiddenWallets = create<{
  hidden: string[];
  hide: (wallet: Address) => void;
  restore: (wallet: Address) => void;
}>((set, get) => ({
  hidden: loadHidden(),
  hide: (wallet) => {
    const hidden = [...new Set([...get().hidden, wallet.toLowerCase()])];
    hiddenStore.set(HIDDEN, JSON.stringify(hidden));
    set({hidden});
  },
  restore: (wallet) => {
    const hidden = get().hidden.filter((a) => a !== wallet.toLowerCase());
    hiddenStore.set(HIDDEN, JSON.stringify(hidden));
    set({hidden});
  },
}));

/**
 * The entry's wallet: the key that signs for it, as an ordinary address — or null when there is
 * none of its own to be one.
 *
 * A Safe vault's "owner" is the Safe, a contract with no transactions of its own: no wallet. Any
 * other entry's key is one:
 *  - its own vault's: a phrase's account key (m/44'/60'/i'/0/0), or an imported key;
 *  - a vault received by transfer: the key it was handed to. For a phrase's key that is the
 *    account at `signerIndex`, whose own address is cached on that account's own entry — the key
 *    the received entry stores may be a one-time key of it (wallet/rotation), which is not a wallet.
 */
export function walletAddressOf(v: VaultRef | undefined, vaults: VaultRef[] = useVaults.getState().vaults): Address | null {
  if (!v || v.safe) return null;
  if (v.imported) return v.signer ?? v.owner ?? null;
  if (!v.vault) return v.owner ?? null;
  const own = vaults.find((x) => !x.safe && !x.vault && !x.imported && phraseOf(x) === phraseOf(v) && keyIndexOf(x) === keyIndexOf(v) && x.owner);
  return own?.owner ?? null;
}

/**
 * The wallet's number, for "Wallet 2": a phrase's key is its account plus one — the same number its
 * own vault has, on every phone the phrase is restored to; an imported key takes its entry's.
 */
export function walletNumber(v: VaultRef, vaults: VaultRef[] = useVaults.getState().vaults): number {
  return v.imported ? vaultNumber(v, vaults) : keyIndexOf(v) + 1;
}

const activeRef = (s: ReturnType<typeof useVaults.getState>) => s.vaults.find((v) => v.index === s.activeIndex);

/** The kind in front for `v` on `network`: what was chosen, or the chain's default — never a wallet it has not got. */
function kindFor(wallet: Address | null, network: Network, modes: Record<string, AccountKind>, fallback: AccountKind): AccountKind {
  // Tron has the general wallet only.
  if (isTronNetwork(network)) return 'wallet';
  if (!wallet) return 'vault';
  return modes[keyOf(network, wallet)] ?? fallback;
}

export type ActiveAccount = {
  kind: AccountKind;
  /** The address the page is about: the vault's, or the wallet's. Null while it is not known yet. */
  address: Address | null;
  vault: Address | null;
  wallet: Address | null;
  /** The entry has both, so the switch is offered. */
  canSwitch: boolean;
};

function accountOf(
  v: VaultRef | undefined,
  vaults: VaultRef[],
  network: Network,
  modes: Record<string, AccountKind>,
  hidden: string[],
  fallback: AccountKind,
): ActiveAccount {
  const vault = vaultAddressOf(v, network);
  const key = walletAddressOf(v, vaults);
  const wallet = key && !hidden.includes(key.toLowerCase()) ? key : null;
  const kind = kindFor(wallet, network, modes, fallback);
  return {kind, address: kind === 'wallet' ? wallet : vault, vault, wallet, canSwitch: !!wallet && !isTronNetwork(network)};
}

/** The account in front on `network`, read now — for code that is not a component. */
export function activeAccount(network: Network = useNetwork.getState().network): ActiveAccount {
  const s = useVaults.getState();
  return accountOf(activeRef(s), s.vaults, network, useAccountModes.getState().modes, useHiddenWallets.getState().hidden, useDefaultAccount.getState().kind);
}

/** The account in front on `network`, as a subscription. */
export function useActiveAccount(network: Network): ActiveAccount {
  const v = useVaults(activeRef);
  const vaults = useVaults((s) => s.vaults);
  const modes = useAccountModes((s) => s.modes);
  const hidden = useHiddenWallets((s) => s.hidden);
  const fallback = useDefaultAccount((s) => s.kind);
  return accountOf(v, vaults, network, modes, hidden, fallback);
}

/** Wallet mode in front on `network`: the switch every vault-only screen and action checks. */
export const useWalletMode = (network: Network): boolean => useActiveAccount(network).kind === 'wallet';
export const walletMode = (network: Network = useNetwork.getState().network): boolean => activeAccount(network).kind === 'wallet';

/**
 * Flip the entry in front between its vault and its wallet on `network`. The choice becomes the
 * default for every wallet (see {useDefaultAccount}).
 */
export function toggleAccount(network: Network): AccountKind {
  const {kind: now, wallet} = activeAccount(network);
  if (!wallet) return now;
  const next: AccountKind = now === 'wallet' ? 'vault' : 'wallet';
  // The choice is the app's, not this wallet's: every wallet opens on what was last switched to.
  useDefaultAccount.getState().set(next);
  return next;
}

/**
 * Whether `address` is a WALLET on this phone (a key's own address) rather than a vault: what the
 * position and queue readers ask, since the same screens read either. A key's address and a vault's
 * never coincide.
 */
export function isWalletAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  const vaults = useVaults.getState().vaults;
  return vaults.some((v) => walletAddressOf(v, vaults)?.toLowerCase() === a);
}

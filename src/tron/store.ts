/**
 * This phone's Tron wallets, cached so the wallet screens can show them — and read their balances —
 * without asking for Face ID. Public, like the vault owner addresses the wallet store caches; the
 * key is derived again, behind Face ID, for every send.
 *
 * One phrase, several wallets, as the vaults are: each is a BIP-44 account of Tron's coin type
 * (m/44'/195'/{index}'/0/0, see ./address), so the phrase restores every one and nothing new has to
 * be written down. A wallet is therefore an index plus whatever the user called it.
 *
 * Filled whenever the phrase's root key is in hand anyway: creating or restoring the wallet, and
 * unlocking it. A phone that was unlocked before Tron existed has none until its next unlock, and
 * the wallet screen offers to work it out.
 */
import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {HDKey} from 'viem/accounts';
import {tronAccountAt} from './address';

const store = new MMKV({id: 'bitty.tron'});
/** The single address of the build before there was more than one wallet: account 0's. */
const LEGACY = 'address';
const WALLETS = 'wallets';
const ACTIVE = 'active';

export type TronWalletRef = {
  /** BIP-44 account index. 0 is the wallet that existed before there was more than one. */
  index: number;
  /** The user's name for it; empty for the default "Wallet {n}". */
  name: string;
  address: string;
};

type TronWalletState = {
  wallets: TronWalletRef[];
  activeIndex: number;
  /** The wallet in front's address — what every Tron screen reads, signs for and shows. */
  address: string | null;
};

function load(): {wallets: TronWalletRef[]; activeIndex: number} {
  let wallets: TronWalletRef[] = [];
  try {
    wallets = JSON.parse(store.getString(WALLETS) ?? '[]') as TronWalletRef[];
  } catch {
    wallets = [];
  }
  // A phone from before the list: its one address is account 0's.
  const legacy = store.getString(LEGACY);
  if (!wallets.length && legacy) wallets = [{index: 0, name: '', address: legacy}];
  const stored = store.getNumber(ACTIVE);
  const activeIndex = wallets.some((w) => w.index === stored) ? (stored as number) : (wallets[0]?.index ?? 0);
  return {wallets, activeIndex};
}

const addressOf = (wallets: TronWalletRef[], index: number) => wallets.find((w) => w.index === index)?.address ?? null;

const initial = load();
export const useTronWallet = create<TronWalletState>(() => ({...initial, address: addressOf(initial.wallets, initial.activeIndex)}));

function save(wallets: TronWalletRef[], activeIndex: number) {
  store.set(WALLETS, JSON.stringify(wallets));
  store.set(ACTIVE, activeIndex);
  // Kept for a build rolled back to before the list: it reads account 0's address here.
  const first = addressOf(wallets, 0);
  if (first) store.set(LEGACY, first);
  useTronWallet.setState({wallets, activeIndex, address: addressOf(wallets, activeIndex)});
}

/** The wallet's name as shown: the user's, or "Wallet {n}" counting from 1. */
export const tronWalletLabel = (w: TronWalletRef, numbered: (n: number) => string) => w.name || numbered(w.index + 1);

/**
 * Derive and cache the address of every wallet of the phrase whose root this is (account 0 when
 * there are none yet). Returns the wallet in front's address.
 */
export function rememberTronAddress(root: HDKey): string {
  const {wallets, activeIndex} = useTronWallet.getState();
  const indexes = wallets.length ? wallets.map((w) => w.index) : [0];
  const next = indexes.map((index) => {
    const {address, privateKey} = tronAccountAt(root, index);
    privateKey.fill(0);
    return {index, name: wallets.find((w) => w.index === index)?.name ?? '', address};
  });
  save(next, next.some((w) => w.index === activeIndex) ? activeIndex : next[0].index);
  return addressOf(next, useTronWallet.getState().activeIndex)!;
}

/** Add the phrase's next Tron account and put it in front. Returns its address. */
export function addTronWallet(root: HDKey): string {
  const {wallets} = useTronWallet.getState();
  const index = wallets.length ? Math.max(...wallets.map((w) => w.index)) + 1 : 0;
  const {address, privateKey} = tronAccountAt(root, index);
  privateKey.fill(0);
  save([...wallets, {index, name: '', address}], index);
  return address;
}

export function selectTronWallet(index: number): void {
  const {wallets} = useTronWallet.getState();
  if (wallets.some((w) => w.index === index)) save(wallets, index);
}

export function renameTronWallet(index: number, name: string): void {
  const {wallets, activeIndex} = useTronWallet.getState();
  save(
    wallets.map((w) => (w.index === index ? {...w, name: name.trim()} : w)),
    activeIndex,
  );
}

/**
 * The account index that signs for `address`: the one it was derived at. 0 for an address this
 * phone does not list, so a signer's own check (the derived address must be the one shown) refuses it.
 */
export function tronIndexOf(address: string): number {
  return useTronWallet.getState().wallets.find((w) => w.address === address)?.index ?? 0;
}

/** Forget them: the wallet was wiped from this phone. */
export function forgetTronAddress(): void {
  store.delete(LEGACY);
  store.delete(WALLETS);
  store.delete(ACTIVE);
  useTronWallet.setState({wallets: [], activeIndex: 0, address: null});
}

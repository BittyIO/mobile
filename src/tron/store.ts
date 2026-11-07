/**
 * This phone's Tron address, cached so the wallet screen can show it — and read its balance —
 * without asking for Face ID. Public, like the vault owner address the wallet store caches; the
 * key is derived again, behind Face ID, for every send.
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
const KEY = 'address';

type TronWalletState = {address: string | null};

export const useTronWallet = create<TronWalletState>(() => ({address: store.getString(KEY) ?? null}));

/** Derive and cache the Tron address of the phrase whose root this is. */
export function rememberTronAddress(root: HDKey): string {
  const {address, privateKey} = tronAccountAt(root);
  privateKey.fill(0);
  store.set(KEY, address);
  useTronWallet.setState({address});
  return address;
}

/** Forget it: the wallet was wiped from this phone. */
export function forgetTronAddress(): void {
  store.delete(KEY);
  useTronWallet.setState({address: null});
}

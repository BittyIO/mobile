import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

/**
 * What this phone remembers about quantum-safe keys (see ./rotation): which vaults use them, which
 * addresses are one-time keys of this phrase, which next one to hand out, and which keys have signed.
 *
 * All of it is public or local bookkeeping — addresses, never keys — so it is readable without Face
 * ID, which is what lets the Security pages and the vault list recognise the vault's current owner
 * as this phone's own key. Lost with the app; ./rotation finds it all again from the phrase and the
 * chain, so a restore loses nothing but the record of what signed (the chain is checked as well).
 */
const store = new MMKV({id: 'bitty.rotation'});

const onKey = (network: string, vault: string) => `on.${network}:${vault.toLowerCase()}`;
const KEYS = 'keys';
const USED = 'used';
const nextKey = (index: number) => `next.${index}`;

/** A one-time key's place in the phrase: account `index`, key `k` (m/44'/60'/index'/1/k). */
export type KeyPath = {index: number; k: number};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = store.getString(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

type State = {
  /** `${network}:${vault}` → on. */
  on: Record<string, boolean>;
  /** Lower-cased address → where it is in the phrase. */
  keys: Record<string, KeyPath>;
  /** Lower-cased addresses this phone has signed anything with. */
  used: Record<string, true>;
};

export const useRotationStore = create<State>(() => ({
  on: Object.fromEntries(
    store
      .getAllKeys()
      .filter((k) => k.startsWith('on.'))
      .map((k) => [k.slice(3), store.getBoolean(k) ?? false]),
  ),
  keys: readJson<Record<string, KeyPath>>(KEYS, {}),
  used: Object.fromEntries(readJson<string[]>(USED, []).map((a) => [a, true as const])),
}));

/** Whether this vault, on this network, hands itself to a fresh key after every operation. */
export function rotationOn(network: string, vault: string | null | undefined): boolean {
  return !!vault && !!useRotationStore.getState().on[`${network}:${vault.toLowerCase()}`];
}

export function useRotationOn(network: string, vault: string | null | undefined): boolean {
  return useRotationStore((s) => !!vault && !!s.on[`${network}:${vault.toLowerCase()}`]);
}

export function setRotationOn(network: string, vault: string, on: boolean): void {
  store.set(onKey(network, vault), on);
  useRotationStore.setState((s) => ({on: {...s.on, [`${network}:${vault.toLowerCase()}`]: on}}));
}

/** Where `address` sits in the phrase, if it is one of its one-time keys this phone has derived. */
export function keyPathOf(address: string | null | undefined): KeyPath | null {
  return address ? (useRotationStore.getState().keys[address.toLowerCase()] ?? null) : null;
}

/** Record one-time keys just derived, so they are recognised without the phrase from now on. */
export function rememberKeys(entries: {address: string; index: number; k: number}[]): void {
  if (entries.length === 0) return;
  const keys = {...useRotationStore.getState().keys};
  for (const e of entries) keys[e.address.toLowerCase()] = {index: e.index, k: e.k};
  store.set(KEYS, JSON.stringify(keys));
  useRotationStore.setState({keys});
}

/**
 * The next one-time key of account `index` to hand out. Only ever moves forward: a key is handed
 * out once, whether or not the handover it was picked for went through, so no two vaults — or the
 * same vault on two chains — can ever be given the same key.
 */
export function nextKeyOf(index: number): number {
  return store.getNumber(nextKey(index)) ?? 0;
}

export function bumpNextKey(index: number, atLeast: number): void {
  if (atLeast > nextKeyOf(index)) store.set(nextKey(index), atLeast);
}

/** Whether this phone has signed anything with `address`: once it has, its public key is out. */
export function wasUsed(address: string): boolean {
  return !!useRotationStore.getState().used[address.toLowerCase()];
}

export function markUsed(address: string): void {
  const a = address.toLowerCase();
  if (useRotationStore.getState().used[a]) return;
  const used = {...useRotationStore.getState().used, [a]: true as const};
  store.set(USED, JSON.stringify(Object.keys(used)));
  useRotationStore.setState({used});
}

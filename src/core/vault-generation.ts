import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import type {ProtocolCategory} from '@/core/protocols';

/**
 * Which vault GENERATION the app talks to.
 *
 * Two deployments live side by side and share nothing but the vault bootstrap:
 *  - `v1.0.0` — the new vault repo. Its own guard, forwarder and factory, the three-number risk
 *    surface with locks, permission-masked asset managers. Its versions start again at 1.0.0.
 *  - `v1.0.3` — the original generation, kept working for the vaults already on it. The old guard's
 *    latest implementation is 1.0.3 on every chain; nothing newer ever shipped there.
 *
 * The version a vault reports cannot tell them apart — the new one says 1.0.0, which is BELOW the
 * old one's 1.0.3 — so every place that picks an ABI asks {isLegacy} instead of comparing numbers.
 */
export type VaultGeneration = 'v1.0.0' | 'v1.0.3';

export type GenerationConfig = {
  label: string;
  /** The `version` the server resolves this generation's factory and catalog by. */
  apiVersion: string;
  guard: Address;
  /**
   * The vault factory. One address on every chain: an ERC1967 proxy CREATE2'd at salt 0 over a
   * constant factory bootstrap, so it is a function of the bootstrap alone.
   */
  factory: Address;
  /** The constant implementation every vault proxy is born on. Fixes the vault's address. */
  bootstrap: Address;
  /** The guard's uint8 protocol category → the app's name for it. The new guard swapped 1 and 2. */
  protocolCategories: Record<number, ProtocolCategory>;
};

export const GENERATIONS: Record<VaultGeneration, GenerationConfig> = {
  'v1.0.0': {
    label: 'v1.0.0',
    apiVersion: 'v2',
    guard: '0x000000000F5fcD35885BfE4c700042cE7cb39554',
    // CREATE2(0x4e59…956C, salt 0, ERC1967Proxy ++ (factory bootstrap 0x2287De18…653f, "")). Not
    // deployed yet at the time of writing.
    factory: '0x3d7Ed3cD011B423dd11BE280BF926667CAf0F120',
    bootstrap: '0x06dBcce6A83230B1Ea281F449f960c8F7124cc72',
    protocolCategories: {1: 'staking', 2: 'lending', 3: 'amm', 4: 'intent'},
  },
  'v1.0.3': {
    label: 'v1.0.3',
    // The web and server have always called this generation "v1.0.0".
    apiVersion: 'v1.0.0',
    guard: '0x00006Dc0000DBB00d9bd462ad2005E20007e0Dc7',
    factory: '0xCe9c32Bf9720027EE0137153A3C5BC803570DCbf',
    bootstrap: '0x06dBcce6A83230B1Ea281F449f960c8F7124cc72',
    protocolCategories: {1: 'lending', 2: 'staking', 3: 'amm', 4: 'intent'},
  },
};

export const VAULT_GENERATIONS: VaultGeneration[] = ['v1.0.0', 'v1.0.3'];

/**
 * Guard categories the app reads past: 5 is market maker (concentrated liquidity). The app provides
 * no liquidity, so those adapters are neither services to offer nor venues to route to — dropped
 * from the guard catalog rather than shown as unknown.
 */
export const IGNORED_GUARD_CATEGORIES: ReadonlySet<number> = new Set([5]);

/**
 * Where an install starts: on the generation its vaults are already on. The new factory is not
 * deployed yet, and defaulting to it would show every existing user an empty vault at a new address.
 */
const DEFAULT_GENERATION: VaultGeneration = 'v1.0.3';

const store = new MMKV({id: 'bitty.vaultGeneration'});
const KEY = 'generation';

const saved = store.getString(KEY);

type GenerationState = {
  generation: VaultGeneration;
  setGeneration: (g: VaultGeneration) => void;
};

export const useVaultGeneration = create<GenerationState>((set) => ({
  generation: saved && saved in GENERATIONS ? (saved as VaultGeneration) : DEFAULT_GENERATION,
  setGeneration: (generation) => {
    store.set(KEY, generation);
    set({generation});
  },
}));

/** The active generation's config, for code that is not a component. */
export const generationConfig = (): GenerationConfig => GENERATIONS[useVaultGeneration.getState().generation];

/** The original generation: every vault on it runs the v1.0.3 ABI. */
export const isLegacy = (): boolean => useVaultGeneration.getState().generation === 'v1.0.3';

/** A cache key that is per network AND per generation — the two guards answer differently. */
export const generationKey = (network: Network): string => `${useVaultGeneration.getState().generation}:${network}`;

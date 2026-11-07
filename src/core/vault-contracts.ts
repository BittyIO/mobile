import type {Address} from 'viem';
import type {ProtocolCategory} from '@/core/protocols';

/**
 * The vault deployment the app talks to: the vault repo's guard, factory and bootstrap. The same
 * addresses on every chain.
 */

/** The `version` the server resolves the factory and catalog by. */
export const API_VERSION = 'v2';

export const VAULT_GUARD: Address = '0x000000000F5fcD35885BfE4c700042cE7cb39554';

/**
 * The vault factory: an ERC1967 proxy CREATE2'd at salt 0 over a constant factory bootstrap, so it
 * is a function of the bootstrap alone. CREATE2(0x4e59…956C, salt 0, ERC1967Proxy ++ (factory
 * bootstrap 0x2287De18…653f, "")).
 */
export const VAULT_FACTORY: Address = '0x3d7Ed3cD011B423dd11BE280BF926667CAf0F120';

/** The constant implementation every vault proxy is born on. Fixes the vault's address. */
export const VAULT_BOOTSTRAP: Address = '0x06dBcce6A83230B1Ea281F449f960c8F7124cc72';

/** The guard's uint8 protocol category → the app's name for it. */
export const GUARD_CATEGORIES: Record<number, ProtocolCategory> = {1: 'staking', 2: 'lending', 3: 'amm', 4: 'intent'};

/**
 * Guard categories the app reads past: 5 is market maker (concentrated liquidity). The app provides
 * no liquidity, so those adapters are neither services to offer nor venues to route to — dropped
 * from the guard catalog rather than shown as unknown.
 */
export const IGNORED_GUARD_CATEGORIES: ReadonlySet<number> = new Set([5]);

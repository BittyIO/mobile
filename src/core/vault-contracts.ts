import type {Address} from 'viem';
import type {ProtocolCategory} from '@/core/protocols';

import type {Network} from '@/core/chain';

/**
 * The vault deployment the app talks to: the vault repo's guard, factory and bootstrap. The same
 * addresses on every EVM chain (they are CREATE2'd through the canonical deployer); Tron has no such
 * deployer, so each Tron network has its own set, deployed through the guard repo's
 * BittyTronCreate2Deployer (vault repo `tron/`).
 */

/** The `version` the server resolves the factory and catalog by. */
export const API_VERSION = 'v2';

/** The EVM deployment's guard (every EVM chain). Prefer {vaultGuard} — it is per network. */
export const VAULT_GUARD: Address = '0x000000000F5fcD35885BfE4c700042cE7cb39554';

/**
 * The vault factory: an ERC1967 proxy CREATE2'd at salt 0 over a constant factory bootstrap, so it
 * is a function of the bootstrap alone. CREATE2(0x4e59…956C, salt 0, ERC1967Proxy ++ (factory
 * bootstrap 0x2287De18…653f, "")).
 */
export const VAULT_FACTORY: Address = '0x3d7Ed3cD011B423dd11BE280BF926667CAf0F120';

/** The constant implementation every vault proxy is born on. Fixes the vault's address. */
export const VAULT_BOOTSTRAP: Address = '0x06dBcce6A83230B1Ea281F449f960c8F7124cc72';

/**
 * Tron Nile's deployment (2026-11-09; guard repo `deployments/tron-nile.json`, vault repo
 * `tron/`). Base58: guard TSZjZdPbDToDMZQMzKLhYbJh35rD8C5Em7, factory
 * TESttiZpNjgUkBPs4gJohM3bmGqKbB7AkG, vault bootstrap TJ25eJsVrdTEDqGwHY7tKzoXARqTPcDpbx.
 */
const NILE = {
  guard: '0xb609AAAEbB9775Ea3037C4D3dde427498c457AD1',
  factory: '0x311D087Ca9528801ab0d85E8bb92C9C611235834',
  bootstrap: '0x584C1CB9995fF8ADF0eE1B82BF25Db7Be7c33fA8',
} as const satisfies Record<string, Address>;

export const vaultGuard = (network: Network): Address => (network === 'tron-nile' ? NILE.guard : VAULT_GUARD);
export const vaultFactory = (network: Network): Address => (network === 'tron-nile' ? NILE.factory : VAULT_FACTORY);
export const vaultBootstrap = (network: Network): Address => (network === 'tron-nile' ? NILE.bootstrap : VAULT_BOOTSTRAP);

/**
 * The vault proxy as the factory deploys it on a Tron network: the CREATE2 prefix (the TVM hashes
 * 0x41 where the EVM hashes 0xff), the hash of the proxy's init code (the factory's own
 * `_VAULT_PROXY_INITCODE_HASH`, over the Tron build's ERC1967Proxy and Nile's bootstrap), and the
 * proxy's runtime code, which is how a contract is recognised as a vault the factory made. The Tron
 * build (`FOUNDRY_PROFILE=tron`, cancun) compiles the proxy to different bytes from the EVM build,
 * so neither carries over from core/predict-vault.
 */
export const TRON_VAULT_PROXY: Partial<Record<Network, {prefix: '0x41'; initCodeHash: `0x${string}`; runtimeCode: `0x${string}`}>> = {
  'tron-nile': {
    prefix: '0x41',
    initCodeHash: '0x521894190e6b5a5cb1a1448751c8cd310390f565a3453d203b5577e99e6b4fbd',
    runtimeCode: '0x60806040525f8073ffffffffffffffffffffffffffffffffffffffff7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5416368280378136915af43d5f803e156053573d5ff35b3d5ffdfea2646970667358221220519b672690faf875676d1f0d90f46e548dab021b7c35f02a79569238faf2a7fe64736f6c63430008220033',
  },
};

/** The guard's uint8 protocol category → the app's name for it. */
export const GUARD_CATEGORIES: Record<number, ProtocolCategory> = {1: 'staking', 2: 'lending', 3: 'amm', 4: 'intent'};

/**
 * Guard categories the app reads past: 5 is market maker (concentrated liquidity). The app provides
 * no liquidity, so those adapters are neither services to offer nor venues to route to — dropped
 * from the guard catalog rather than shown as unknown.
 */
export const IGNORED_GUARD_CATEGORIES: ReadonlySet<number> = new Set([5]);

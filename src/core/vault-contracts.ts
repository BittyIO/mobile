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

/**
 * Tron mainnet's deployment (2026-11-22; guard repo `deployments/tron.json`, vault repo `tron/`),
 * checked on chain the same day. Base58: guard TXrvqX2YMe7N7Muiaxuu2Fs1smTB4sSR3n, factory
 * TH9QaqjfK9Yutk2suGzoE9sFXzYGj6y5dk, vault bootstrap TNBQVqfHEBERy8HoKDPBvukDQWArcR3hie.
 */
const TRON = {
  guard: '0xf022C72D48c2E3B81731dbA6649BF780302c0035',
  factory: '0x4eB6B569DafBe5eAB47C62F4eE14Ce2336fE291F',
  bootstrap: '0x85f018F64dE9e4A780c11beB30674b335ae2939d',
} as const satisfies Record<string, Address>;

const TRON_DEPLOYMENT: Partial<Record<Network, {guard: Address; factory: Address; bootstrap: Address}>> = {
  tron: TRON,
  'tron-nile': NILE,
};

/**
 * Bitty's auto-yield keeper (BittyV1AutoYieldKeeper): the address a vault names as its
 * autoYieldTrigger so the keeper's sweeps are accepted, per network.
 *
 * Not one address everywhere. The keeper is placed by CREATE2, so its address is a hash of its code,
 * and its code names the guard it reads its owner from. 0xC109…9cF0, the first build, reads the old
 * guard (0x00006Dc0…0Dc7), which exists on Ethereum, Base, Robinhood and Sepolia but was never
 * deployed on Arbitrum or BNB Chain: a 0xC109 there has no owner, so it can never be given a signer
 * or a forwarder (deployed on both on 2026-11-22 and confirmed so). Arbitrum and BNB Chain use the
 * later build at 0xAa5D…2e36, which reads the current guard; both were given the forwarder and a
 * signer the same day.
 *
 * Null where no keeper can sweep: Base Sepolia (no yield protocols) and Tron. A route set there names no trigger, and {setAutoYield} names one the
 * next time a route is turned on once this has an address for the network.
 */
export const AUTO_YIELD_KEEPER: Address = '0xC10981d43Fa3897911802ae3F83D605E5E249cF0';
const AUTO_YIELD_KEEPER_BY_NETWORK: Partial<Record<Network, Address | null>> = {
  arbitrum: '0xAa5D5c85CA26ab7fdB01767dF5C2Cb3fe7d52e36',
  bsc: '0xAa5D5c85CA26ab7fdB01767dF5C2Cb3fe7d52e36',
  'base-sepolia': null,
  tron: null,
  'tron-nile': null,
};
export const autoYieldKeeper = (network: Network): Address | null =>
  network in AUTO_YIELD_KEEPER_BY_NETWORK ? AUTO_YIELD_KEEPER_BY_NETWORK[network] ?? null : AUTO_YIELD_KEEPER;

export const vaultGuard = (network: Network): Address => TRON_DEPLOYMENT[network]?.guard ?? VAULT_GUARD;
export const vaultFactory = (network: Network): Address => TRON_DEPLOYMENT[network]?.factory ?? VAULT_FACTORY;
export const vaultBootstrap = (network: Network): Address => TRON_DEPLOYMENT[network]?.bootstrap ?? VAULT_BOOTSTRAP;

/**
 * The vault proxy as the factory deploys it on a Tron network: the CREATE2 prefix (the TVM hashes
 * 0x41 where the EVM hashes 0xff), the hash of the proxy's init code (the factory's own
 * `_VAULT_PROXY_INITCODE_HASH`, over the Tron build's ERC1967Proxy and that network's bootstrap), and the
 * proxy's runtime code, which is how a contract is recognised as a vault the factory made. The Tron
 * build (`FOUNDRY_PROFILE=tron`, cancun) compiles the proxy to different bytes from the EVM build,
 * so neither carries over from core/predict-vault.
 */
const TRON_PROXY_RUNTIME =
  '0x60806040525f8073ffffffffffffffffffffffffffffffffffffffff7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5416368280378136915af43d5f803e156053573d5ff35b3d5ffdfea2646970667358221220519b672690faf875676d1f0d90f46e548dab021b7c35f02a79569238faf2a7fe64736f6c63430008220033';
export const TRON_VAULT_PROXY: Partial<Record<Network, {prefix: '0x41'; initCodeHash: `0x${string}`; runtimeCode: `0x${string}`}>> = {
  // The proxy runtime is byte for byte Nile's (read off mainnet's factory proxy, the same build, on
  // 2026-11-22); the hash differs because mainnet's bootstrap address does.
  tron: {
    prefix: '0x41',
    initCodeHash: '0xa2268803d8f227cb4a2a12b068deee34869044ce8ceb1d3d6bbfdcca0a33a151',
    runtimeCode: TRON_PROXY_RUNTIME,
  },
  'tron-nile': {
    prefix: '0x41',
    initCodeHash: '0x521894190e6b5a5cb1a1448751c8cd310390f565a3453d203b5577e99e6b4fbd',
    runtimeCode: TRON_PROXY_RUNTIME,
  },
};

/** The guard's uint8 protocol category → the app's name for it. */
export const GUARD_CATEGORIES: Record<number, ProtocolCategory> = {1: 'staking', 2: 'lending', 3: 'amm', 4: 'intent', 5: 'bridge'};

/**
 * Guard categories the app reads past. None now: 5 was the market-maker adapter, which no guard lists
 * any more, and is the Across bridge on every chain (read back from each guard's protocolCategory()
 * on 2026-11-22). Dropping it hid the bridge from the allow list and from Upgrade, and left Base
 * Sepolia, whose guard runs the bridge alone, with no protocols at all.
 */
export const IGNORED_GUARD_CATEGORIES: ReadonlySet<number> = new Set();

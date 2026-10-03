import type {Address} from 'viem';
import type {Network} from '@/core/chain';

export type ProtocolCategory = 'staking' | 'lending' | 'amm' | 'intent' | 'unknown';

type ProtocolInfo = {name: string; category: ProtocolCategory};

/**
 * Display names for the known protocol adapters, keyed by lowercased address, mirroring the guard
 * catalog / web config `protocols`. Both adapter versions of one provider (e.g. Uniswap 1.0.0 & 1.0.1)
 * map to the same name. Unknown addresses fall back to a shortened address (see {@link protocolMeta}).
 * A real build resolves these from the on-chain guard catalog; vendored here until `packages/core`.
 */
const PROTOCOLS: Record<Network, Record<string, ProtocolInfo>> = {
  mainnet: {
    '0x9296f7ffe86da8b652988f07920b42f8779ce64b': {name: 'Aave V3', category: 'lending'},
    '0x35252547c41661103865d700d8fcace07afce1bd': {name: 'Lido', category: 'staking'},
    '0x0968632ad0a79220ffb2d2320de82b7c17357774': {name: 'Sky', category: 'staking'},
    // Uniswap V3 adapter 1.0.1 — the ONLY one listed here. It is what `ammAdapters` hands the
    // market swap, and only 1.0.1 carries market buy/sell: with the 1.0.0 adapter
    // (0xcE02C925…) in its place every market trade on mainnet reverted and came back from the
    // relayer as "simulation-failed". The web keeps 1.0.0 listed behind it; this app does not, so a
    // history row from a vault that traded through the old adapter names a short address instead of
    // "Uniswap V3". LP reads are unaffected — sibling adapters share one position manager.
    '0xf72ab1ca4dd4c8d5e747271e80ff2c71d129a664': {name: 'Uniswap V3', category: 'amm'},
    '0x3d7589cd35400e0a1b8d6f5f8ed3ae4171a5e195': {name: 'CoW Swap', category: 'intent'},
  },
  base: {
    '0x4b38baa01e6fd30163f4de7e678dc868045eb27f': {name: 'Aave V3', category: 'lending'},
    '0x8e14e91f29066ccdd9e9e2db6bafe6fef7c14ac6': {name: 'Sky', category: 'staking'},
    // 1.0.1 only, as on mainnet above; the 1.0.0 adapter (0x7aE75624…) is deliberately not listed.
    '0xfd30f05b9d36488631c212f0421eb9a117382fd5': {name: 'Uniswap V3', category: 'amm'},
    '0x5daa6aef7de9c13624a8fdfde47c10d35fd79b0a': {name: 'CoW Swap', category: 'intent'},
  },
  // Only the AMM adapter (Universal Router build, 1.0.2): no Aave, Sky or CoW on this chain.
  robinhood: {
    '0x2b2ecfad219fe9fd358ba196962d1536665b2041': {name: 'Uniswap V3', category: 'amm'},
  },
  sepolia: {
    '0x9c01f9b6ed7bbd86f7a309a3414595608ab9d80d': {name: 'Aave V3', category: 'lending'},
    '0x9f6d7b2defcf45cb837560209099083ddf59840a': {name: 'Lido', category: 'staking'},
    '0x88b9f0310b891f1bd00789f65d49b8331ed32a52': {name: 'Uniswap V3', category: 'amm'},
    '0xc701e8d66d2762044b34303509a2606e6b05bb73': {name: 'Uniswap V3', category: 'amm'},
    '0x5a365990111b5a460526a25a8d4493df103759df': {name: 'CoW Swap', category: 'intent'},
  },
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function protocolMeta(network: Network, address: string): ProtocolInfo {
  return (
    PROTOCOLS[network][address.toLowerCase()] ?? {
      name: short(address),
      category: 'unknown',
    }
  );
}

/** The known AMM adapter addresses for a network (both versions of Uniswap V3). */
export function ammAdapters(network: Network): Address[] {
  return Object.entries(PROTOCOLS[network])
    .filter(([, info]) => info.category === 'amm')
    .map(([addr]) => addr as Address);
}

/**
 * The protocols that settle one kind of order, by display name, deduplicated.
 *
 * Which venue a trade goes through is already written down here, once, as the adapter's category:
 * a market order is handed to the `amm` adapter and a limit or TWAP order is posted as an
 * `intent`. The Trade sheet names its venue from this rather than from a list of its own, so a
 * chain with no CoW adapter — Robinhood today — says nothing instead of promising CoW Swap.
 */
export function venueNames(network: Network, category: ProtocolCategory): string[] {
  return [...new Set(Object.values(PROTOCOLS[network]).filter((p) => p.category === category).map((p) => p.name))];
}

/** Every known adapter for a network (all categories) — for protocol allowlist management. */
export function allAdapters(
  network: Network,
): {address: Address; name: string; category: ProtocolCategory}[] {
  return Object.entries(PROTOCOLS[network]).map(([addr, info]) => ({
    address: addr as Address,
    name: info.name,
    category: info.category,
  }));
}

/** Yield adapters (staking + lending) for a network — the auto-yield route options. */
export function yieldAdapters(
  network: Network,
): {address: Address; name: string; category: ProtocolCategory}[] {
  return Object.entries(PROTOCOLS[network])
    .filter(([, info]) => info.category === 'staking' || info.category === 'lending')
    .map(([addr, info]) => ({address: addr as Address, name: info.name, category: info.category}));
}

/** Resolve a protocol adapter address by display name (e.g. "Sky", "Aave V3"). Null if unknown. */
export function adapterByName(network: Network, name: string): Address | null {
  const hit = Object.entries(PROTOCOLS[network]).find(
    ([, info]) => info.name.toLowerCase() === name.toLowerCase(),
  );
  return hit ? (hit[0] as Address) : null;
}

export type {Address};

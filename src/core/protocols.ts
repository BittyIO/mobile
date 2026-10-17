import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {shortAddress} from '@/core/format';
import {isLegacy} from '@/core/vault-generation';
import {currentGuardProtocols} from '@/core/guard-catalog';

/**
 * Guard categories, as the app names them. `amm` is the market-trade adapter (guard category 3),
 * which swaps through the Universal Router. The guard's market-maker category (5, concentrated
 * liquidity) has no name here: the app provides no liquidity, and the guard reads skip it — see
 * {IGNORED_GUARD_CATEGORIES}.
 */
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
    // The 1.0.3 AMM split, registered on the guard 2026-10-04. Listed for their NAMES, not for
    // routing: `ammAdapters` reads the guard, so what an order is sent
    // to still changes without a release. A name cannot be read from the guard at all, and
    // without one the Trade screen's venue chip had nothing to draw — it fell back to a lettered
    // disc of a shortened address, and then to nothing once unnamed venues were dropped. The
    // server's service catalog carries names too and wins when it has answered; this is what
    // makes the mark correct on the first frame and offline.
    '0x73d16efa39e2195cfac4b0f18bda3aa35056663a': {name: 'Uniswap Universal', category: 'amm'},
    '0x9296f7ffe86da8b652988f07920b42f8779ce64b': {name: 'Aave V3', category: 'lending'},
    '0x35252547c41661103865d700d8fcace07afce1bd': {name: 'Lido', category: 'staking'},
    '0x0968632ad0a79220ffb2d2320de82b7c17357774': {name: 'Sky', category: 'staking'},
    // Uniswap V3 adapter 1.0.1 — the ONLY one listed here. It is what `ammAdapters` hands the
    // market swap, and only 1.0.1 carries market buy/sell: with the 1.0.0 adapter
    // (0xcE02C925…) in its place every market trade on mainnet reverted and came back from the
    // relayer as "simulation-failed". The web keeps 1.0.0 listed behind it; this app does not, so a
    // history row from a vault that traded through the old adapter names a short address instead of
    // "Uniswap V3".
    '0xf72ab1ca4dd4c8d5e747271e80ff2c71d129a664': {name: 'Uniswap V3', category: 'amm'},
    '0x3d7589cd35400e0a1b8d6f5f8ed3ae4171a5e195': {name: 'CoW Swap', category: 'intent'},
  },
  base: {
    // The 1.0.3 AMM split, registered on the guard 2026-10-04. Listed for their NAMES, not for
    // routing: `ammAdapters` reads the guard, so what an order is sent
    // to still changes without a release. A name cannot be read from the guard at all, and
    // without one the Trade screen's venue chip had nothing to draw — it fell back to a lettered
    // disc of a shortened address, and then to nothing once unnamed venues were dropped. The
    // server's service catalog carries names too and wins when it has answered; this is what
    // makes the mark correct on the first frame and offline.
    '0x4753f9a82659edcffc940fe8e330741d14bad82b': {name: 'Uniswap Universal', category: 'amm'},
    '0x4b38baa01e6fd30163f4de7e678dc868045eb27f': {name: 'Aave V3', category: 'lending'},
    '0x8e14e91f29066ccdd9e9e2db6bafe6fef7c14ac6': {name: 'Sky', category: 'staking'},
    // 1.0.1 only, as on mainnet above; the 1.0.0 adapter (0x7aE75624…) is deliberately not listed.
    '0xfd30f05b9d36488631c212f0421eb9a117382fd5': {name: 'Uniswap V3', category: 'amm'},
    '0x5daa6aef7de9c13624a8fdfde47c10d35fd79b0a': {name: 'CoW Swap', category: 'intent'},
  },
  // Only the AMM adapter (Universal Router build, 1.0.2): no Aave, Sky or CoW on this chain.
  robinhood: {
    // The 1.0.3 AMM split, registered on the guard 2026-10-04. Listed for their NAMES, not for
    // routing: `ammAdapters` reads the guard, so what an order is sent
    // to still changes without a release. A name cannot be read from the guard at all, and
    // without one the Trade screen's venue chip had nothing to draw — it fell back to a lettered
    // disc of a shortened address, and then to nothing once unnamed venues were dropped. The
    // server's service catalog carries names too and wins when it has answered; this is what
    // makes the mark correct on the first frame and offline.
    '0x7ae75624f265a700d011df819bed6ef10615ac38': {name: 'Uniswap Universal', category: 'amm'},
    // The pre-split COMBINED adapter (1.0.2) — and on this chain it is a Universal Router build,
    // so it is named for that like the split one above it. The combined adapters on mainnet and
    // Base keep "Uniswap V3", because there the one contract really was v3 only.
    '0x2b2ecfad219fe9fd358ba196962d1536665b2041': {name: 'Uniswap Universal', category: 'amm'},
  },
  // Sepolia took the AMM split on 2026-10-02 and is the only chain that has. The two adapters that
  // used to sit here (0x88b9f031…, 0xc701e8d6…) were the combined Uniswap V3 adapter of the
  // previous guard generation and are deliberately NOT listed: the whole set was redeployed, so
  // keeping them would hand `ammAdapters` a superseded address to trade through.
  //
  // The trade side routes v2/v3/v4 through the Universal Router, so it is "Uniswap Universal",
  // matching what Robinhood Chain's Universal adapter is called.
  sepolia: {
    '0x9c01f9b6ed7bbd86f7a309a3414595608ab9d80d': {name: 'Aave V3', category: 'lending'},
    '0x9f6d7b2defcf45cb837560209099083ddf59840a': {name: 'Lido', category: 'staking'},
    '0x67bd4c240d513e7eb35bf8d871cbed314856b125': {name: 'Uniswap Universal', category: 'amm'},
    '0x5a365990111b5a460526a25a8d4493df103759df': {name: 'CoW Swap', category: 'intent'},
  },
};

/**
 * What a protocol is CALLED on screen, where that differs from the adapter's registry name.
 *
 * The registry name is an identity — code compares against it ("is this the Lido adapter?") — so
 * it cannot carry a version the user should see. Lido's adapter wraps Lido V2, and a row that
 * says "Lido" beside a V2 position is naming the brand rather than the thing it routes to.
 *
 * Lives here rather than beside the icon, which is where it started: three screens render a
 * protocol name without rendering its mark, and a lookup kept in a component is one those
 * screens have to remember to import. The rule is about the name, so it sits with the names.
 */
const DISPLAY_NAME: Record<string, string> = {
  Lido: 'Lido V2',
  Sky: 'Sky V1',
  'CoW Swap': 'CoW Swap V1',
};
export const protocolDisplayName = (name: string) => DISPLAY_NAME[name] ?? name;

// See {shortAddress}: one formatter for every address the app prints.
const short = shortAddress;

/**
 * Every adapter the guard is running, newest first — or the vendored table when it has not
 * answered yet.
 *
 * The table above is a BOOT FALLBACK and a name source, not the truth. The truth is on chain and
 * read by {fetchGuardProtocols}, which is what lets a vault move to a new release without this
 * app moving with it: when 1.0.3 split trading from liquidity, the routing changed in the guard
 * and every accessor below followed it. Shipping the addresses in the binary would mean a release
 * per chain per deployment — and the table was already behind, which is the whole argument: on
 * 2026-10-05 the guard served a market-maker adapter and a newer trade adapter on mainnet and
 * Base that the table had never heard of.
 */
function adapters(network: Network): {address: Address; category: ProtocolCategory}[] {
  const live = currentGuardProtocols(network);
  if (live) return live.map((p) => ({address: p.address, category: p.category}));
  // The table is the v1.0.3 generation's adapters. A v1.0.0 vault routing through one of them is a
  // revert, so on that generation nothing is better than a wrong address.
  if (!isLegacy()) return [];
  return Object.entries(PROTOCOLS[network]).map(([addr, info]) => ({address: addr as Address, category: info.category}));
}
const byCategory = (network: Network, category: ProtocolCategory): Address[] =>
  adapters(network)
    .filter((p) => p.category === category)
    .map((p) => p.address);

/**
 * What an address IS, for naming a history row or a position.
 *
 * The name still comes from the table, because the guard stores no names — it stores addresses
 * and categories. An adapter it knows and the table does not is named by its address, which is
 * what already happened for anything unrecognised. The CATEGORY, though, comes from the chain
 * where it can, so a row for an adapter deployed after this build still says which service it
 * belongs to.
 */
export function protocolMeta(network: Network, address: string): ProtocolInfo {
  const vendored = PROTOCOLS[network][address.toLowerCase()];
  if (vendored) return vendored;
  const live = currentGuardProtocols(network)?.find((p) => p.address.toLowerCase() === address.toLowerCase());
  return {name: short(address), category: live?.category ?? 'unknown'};
}

/**
 * The adapters that SWAP, newest first — what a market order is routed through.
 *
 * On a chain that has taken the AMM split this is the market-trade adapter alone, and the maker
 * adapter is deliberately absent: handing a swap to the liquidity adapter is not a degraded route,
 * it is a revert.
 */
export function ammAdapters(network: Network): Address[] {
  return byCategory(network, 'amm');
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
  /**
   * The CANONICAL adapter only — the one an order will actually be routed through.
   *
   * It used to return every adapter the guard still lists in the category, which on mainnet is
   * three: the live trade adapter plus two superseded ones the guard keeps so an un-upgraded
   * vault can still resolve its clone. Naming all three told the user their order went three
   * places, and the two the vendored table has never heard of each rendered as a lettered disc
   * showing "0" — the first character of a shortened address.
   */
  const [canonical] = byCategory(network, category);
  if (!canonical) return [];
  return [protocolMeta(network, canonical).name];
}

/** The adapters that post INTENTS — what a limit or TWAP order is signed against. */
export function intentAdapters(network: Network): Address[] {
  return byCategory(network, 'intent');
}

/** Does this name come from the registry, or is it a shortened address standing in for one? */
export const isNamedProtocol = (name: string) => !name.startsWith('0x');

/** Every known adapter for a network (all categories) — for protocol allowlist management. */
export function allAdapters(
  network: Network,
): {address: Address; name: string; category: ProtocolCategory}[] {
  return adapters(network).map((p) => ({address: p.address, name: protocolMeta(network, p.address).name, category: p.category}));
}

/** Yield adapters (staking + lending) for a network — the auto-yield route options. */
export function yieldAdapters(
  network: Network,
): {address: Address; name: string; category: ProtocolCategory}[] {
  return allAdapters(network).filter((p) => p.category === 'staking' || p.category === 'lending');
}

/** Resolve a protocol adapter address by display name (e.g. "Sky", "Aave V3"). Null if unknown. */
export function adapterByName(network: Network, name: string): Address | null {
  const hit = Object.entries(PROTOCOLS[network]).find(
    ([, info]) => info.name.toLowerCase() === name.toLowerCase(),
  );
  return hit ? (hit[0] as Address) : null;
}

export type {Address};

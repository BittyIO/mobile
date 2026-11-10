import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {shortAddress} from '@/core/format';
import {currentGuardProtocols} from '@/core/guard-catalog';

/**
 * Guard categories, as the app names them. `amm` is the market-trade adapter (guard category 3),
 * which swaps through the Universal Router. The guard's market-maker category (5, concentrated
 * liquidity) has no name here: the app provides no liquidity, and the guard reads skip it — see
 * {IGNORED_GUARD_CATEGORIES} in `core/vault-contracts`.
 */
export type ProtocolCategory = 'staking' | 'lending' | 'amm' | 'intent' | 'unknown';

type ProtocolInfo = {name: string; category: ProtocolCategory};

/**
 * Display names for the known protocol adapters, keyed by lowercased address, mirroring the guard
 * catalog / web config `protocols`. Both adapter versions of one provider (e.g. Uniswap 1.0.0 & 1.0.1)
 * map to the same name. Unknown addresses fall back to a shortened address (see {@link protocolMeta}).
 * A real build resolves these from the on-chain guard catalog; vendored here until `packages/core`.
 *
 * Only what the guard (0x0000…9554) lists: an adapter it does not know would be handed to a vault
 * that cannot use it. Read through {table}, never directly.
 */
const PROTOCOLS: Record<Network, Record<string, ProtocolInfo>> = {
  // Read off the mainnet guard 2026-10-19. The catalog API wins once it answers; this is the
  // first frame and offline — without it Earn has no adapter to name and shows nothing.
  mainnet: {
    '0xbb51e4d055f213d0e38a103b9ba5943de2e83287': {name: 'Aave V3', category: 'lending'},
    '0x8b2b9ae6dea163a382b02ff921fb3c3559769d10': {name: 'Uniswap Universal', category: 'amm'},
    '0x350f13cdc7311713ee6dac05dd3b9fd624536b02': {name: 'CoW Swap', category: 'intent'},
    '0x355b273974111508328155ccf65a7af434f24243': {name: 'Lido', category: 'staking'},
    '0x093cedc958bf07eb0063e6299e5b547292cf9ad4': {name: 'Sky', category: 'staking'},
  },
  // Registered on the Base guard 2026-10-18, with fees to the Safe.
  base: {
    '0x8e14e91f29066ccdd9e9e2db6bafe6fef7c14ac6': {name: 'Sky', category: 'staking'},
    '0xb3ff9df07f2901d97c07146d18093de914141ad3': {name: 'Aave V3', category: 'lending'},
    '0xb5b4313d88b4aa68d03bd6467eb1460ffaf136e5': {name: 'Uniswap Universal', category: 'amm'},
    '0x646248f1ad34a4ef927726bd818c19107231322b': {name: 'CoW Swap', category: 'intent'},
  },
  // Read off the Robinhood guard 2026-10-23. No intent adapter: its UniswapX one is retired (see
  // {RETIRED}), and CoW does not run there, so the Trade sheet offers no Limit/TWAP.
  robinhood: {
    '0xc1608cfc8c272c693f8b0a65cfe16597b9e281ae': {name: 'Uniswap Universal', category: 'amm'},
  },
  // Registered on the Arbitrum guard 2026-10-19. Names only; routing reads the guard.
  arbitrum: {
    '0x7e97befd060124ed648d77901398f4051a1cf1ed': {name: 'Sky', category: 'staking'},
    '0x5786f0ef83c4fc08ae372207707bb577e413c227': {name: 'Aave V3', category: 'lending'},
    '0x2576d292401c03985e41737a09bce9f1214fb7f3': {name: 'Uniswap Universal', category: 'amm'},
    '0x0936b90022eb22ae3329751573d22da26f1b1ad3': {name: 'CoW Swap', category: 'intent'},
  },
  // Registered on the BSC guard 2026-11-10. PancakeSwap is the Uniswap trade adapter pointed at
  // PancakeSwap's Universal Router; its routes come from the server, like Uniswap's elsewhere.
  bsc: {
    '0x30fb7e82ddd6f0fb6fb94ce117fc2dc33b90a615': {name: 'Aave V3', category: 'lending'},
    '0x5eda2893c932074bdc2e05b96c81f0bfcb1209c7': {name: 'PancakeSwap', category: 'amm'},
    '0x1e99b0f8f4c99070e9bee6a160a80a02b74207d6': {name: 'CoW Swap', category: 'intent'},
  },
  sepolia: {
    '0x9c01f9b6ed7bbd86f7a309a3414595608ab9d80d': {name: 'Aave V3', category: 'lending'},
    '0x9f6d7b2defcf45cb837560209099083ddf59840a': {name: 'Lido', category: 'staking'},
    '0x67bd4c240d513e7eb35bf8d871cbed314856b125': {name: 'Uniswap Universal', category: 'amm'},
    '0x236b4b260bd29dca1df29360fa09c084e37fb100': {name: 'CoW Swap', category: 'intent'},
  },
  // The Nile guard lists no protocol: none ships with the vault on Tron.
  'tron-nile': {},
};

/**
 * Adapters the guard has retired, kept only to NAME them: a past order, approval or cancel in the
 * history, and an order still open on a vault that cloned one. They are not in {table}, so nothing
 * lists, routes or clones them.
 */
const RETIRED: Partial<Record<Network, Record<string, ProtocolInfo>>> = {
  // UniswapX: deprecated on the Robinhood guard with vault 1.0.6, which takes no UniswapX order.
  robinhood: {
    '0x2db440cf6215d68d44736a287b253f4461399aa0': {name: 'UniswapX', category: 'intent'},
  },
};

/** A retired adapter's address by name (see {RETIRED}), or null where the network had none. */
export function retiredAdapterByName(network: Network, name: string): Address | null {
  const hit = Object.entries(RETIRED[network] ?? {}).find(([, info]) => info.name.toLowerCase() === name.toLowerCase());
  return hit ? (hit[0] as Address) : null;
}

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
  UniswapX: 'UniswapX V1',
};
export const protocolDisplayName = (name: string) => DISPLAY_NAME[name] ?? name;

// See {shortAddress}: one formatter for every address the app prints.
const short = shortAddress;

// The server's config keys → the app's categories. `marketMaker` is dropped, as the guard reads drop 5.
const SERVED_CATEGORY: Record<string, ProtocolCategory> = {
  staking: 'staking',
  lending: 'lending',
  marketTrade: 'amm',
  intent: 'intent',
};
// The server names adapters as displayed ("Sky V1"); the app keys its routes by the short name.
const SHORT_NAME: Record<string, string> = Object.fromEntries(Object.entries(DISPLAY_NAME).map(([k, v]) => [v, k]));

// Keyed by network.
const served = new Map<string, Record<string, ProtocolInfo>>();

/** The adapters the catalog API serves for a network. See {loadCatalog}. */
export function registerServedProtocols(network: Network, rows: {address: string; category: string; name?: string}[]) {
  const out: Record<string, ProtocolInfo> = {};
  for (const r of rows) {
    const category = SERVED_CATEGORY[r.category];
    if (category && r.name) out[r.address.toLowerCase()] = {name: SHORT_NAME[r.name] ?? r.name, category};
  }
  // An empty answer (Arbitrum, before the server lists it) must not blank the vendored table.
  if (Object.keys(out).length) served.set(network, out);
}

/** The server's adapters; the vendored table until it has answered. */
const table = (network: Network): Record<string, ProtocolInfo> => served.get(network) ?? PROTOCOLS[network];

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
  return Object.entries(table(network)).map(([addr, info]) => ({address: addr as Address, category: info.category}));
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
  const vendored = table(network)[address.toLowerCase()] ?? RETIRED[network]?.[address.toLowerCase()];
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

/**
 * Resolve a protocol adapter address by display name (e.g. "Sky", "Aave V3"). Null if unknown.
 *
 * The name comes from the table, but the address has to be one the guard still runs. On Base the
 * guard replaced CoW 0x6462… with 0x923B… on 2026-10-21 while the served and vendored tables kept
 * the old one — and every call naming a deprecated adapter reverts, so a position-funded limit
 * order's approval was refused. When the guard no longer lists the table's address, the answer is
 * the live adapter of the same category that the table names as nothing else: its replacement.
 */
export function adapterByName(network: Network, name: string): Address | null {
  const t = table(network);
  const hit = Object.entries(t).find(([, info]) => info.name.toLowerCase() === name.toLowerCase());
  if (!hit) return null;
  const [address, info] = hit;
  const live = currentGuardProtocols(network);
  if (!live || live.some((p) => p.address.toLowerCase() === address)) return address as Address;
  // ponytail: assumes one unnamed live adapter per category; two replaced at once in one category
  // (Sky AND Lido) would be ambiguous — read lineages if that ever happens.
  const replacement = live.find((p) => p.category === info.category && !t[p.address.toLowerCase()]);
  return replacement?.address ?? (address as Address);
}

export type {Address};

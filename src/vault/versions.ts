import type {Address} from 'viem';
import {API_BASE, apiFetch, apiUrl, type Network} from '@/core/chain';
import {type ProtocolCategory} from '@/core/protocols';
import {generationConfig, generationKey, IGNORED_GUARD_CATEGORIES} from '@/core/vault-generation';

// Client for the server's vault VERSION catalog (GET /api/ethereum/vaults/versions) — the single
// source of truth shared with the web. It supplies the allow-list SERVICES (adapters + names/icons
// per version) and the per-version RELEASE NOTES. Per-vault state (which services are enabled, the
// vault's own impl version) stays an on-chain read; this is only the static catalog.

export type VaultService = {
  // Guard uint8 category: 1 lending, 2 staking, 3 market-trade, 4 intent, 5 market-maker.
  category: number;
  key: string;
  address: string;
  name?: string;
  version?: string;
  icon?: string;
  // Vault-impl version window this service applies to (encoded major*1e6+minor*1e3+patch); null =
  // unbounded. Combined pre-split adapter has maxVersion 1.0.3; split trade/maker have minVersion 1.0.3.
  minVersion?: number | null;
  maxVersion?: number | null;
};

/**
 * Whether a service applies to a vault on the given impl version.
 *
 * Unknown version (0 — the read hasn't landed yet / failed): a VERSION-GATED service is HIDDEN, not
 * shown. Showing it leaks the 1.0.3 split "Uniswap" onto a 1.0.2 vault. Unbounded services always show.
 */
function serviceAppliesTo(s: VaultService, vaultVersion: number): boolean {
  const bounded = s.minVersion != null || s.maxVersion != null;
  if (!vaultVersion) return !bounded;
  if (s.minVersion != null && vaultVersion < s.minVersion) return false;
  if (s.maxVersion != null && vaultVersion >= s.maxVersion) return false;
  return true;
}

export type UpgradeNote = {titleKey: string; bulletKeys: string[]};

export type VaultVersionInfo = {
  id: string;
  label: string;
  capabilityApi: boolean;
  factory: string | null;
  guard: string | null;
  deployBlock: number;
  implementation: string | null;
  services: VaultService[];
  releaseNotes: Record<string, string>;
};

export type VaultVersionsCatalog = {
  network: string;
  currentVersionId: string;
  versions: VaultVersionInfo[];
  upgradeNotes: Record<string, UpgradeNote>;
};

// The vault implementation itself is "category" 0 in the release-note key space (the real guard
// categories 1-5 are protocol adapters); the upgrade prompt looks its note up under 0.
export const VAULT_NOTE_CATEGORY = 0;

// Guard uint8 category -> the mobile ProtocolCategory name comes from the generation, whose guard
// numbers them: 3 is the market-TRADE adapter (which mobile has historically called 'amm'), 5 the
// market-MAKER (LP) adapter, and 1 / 2 are lending and staking in an order each guard picked.

// Shared across the app: the catalog changes rarely, so one fetch per network (and generation —
// `apiUrl` asks for the active one) serves every caller.
const cache = new Map<string, VaultVersionsCatalog>();

/** The server version catalog for a network (cached). Null on any failure, so callers degrade. */
export async function fetchVaultVersions(
  network: Network,
): Promise<VaultVersionsCatalog | null> {
  const key = generationKey(network);
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const res = await apiFetch(apiUrl('/api/ethereum/vaults/versions', network));
    if (!res.ok) return null;
    const c = (await res.json()) as VaultVersionsCatalog;
    cache.set(key, c);
    return c;
  } catch {
    return null;
  }
}

// The catalog returns icon paths relative to the web host; absolutize them for RN's <Image uri>.
function iconUri(icon?: string): string | undefined {
  if (!icon) return undefined;
  if (/^https?:\/\//.test(icon)) return icon;
  return `${API_BASE}${icon.startsWith('/') ? '' : '/'}${icon}`;
}

export type ManageService = {
  /**
   * Typed as an Address here, where `VaultService.address` above is a plain string.
   *
   * The wire type is whatever the server sent; this one is handed to `allowedSet` and
   * `updateProtocol`, which build calldata from it. Narrowing at the mapping boundary is the one
   * place a cast belongs — the alternative is a cast at every call site.
   */
  address: Address;
  name: string;
  category: ProtocolCategory;
  icon?: string;
};

/**
 * The services of the network's current version, mapped for the Manage screen's rows.
 *
 * Pass the vault's impl version to keep only the services that apply — a ≤1.0.2 vault gets the
 * combined Uniswap adapter, a 1.0.3+ vault the split trade + maker. 0 keeps everything.
 */
export function currentServices(
  catalog: VaultVersionsCatalog | null,
  vaultVersion = 0,
): ManageService[] {
  if (!catalog) return [];
  const categories = generationConfig().protocolCategories;
  const v =
    catalog.versions.find((x) => x.id === catalog.currentVersionId) ??
    catalog.versions[0];
  return (v?.services ?? [])
    .filter((s) => serviceAppliesTo(s, vaultVersion) && !IGNORED_GUARD_CATEGORIES.has(s.category))
    .map((s) => ({
    address: s.address as Address,
    name: s.name ?? s.address,
    category: categories[s.category] ?? 'unknown',
    icon: iconUri(s.icon),
  }));
}

/** The release note for an upgrade target, keyed "<category>:<version>" (category 0 = vault impl). */
export function upgradeNoteFor(
  catalog: VaultVersionsCatalog | null,
  category: number,
  version?: string | null,
): UpgradeNote | undefined {
  if (!catalog || !version) return undefined;
  return catalog.upgradeNotes?.[`${category}:${version}`];
}

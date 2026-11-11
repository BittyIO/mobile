/**
 * Asset / protocol allowlist management + vault upgrade. Restricted vaults can only hold/use assets and
 * protocols on their allowlist; the owner adds/removes them here (relayed, gasless). Ported from web
 * updateAssets / updateProtocols / useBittyAllowList and use-upgrade.
 */
import {getAddress, type Address, type Hex, parseAbi} from 'viem';
import {apiFetch, apiUrl, publicClientFor, type Network} from '@/core/chain';
import {APP_VERSION} from '@/core/app-version';
import {vaultGuard} from '@/core/vault-contracts';
import {
  VAULT_MANAGE_ABI,
  VAULT_ALLOWLIST_V2_ABI,
  GUARD_IMPL_ABI,
  ERC1967_IMPL_SLOT,
  IMPLEMENTATION_VAULT,
  VAULT_STABLE_COIN_AS_GAS_ABI,
} from '@/core/abi';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

// ---- Reads ----

/** Whether the vault is restricted to its OWN allow list (the vault asks the inverse question). */
export async function isAllowlistEnabled(vault: Address, network: Network): Promise<boolean> {
  try {
    const client = publicClientFor(network);
    return !((await client.readContract({
      address: vault,
      abi: VAULT_ALLOWLIST_V2_ABI,
      functionName: 'usingBittyAllowList',
    })) as boolean);
  } catch {
    return false;
  }
}

/** Which of the given addresses are on the vault's allowlist. `kind` picks asset vs protocol. */
export async function allowedSet(
  vault: Address,
  network: Network,
  kind: 'asset' | 'protocol',
  addresses: Address[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (addresses.length === 0) return out;
  try {
    const client = publicClientFor(network);
    const fn = kind === 'asset' ? 'isAssetAllowed' : 'isProtocolAllowed';
    const results = await client.multicall({
      contracts: addresses.map((a) => ({
        address: vault,
        abi: VAULT_MANAGE_ABI,
        functionName: fn as 'isAssetAllowed',
        args: [a] as const,
      })),
      allowFailure: true,
    });
    addresses.forEach((a, i) => {
      if (results[i].status === 'success' && results[i].result === true) out.add(a.toLowerCase());
    });
  } catch {
    /* not activated — nothing allowed */
  }
  return out;
}

// ---- Writes ----

export function updateAsset(o: {account: Acct; vault: Address; network: Network; asset: Address; add: boolean; stableCoin: Address}): Promise<Hex> {
  return relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_MANAGE_ABI,
    functionName: 'updateAssets',
    args: o.add ? [[o.asset], []] : [[], [o.asset]],
    stableCoin: o.stableCoin,
  }).then((r) => r.hash);
}

export function updateProtocol(o: {account: Acct; vault: Address; network: Network; protocol: Address; add: boolean; stableCoin: Address}): Promise<Hex> {
  return relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_MANAGE_ABI,
    functionName: 'updateProtocols',
    args: o.add ? [[o.protocol], []] : [[], [o.protocol]],
    stableCoin: o.stableCoin,
  }).then((r) => r.hash);
}

export function setAllowlistEnabled(o: {account: Acct; vault: Address; network: Network; enabled: boolean; stableCoin: Address}): Promise<Hex> {
  // Restricting to the vault's own list is NOT using Bitty's.
  return relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_ALLOWLIST_V2_ABI,
    functionName: 'useBittyAllowList',
    args: [!o.enabled],
    stableCoin: o.stableCoin,
  }).then((r) => r.hash);
}

// ---- Vault upgrade ----

/** The vault's current implementation vs the guard's latest. `available` when they differ. */
const VAULT_VERSION_ABI = parseAbi(['function vaultVersion() view returns (uint256)']);

/** vaultVersion() is major*1e6 + minor*1e3 + patch (1.0.1 = 1000001). */
export function formatVaultVersion(v: bigint): string {
  const n = Number(v);
  return `${Math.floor(n / 1e6)}.${Math.floor((n % 1e6) / 1e3)}.${n % 1000}`;
}

/**
 * The vault's running impl version as the ENCODED number (major*1e6+minor*1e3+patch), 0 if
 * unreadable. A counterfactual vault has no code of its own; it will be born on the guard's latest
 * impl, so that version is returned — which is what decides the services the Manage screen shows.
 */
export async function vaultImplVersion(vault: Address, network: Network): Promise<number> {
  try {
    const client = publicClientFor(network);
    const code = await client.getCode({address: vault});
    const own = await (
      client.readContract({address: vault, abi: VAULT_VERSION_ABI, functionName: 'vaultVersion'}) as Promise<bigint>
    )
      .then((v) => Number(v))
      .catch(() => 0);
    if (own) return own;
    // A deployed pre-versioned implementation reads 0; only counterfactual vaults inherit latest.
    if (code && code !== '0x') return 0;
    const latest = (await client.readContract({
      address: vaultGuard(network),
      abi: GUARD_IMPL_ABI,
      functionName: 'latestImplementation',
      args: [IMPLEMENTATION_VAULT],
    })) as Address;
    if (!latest || /^0x0+$/.test(latest)) return 0;
    return Number(
      (await client.readContract({address: latest, abi: VAULT_VERSION_ABI, functionName: 'vaultVersion'})) as bigint,
    );
  } catch {
    return 0;
  }
}

/** Vaults known to answer `tokenAsGasConfig`. Only the yes is kept: an upgrade never goes back. */
const tokenAsGasVaults = new Set<string>();

/**
 * The relay-fee entry points: `*StableCoinAsGas`, renamed `*TokenAsGas` from v1.0.2, when the
 * vault's WETH may pay too. Asked of the vault itself, because both shapes live on until each vault
 * upgrades.
 */
export async function stableCoinAsGasFunctionNames(
  vault: Address,
  network: Network,
): Promise<
  | {set: 'setStableCoinAsGas'; disable: 'disableStableCoinAsGas'; config: 'stableCoinAsGasConfig'}
  | {set: 'setTokenAsGas'; disable: 'disableTokenAsGas'; config: 'tokenAsGasConfig'}
> {
  const key = `${network}:${vault.toLowerCase()}`;
  if (!tokenAsGasVaults.has(key)) {
    try {
      await publicClientFor(network).readContract({
        address: vault,
        abi: VAULT_STABLE_COIN_AS_GAS_ABI,
        functionName: 'tokenAsGasConfig',
      });
      tokenAsGasVaults.add(key);
    } catch {
      return {set: 'setStableCoinAsGas', disable: 'disableStableCoinAsGas', config: 'stableCoinAsGasConfig'};
    }
  }
  return {set: 'setTokenAsGas', disable: 'disableTokenAsGas', config: 'tokenAsGasConfig'};
}

export type VaultUpgrade = {
  current: Address | null; // the implementation the vault runs (null before activation)
  latest: Address | null; // the upgrade target the server offers this app; null when none
  available: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  /** A newer build exists, but the server says this app is too old to run it. */
  appUpdateRequired: boolean;
};

type UpgradeTarget = {
  latest: {implementation: Address; version: string} | null;
  offered: boolean;
  reason: string | null;
};

/**
 * The upgrade target, from the server — never off the guard directly.
 *
 * An implementation is registered on the guard the moment it is deployed, before any app knows how
 * to drive it. Read off the chain, every installed app would offer it at once, and an upgrade
 * cannot be undone: an older app would upgrade the vault onto a release it then cannot use. The
 * server decides which release this app version may be given (web
 * /api/ethereum/vaults/upgrade-target).
 */
async function fetchUpgradeTarget(network: Network): Promise<UpgradeTarget | null> {
  try {
    const app = encodeURIComponent(APP_VERSION.replace(/^v/, ''));
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/upgrade-target?app=${app}`, network), undefined, 15_000);
    if (!res.ok) return null;
    return (await res.json()) as UpgradeTarget;
  } catch {
    return null;
  }
}

/**
 * The vault's implementation and the upgrade on offer, with their release versions. The vault's own
 * implementation is read from its proxy; the target comes from the server (see fetchUpgradeTarget).
 * Before activation there is nothing to read `current` off: the vault will be born on the guard's
 * build, which the server also names, so that is the version to show.
 *
 * No answer from the server: no upgrade is offered.
 */
export async function checkVaultUpgrade(vault: Address, network: Network): Promise<VaultUpgrade> {
  const none: VaultUpgrade = {
    current: null,
    latest: null,
    available: false,
    currentVersion: null,
    latestVersion: null,
    appUpdateRequired: false,
  };
  try {
    const client = publicClientFor(network);
    const [slot, target] = await Promise.all([
      client.getStorageAt({address: vault, slot: ERC1967_IMPL_SLOT}),
      fetchUpgradeTarget(network),
    ]);
    const implAt = slot ? (getAddress(`0x${slot.slice(-40)}`) as Address) : null;
    const current = implAt && !/^0x0+$/.test(implAt) ? implAt : null;
    const currentVersion = current
      ? await (client.readContract({address: vault, abi: VAULT_VERSION_ABI, functionName: 'vaultVersion'}) as Promise<bigint>)
          .then(formatVaultVersion)
          .catch(() => null)
      : null;
    const build = target?.latest ?? null;
    const behind = !!current && !!build && current.toLowerCase() !== build.implementation.toLowerCase();
    const offered = behind && !!target?.offered;
    return {
      current,
      latest: offered ? (getAddress(build!.implementation) as Address) : null,
      available: offered || (behind && target?.reason === 'app-update-required'),
      currentVersion,
      latestVersion: build?.version ?? null,
      appUpdateRequired: behind && target?.reason === 'app-update-required',
    };
  } catch {
    return none;
  }
}

/** UUPS-upgrade the vault to `newImpl` (relayed, gasless). */
export function upgradeVault(o: {account: Acct; vault: Address; network: Network; newImpl: Address; stableCoin: Address}): Promise<Hex> {
  return relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_MANAGE_ABI,
    functionName: 'upgrade',
    args: [o.newImpl],
    stableCoin: o.stableCoin,
  }).then((r) => r.hash);
}

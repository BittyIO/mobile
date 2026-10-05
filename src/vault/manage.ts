/**
 * Asset / protocol allowlist management + vault upgrade. Restricted vaults can only hold/use assets and
 * protocols on their allowlist; the owner adds/removes them here (relayed, gasless). Ported from web
 * updateAssets / updateProtocols / enable-disableAllowlist and use-upgrade.
 */
import {getAddress, type Address, type Hex, parseAbi} from 'viem';
import {publicClientFor, GUARD_ADDRESS, type Network} from '@/core/chain';
import {
  VAULT_MANAGE_ABI,
  GUARD_IMPL_ABI,
  ERC1967_IMPL_SLOT,
  IMPLEMENTATION_VAULT,
} from '@/core/abi';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

// ---- Reads ----

export async function isAllowlistEnabled(vault: Address, network: Network): Promise<boolean> {
  try {
    const client = publicClientFor(network);
    return (await client.readContract({
      address: vault,
      abi: VAULT_MANAGE_ABI,
      functionName: 'allowlistEnabled',
    })) as boolean;
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
  return relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_MANAGE_ABI,
    functionName: o.enabled ? 'enableAllowlist' : 'disableAllowlist',
    args: [],
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
    const own = await (
      client.readContract({address: vault, abi: VAULT_VERSION_ABI, functionName: 'vaultVersion'}) as Promise<bigint>
    )
      .then((v) => Number(v))
      .catch(() => 0);
    if (own) return own;
    const latest = (await client.readContract({
      address: GUARD_ADDRESS,
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

export type VaultUpgrade = {
  current: Address | null; // the implementation the vault runs (null before activation)
  latest: Address | null; // the guard's current implementation
  available: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
};

/**
 * The vault's implementation and the guard's latest, with their release versions. Before activation
 * there is nothing to read `current` off: the vault will be born on `latest`, so that is the version
 * to show.
 */
export async function checkVaultUpgrade(vault: Address, network: Network): Promise<VaultUpgrade> {
  const none: VaultUpgrade = {current: null, latest: null, available: false, currentVersion: null, latestVersion: null};
  try {
    const client = publicClientFor(network);
    const [slot, latest] = await Promise.all([
      client.getStorageAt({address: vault, slot: ERC1967_IMPL_SLOT}),
      client.readContract({
        address: GUARD_ADDRESS,
        abi: GUARD_IMPL_ABI,
        functionName: 'latestImplementation',
        args: [IMPLEMENTATION_VAULT],
      }) as Promise<Address>,
    ]);
    const implAt = slot ? (getAddress(`0x${slot.slice(-40)}`) as Address) : null;
    const current = implAt && !/^0x0+$/.test(implAt) ? implAt : null;
    const version = (addr: Address | null) =>
      addr
        ? (client.readContract({address: addr, abi: VAULT_VERSION_ABI, functionName: 'vaultVersion'}) as Promise<bigint>)
            .then(formatVaultVersion)
            .catch(() => null)
        : Promise.resolve(null);
    const [currentVersion, latestVersion] = await Promise.all([version(current ? vault : null), version(latest)]);
    const available = !!current && !!latest && current.toLowerCase() !== latest.toLowerCase();
    return {current, latest, available, currentVersion, latestVersion};
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

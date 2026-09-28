/**
 * In-place adapter (protocol) upgrades. Each vault has ONE clone per protocol lineage (holding its
 * funds/positions); `upgradeProtocol` moves that clone to a newer implementation of the SAME lineage
 * (funds preserved, same address). Ported from web use-upgrade + the register-and-drop-old fix.
 *
 * Discovery: for each known adapter read protocolLineage + protocolVersion, group by lineage, and if the
 * vault's clone of a lineage runs an older version than the newest known adapter, offer the upgrade.
 * (Adapters are read from the vendored catalog; a newer adapter must be in it or the guard catalog read
 * added — noted as a limitation.)
 */
import {encodeFunctionData, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {ADAPTER_ABI, VAULT_UPGRADE_ABI} from '@/core/abi';
import {allAdapters} from '@/core/protocols';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

export type AdapterUpgrade = {
  name: string;
  oldProtocol: Address; // the address to key the clone under (any registered adapter of the lineage)
  newImpl: Address;
  currentVersion: bigint;
  latestVersion: bigint;
};

/** protocolVersion is major*1e6 + minor*1e3 + patch (1.0.1 = 1000001). */
export function formatVersion(v: bigint): string {
  const n = Number(v);
  return `${Math.floor(n / 1e6)}.${Math.floor((n % 1e6) / 1e3)}.${n % 1000}`;
}

const isZero = (a?: string) => !a || /^0x0+$/.test(a);

export async function checkAdapterUpgrades(
  vault: Address,
  network: Network,
): Promise<AdapterUpgrade[]> {
  const client = publicClientFor(network);
  const adapters = allAdapters(network);
  if (adapters.length === 0) return [];

  // lineage + version for every known adapter.
  const meta = await client.multicall({
    contracts: adapters.flatMap((a) => [
      {address: a.address, abi: ADAPTER_ABI, functionName: 'protocolLineage' as const},
      {address: a.address, abi: ADAPTER_ABI, functionName: 'protocolVersion' as const},
    ]),
    allowFailure: true,
  });

  type Info = {address: Address; name: string; lineage: string; version: bigint};
  const infos: Info[] = [];
  adapters.forEach((a, i) => {
    const lin = meta[2 * i];
    const ver = meta[2 * i + 1];
    if (lin.status === 'success' && ver.status === 'success' && !isZero(lin.result as string)) {
      infos.push({address: a.address, name: a.name, lineage: (lin.result as string).toLowerCase(), version: ver.result as bigint});
    }
  });

  const byLineage = new Map<string, Info[]>();
  for (const info of infos) {
    const arr = byLineage.get(info.lineage) ?? [];
    arr.push(info);
    byLineage.set(info.lineage, arr);
  }

  const out: AdapterUpgrade[] = [];
  for (const group of byLineage.values()) {
    const latest = group.reduce((a, b) => (b.version > a.version ? b : a));
    // Does the vault have a clone of this lineage? (Both adapters resolve to the same clone.)
    let clone: Address;
    try {
      clone = (await client.readContract({
        address: vault,
        abi: VAULT_UPGRADE_ABI,
        functionName: 'getClone',
        args: [latest.address],
      })) as Address;
    } catch {
      continue;
    }
    if (isZero(clone)) continue; // no position/clone yet — nothing to upgrade

    let cloneVersion: bigint;
    try {
      cloneVersion = (await client.readContract({
        address: clone,
        abi: ADAPTER_ABI,
        functionName: 'protocolVersion',
      })) as bigint;
    } catch {
      continue;
    }

    if (latest.version > cloneVersion) {
      const old =
        group.find((g) => g.version === cloneVersion) ??
        group.find((g) => g.address.toLowerCase() !== latest.address.toLowerCase()) ??
        latest;
      out.push({
        name: latest.name,
        oldProtocol: old.address,
        newImpl: latest.address,
        currentVersion: cloneVersion,
        latestVersion: latest.version,
      });
    }
  }
  return out;
}

/**
 * Upgrade the adapter clone in place AND swap the allowlist registration (add new, drop old) in ONE
 * atomic multicall — so a restricted vault's routing points at the new address and never ends up
 * doubled. Funds are untouched (the clone is keyed by lineage). Relayed, gasless.
 */
export async function upgradeAdapter(o: {
  account: Acct;
  vault: Address;
  network: Network;
  oldProtocol: Address;
  newImpl: Address;
  stableCoin: Address;
}): Promise<Hex> {
  const upgradeCall = encodeFunctionData({
    abi: VAULT_UPGRADE_ABI,
    functionName: 'upgradeProtocol',
    args: [o.oldProtocol, o.newImpl],
  });
  const removeOld =
    o.oldProtocol.toLowerCase() !== o.newImpl.toLowerCase() ? [o.oldProtocol] : [];
  const registerCall = encodeFunctionData({
    abi: VAULT_UPGRADE_ABI,
    functionName: 'updateProtocols',
    args: [[o.newImpl], removeOld],
  });

  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_UPGRADE_ABI,
    functionName: 'multicall',
    args: [[upgradeCall, registerCall]],
    stableCoin: o.stableCoin,
  });
  return hash;
}

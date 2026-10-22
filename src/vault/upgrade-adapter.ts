/**
 * In-place adapter (protocol) upgrades. Each vault has ONE clone per protocol lineage (holding its
 * funds/positions); `upgradeProtocol` moves that clone to a newer implementation of the SAME lineage
 * (funds preserved, same address). Ported from web use-upgrade + the register-and-drop-old fix.
 *
 * Discovery, as the web does it: every adapter the guard has ever registered — live AND deprecated,
 * since a vault keys its clone under whichever adapter was canonical when it first deposited — is
 * asked of the vault with `getClone`. Each clone found is offered the newest LIVE adapter of its own
 * lineage when that is strictly newer, which is exactly what the vault's `upgradeProtocol` accepts.
 */
import {encodeFunctionData, parseAbi, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {ADAPTER_ABI, VAULT_UPGRADE_ABI} from '@/core/abi';
import {isNamedProtocol, protocolMeta} from '@/core/protocols';
import {generationConfig} from '@/core/vault-generation';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

export type AdapterUpgrade = {
  name: string;
  oldProtocol: Address; // the address the vault keys the clone under
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

const GUARD_LIST_ABI = parseAbi([
  'function getProtocols() view returns (address[])',
  'function getDeprecatedProtocols() view returns (address[])',
]);

/**
 * One entry per adapter lineage the guard knows: the version the vault runs (its clone's, or the
 * newest live build when it has no clone yet), every address of the lineage — so a row can find
 * itself whichever of them it names, a deprecated one included — and the upgrade, when behind.
 */
export type AdapterStatus = {addresses: string[]; version: bigint; upgrade: AdapterUpgrade | null};

export async function adapterStatuses(vault: Address, network: Network): Promise<AdapterStatus[]> {
  const client = publicClientFor(network);
  const guard = generationConfig().guard;
  const [live, deprecated] = await Promise.all([
    client.readContract({address: guard, abi: GUARD_LIST_ABI, functionName: 'getProtocols'}),
    client.readContract({address: guard, abi: GUARD_LIST_ABI, functionName: 'getDeprecatedProtocols'}).catch(() => []),
  ]);
  const liveSet = new Set(live.map((a) => a.toLowerCase()));
  const candidates = [...new Set([...live, ...deprecated].map((a) => a.toLowerCase() as Address))];
  if (candidates.length === 0) return [];

  // Per candidate: identity (lineage + version) and the vault's clone for it.
  const reads = await client.multicall({
    contracts: candidates.flatMap((a) => [
      {address: a, abi: ADAPTER_ABI, functionName: 'protocolLineage' as const},
      {address: a, abi: ADAPTER_ABI, functionName: 'protocolVersion' as const},
      {address: vault, abi: VAULT_UPGRADE_ABI, functionName: 'getClone' as const, args: [a] as const},
    ]),
    allowFailure: true,
  });

  type Info = {address: Address; lineage: string; version: bigint; clone: string | null};
  const infos: Info[] = [];
  candidates.forEach((address, i) => {
    const [lin, ver, clone] = [reads[3 * i], reads[3 * i + 1], reads[3 * i + 2]];
    if (lin.status !== 'success' || ver.status !== 'success' || isZero(lin.result as string)) return;
    infos.push({
      address,
      lineage: (lin.result as string).toLowerCase(),
      version: ver.result as bigint,
      clone: clone.status === 'success' && !isZero(clone.result as string) ? (clone.result as string).toLowerCase() : null,
    });
  });

  // Every lineage the guard knows, with the clone the vault holds for it (several candidates of a
  // lineage resolve to the same one).
  const lineages = new Map<string, Info[]>();
  for (const info of infos) lineages.set(info.lineage, [...(lineages.get(info.lineage) ?? []), info]);
  const groups = [...lineages.values()];
  const cloneOf = (g: Info[]) => g.find((x) => x.clone)?.clone ?? null;
  const withClone = groups.filter(cloneOf);
  const cloneVersions = withClone.length
    ? await client.multicall({
        contracts: withClone.map((g) => ({address: cloneOf(g) as Address, abi: ADAPTER_ABI, functionName: 'protocolVersion' as const})),
        allowFailure: true,
      })
    : [];

  return groups.flatMap((group): AdapterStatus[] => {
    const latest = group
      .filter((x) => liveSet.has(x.address))
      .reduce<Info | null>((a, b) => (!a || b.version > a.version ? b : a), null);
    const cv = withClone.includes(group) ? cloneVersions[withClone.indexOf(group)] : null;
    const current = cv?.status === 'success' ? (cv.result as bigint) : null;
    const addresses = group.map((x) => x.address.toLowerCase());
    // No clone yet: the vault runs nothing, and its first use clones the newest live build.
    if (current == null) return latest ? [{addresses, version: latest.version, upgrade: null}] : [];
    if (!latest || latest.version <= current) return [{addresses, version: current, upgrade: null}];
    // Keyed under the adapter the clone runs today where the guard still lists it, so the allowlist
    // swap drops THAT address rather than leaving it registered beside the new one.
    const key = group.find((x) => x.version === current) ?? group.find((x) => x.clone)!;
    return [
      {
        addresses,
        version: current,
        upgrade: {
          // The new build is often one no table has named yet; the one it replaces is.
          name: [latest.address, key.address].map((a) => protocolMeta(network, a).name).find(isNamedProtocol) ?? protocolMeta(network, latest.address).name,
          oldProtocol: key.address,
          newImpl: latest.address,
          currentVersion: current,
          latestVersion: latest.version,
        },
      },
    ];
  });
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

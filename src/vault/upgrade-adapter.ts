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
import {protocolMeta} from '@/core/protocols';
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

export async function checkAdapterUpgrades(vault: Address, network: Network): Promise<AdapterUpgrade[]> {
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

  // One entry per clone (several candidates of a lineage resolve to the same one), keyed under the
  // first candidate that found it.
  const clones = new Map<string, Info>();
  for (const info of infos) if (info.clone && !clones.has(info.clone)) clones.set(info.clone, info);
  if (clones.size === 0) return [];

  const cloneVersions = await client.multicall({
    contracts: [...clones.keys()].map((c) => ({address: c as Address, abi: ADAPTER_ABI, functionName: 'protocolVersion' as const})),
    allowFailure: true,
  });

  const out: AdapterUpgrade[] = [];
  [...clones.entries()].forEach(([clone, first], i) => {
    const cv = cloneVersions[i];
    if (cv.status !== 'success') return;
    const current = cv.result as bigint;
    // Keyed under the adapter the clone runs today where the guard still lists it, so the allowlist
    // swap below drops THAT address rather than leaving it registered beside the new one.
    const key = infos.find((x) => x.clone === clone && x.version === current) ?? first;
    const latest = infos
      .filter((x) => x.lineage === key.lineage && liveSet.has(x.address))
      .reduce<Info | null>((a, b) => (!a || b.version > a.version ? b : a), null);
    if (!latest || latest.version <= current) return;
    out.push({
      name: protocolMeta(network, latest.address).name,
      oldProtocol: key.address,
      newImpl: latest.address,
      currentVersion: current,
      latestVersion: latest.version,
    });
  });
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

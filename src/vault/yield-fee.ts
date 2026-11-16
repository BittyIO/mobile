/**
 * Bitty's yield fee, as the vault's own adapter clone charges it.
 *
 * From adapter release 1.1.0, Aave, Sky and Lido take a share of what a position earns
 * (`YIELD_FEE_BPS`, 5%), paid to Bitty when the vault withdraws. A clone still on an older release
 * charges nothing until the owner upgrades it, so the rate is read from the clone itself - or, for a
 * vault with no clone yet, from the adapter its first deposit would clone. One that does not answer
 * charges nothing.
 */
import {parseAbi, zeroAddress, type Address} from 'viem';
import {isTronNetwork, publicClientFor, type Network} from '@/core/chain';

const ABI = parseAbi([
  'function getClone(address protocol) view returns (address)',
  'function YIELD_FEE_BPS() view returns (uint256)',
  'function feeOwed(address asset) view returns (uint256)',
]);

/** The clone the vault runs for each protocol (lowercased), or the protocol itself when it has none. */
async function targets(vault: Address | null | undefined, network: Network, protocols: Address[]): Promise<Address[]> {
  if (!vault) return protocols;
  const clones = await publicClientFor(network).multicall({
    allowFailure: true,
    contracts: protocols.map((p) => ({address: vault, abi: ABI, functionName: 'getClone' as const, args: [p] as const})),
  });
  return protocols.map((p, i) => {
    const c = clones[i];
    return c.status === 'success' && c.result && c.result !== zeroAddress ? (c.result as Address) : p;
  });
}

/** The fee each protocol charges this vault, in basis points, keyed by the protocol lowercased. */
export async function fetchYieldFees(
  vault: Address | null | undefined,
  network: Network,
  protocols: Address[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (protocols.length === 0 || isTronNetwork(network)) return out;
  const on = await targets(vault, network, protocols);
  const bps = await publicClientFor(network).multicall({
    allowFailure: true,
    contracts: on.map((a) => ({address: a, abi: ABI, functionName: 'YIELD_FEE_BPS' as const})),
  });
  protocols.forEach((p, i) => out.set(p.toLowerCase(), bps[i].status === 'success' ? Number(bps[i].result) : 0));
  return out;
}

/** The fee the position owes now, in the asset's units, or null when the clone charges none. */
export async function fetchFeeOwed(vault: Address, network: Network, protocol: Address, asset: Address): Promise<bigint | null> {
  if (isTronNetwork(network)) return null;
  const [clone] = await targets(vault, network, [protocol]);
  if (clone.toLowerCase() === protocol.toLowerCase()) return null;
  return (await publicClientFor(network)
    .readContract({address: clone, abi: ABI, functionName: 'feeOwed', args: [asset]})
    .catch(() => null)) as bigint | null;
}

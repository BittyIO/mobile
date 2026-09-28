/**
 * Auto-yield routes — a per-asset default protocol that idle balances are swept into by the keeper.
 * Read the current routes with getAutoYieldings; set/clear one with setAutoYielding (relayed, gasless).
 * Ported from web setAutoYielding (v1.0.x drops the isSupplying flag).
 */
import {zeroAddress, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_AUTOYIELD_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';

/** Map of lowercased asset address → configured yield protocol (zero address = no route). */
export async function getAutoYields(
  vault: Address,
  network: Network,
  assets: Address[],
): Promise<Map<string, Address>> {
  const out = new Map<string, Address>();
  if (assets.length === 0) return out;
  try {
    const client = publicClientFor(network);
    const protocols = (await client.readContract({
      address: vault,
      abi: VAULT_AUTOYIELD_ABI,
      functionName: 'getAutoYieldings',
      args: [assets],
    })) as readonly Address[];
    assets.forEach((a, i) => out.set(a.toLowerCase(), protocols[i] ?? zeroAddress));
  } catch {
    // Not activated / no routes — treat as none.
  }
  return out;
}

/** Set (or clear, protocol = zero) the auto-yield route for an asset. */
export async function setAutoYield(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  asset: Address;
  protocol: Address; // zeroAddress to disable
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_AUTOYIELD_ABI,
    functionName: 'setAutoYielding',
    args: [{asset: o.asset, protocol: o.protocol}],
    stableCoin: o.stableCoin,
  });
  return hash;
}

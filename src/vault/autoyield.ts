/**
 * Auto-yield routes — a per-asset default protocol that idle balances are swept into by the keeper.
 * Read the current routes with getAutoYieldings; set/clear one with setAutoYielding (relayed, gasless).
 * Ported from web setAutoYielding (v1.0.x drops the isSupplying flag).
 */
import {zeroAddress, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_AUTOYIELD_ABI} from '@/core/abi';
import {autoYieldKeeper} from '@/core/vault-contracts';
import {relayVaultMulticall, relayVaultWrite, type VaultCall} from './relay';

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

/**
 * Whether the vault still has to name `keeper` as its autoYieldTrigger. A vault that cannot be read
 * (not activated yet, or the RPC failed) is treated as needing it: naming the keeper again is
 * harmless, and leaving it out is the bug this exists for.
 */
async function needsKeeper(vault: Address, network: Network, keeper: Address): Promise<boolean> {
  try {
    const trigger = (await publicClientFor(network).readContract({
      address: vault,
      abi: VAULT_AUTOYIELD_ABI,
      functionName: 'autoYieldTrigger',
    })) as Address;
    return trigger.toLowerCase() !== keeper.toLowerCase();
  } catch {
    return true;
  }
}

/**
 * Set (or clear, protocol = zero) the auto-yield route for an asset.
 *
 * A route only says where idle balance goes; the keeper does the sweeping, and the vault accepts a
 * sweep only from the address its owner named with setAutoYieldTrigger. That slot is empty on a new
 * vault, and setting a route alone left every switch on with nothing ever swept. So turning a route
 * ON also names the keeper when the vault has not, in the same transaction (vault multicall).
 * Turning one off leaves the trigger as it is: other assets' routes still need it.
 */
export async function setAutoYield(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  asset: Address;
  protocol: Address; // zeroAddress to disable
  stableCoin: Address;
}): Promise<Hex> {
  const keeper = o.protocol.toLowerCase() === zeroAddress ? null : autoYieldKeeper(o.network);
  if (keeper && (await needsKeeper(o.vault, o.network, keeper))) {
    const calls: VaultCall[] = [
      {abi: VAULT_AUTOYIELD_ABI, functionName: 'setAutoYieldTrigger', args: [keeper]},
      {abi: VAULT_AUTOYIELD_ABI, functionName: 'setAutoYielding', args: [{asset: o.asset, protocol: o.protocol}]},
    ];
    const {hash} = await relayVaultMulticall({
      account: o.account,
      vault: o.vault,
      network: o.network,
      calls,
      stableCoin: o.stableCoin,
    });
    return hash;
  }
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

/**
 * Delegation — the asset manager: a single trading delegate that can route swaps/LP until `expiresAt`
 * (a unix second). Every grant expires: the vault refuses 0. Appointing or extending a grant waits out an on-chain change timelock and
 * lands in the `pending` slot until it applies; revoking or shortening takes effect at once. Read the
 * live state (current + pending) with getAssetManager; appoint/revoke with setAssetManager.
 *
 * Payout operators are GONE: the vault redesign removed the role from the contract, so the add/remove
 * and event-scan helpers went with the screen that called them.
 *
 * All writes are relayed & gasless (fee in the vault's stablecoin), Face-ID-gated at signing.
 */
import {zeroAddress, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {ASSET_MANAGER_ALL_PERMISSIONS, VAULT_DELEGATE_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

const isZero = (a?: string) => !a || /^0x0+$/.test(a);

export type AssetManagerSettings = {
  manager: Address; // active grant (zeroAddress = none)
  expiresAt: bigint; // unix seconds; 0 = no manager
  pendingManager: Address; // queued grant awaiting the timelock (zeroAddress = none)
  pendingAt: bigint; // unix seconds the pending grant becomes active
  permissions: bigint; // effective grant permission mask, or 0 if inactive
  pendingPermissions: bigint; // queued grant permission mask, or 0 if none
};

const NONE: AssetManagerSettings = {
  manager: zeroAddress,
  expiresAt: 0n,
  pendingManager: zeroAddress,
  pendingAt: 0n,
  permissions: 0n,
  pendingPermissions: 0n,
};

/**
 * Current + pending asset-manager grant. Returns NONE for an un-activated vault or a read failure.
 */
export async function getAssetManager(
  vault: Address,
  network: Network,
): Promise<AssetManagerSettings> {
  try {
    const client = publicClientFor(network);
    const [manager, expiresAt, pendingManager, pendingAt, permissions, pendingPermissions] = await client.readContract({
      address: vault,
      abi: VAULT_DELEGATE_ABI,
      functionName: 'getAssetManagerSettings',
    });
    // Past its time, the queued grant is the one in force (the read already returns it as `manager`)
    // and only waits for the vault's next write to be tidied away; it is no longer pending.
    const matured = pendingAt !== 0n && BigInt(pendingAt) <= BigInt(Math.floor(Date.now() / 1000));
    return {
      manager,
      expiresAt: BigInt(expiresAt),
      pendingManager: matured ? zeroAddress : pendingManager,
      pendingAt: matured ? 0n : BigInt(pendingAt),
      permissions: BigInt(permissions),
      pendingPermissions: matured ? 0n : BigInt(pendingPermissions),
    };
  } catch {
    return NONE;
  }
}

/**
 * Appoint (or extend) the asset manager until `expiresAt`; pass the zero address (or use
 * revokeAssetManager) to clear it. Appointing/extending queues behind the change timelock.
 *
 * The grant carries a permission mask (`ASSET_MANAGER_PERMS`), every permission when the
 * caller names none, and 0 on a revoke. Removing a permission from the same manager applies at once;
 * adding one waits out the timelock.
 */
export async function setAssetManager(o: {
  account: Acct;
  vault: Address;
  network: Network;
  manager: Address;
  expiresAt: bigint;
  /** Permission mask. */
  permissions?: number;
  stableCoin: Address;
}): Promise<Hex> {
  // Caught here rather than by the vault, so the owner never pays a relay fee for a sure revert.
  if (!isZero(o.manager) && o.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error('An asset manager grant needs an expiry in the future');
  }
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_DELEGATE_ABI,
    functionName: 'setAssetManager',
    args: [o.manager, o.expiresAt, isZero(o.manager) ? 0 : (o.permissions ?? ASSET_MANAGER_ALL_PERMISSIONS)],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Revoke the asset-manager grant (clears both the active and pending slots). Applies immediately. */
export function revokeAssetManager(o: {
  account: Acct;
  vault: Address;
  network: Network;
  stableCoin: Address;
}): Promise<Hex> {
  return setAssetManager({...o, manager: zeroAddress, expiresAt: 0n});
}

/**
 * Call off an appointment still waiting out the timelock, leaving the manager in force as it is.
 * The vault has no cancel of its own, but re-setting the current grant unchanged is a tightening:
 * it applies at once and clears the pending slot. With no live grant to re-set, a revoke does the
 * same and loses nothing.
 */
export function cancelPendingAssetManager(o: {
  account: Acct;
  vault: Address;
  network: Network;
  stableCoin: Address;
  current: AssetManagerSettings;
}): Promise<Hex> {
  const {manager, expiresAt, permissions} = o.current;
  const live = !isZero(manager) && expiresAt > BigInt(Math.floor(Date.now() / 1000));
  return live
    ? setAssetManager({...o, manager, expiresAt, permissions: Number(permissions)})
    : revokeAssetManager(o);
}

export {isZero as isZeroAddress};

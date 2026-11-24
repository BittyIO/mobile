import type {Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_PENDING_NO_CAP_ABI, VAULT_RISK_ABI} from '@/core/abi';
import {NO_PER_OP_CAP_SINCE, versionAtLeast} from './capabilities';
import {runningVaultVersion} from './vault-abi';

/** What `pendingChanges()` reports, in the older shape's names; the fee cap's pair is 0 from 1.1.1. */
export type PendingChangesRead = {
  lockLevel: number;
  newOwner: Address;
  newOwnerReadyAt: bigint;
  newAssetManager: Address;
  newAssetManagerAt: bigint;
  newAssetManagerPerms: number;
  timelock: bigint;
  timelockAt: bigint;
  sendDailyAllowance: bigint;
  sendDailyAllowanceAt: bigint;
  marketTradeDailyLossAllowance: bigint;
  marketTradeDailyLossAllowanceAt: bigint;
  gasBudgetDaily: bigint;
  gasBudgetDailyAt: bigint;
  maxFeePerOp: bigint;
  maxFeePerOpAt: bigint;
};

/**
 * The vault's `pendingChanges()`, read in the shape its release returns. From 1.1.1 the struct
 * lost the per-operation fee cap's two fields, so the older shape fails to decode it (it is two
 * words short); the release picks the ABI, and a vault whose release cannot be read is tried in the
 * new shape when the old one fails. Throws when neither decodes.
 */
export async function readPendingChanges(vault: Address, network: Network): Promise<PendingChangesRead> {
  const client = publicClientFor(network);
  const version = await runningVaultVersion(vault, network).catch(() => null);
  const readNew = async (): Promise<PendingChangesRead> => {
    const p = await client.readContract({address: vault, abi: VAULT_PENDING_NO_CAP_ABI, functionName: 'pendingChanges'});
    return {...p, maxFeePerOp: 0n, maxFeePerOpAt: 0n};
  };
  const readOld = () => client.readContract({address: vault, abi: VAULT_RISK_ABI, functionName: 'pendingChanges'});
  if (versionAtLeast(version, NO_PER_OP_CAP_SINCE)) return readNew();
  if (version) return readOld();
  return readOld().catch(readNew);
}

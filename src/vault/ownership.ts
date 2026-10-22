/**
 * Handing the vault to another key (v1.0.0). Queued behind the risk timelock, like every other
 * loosening; the pending handover itself is read with the other pending changes ({getPendingChanges}).
 */
import type {Address, Hex} from 'viem';
import type {Network} from '@/core/chain';
import {VAULT_OWNERSHIP_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];
type Base = {account: Acct; vault: Address; network: Network; stableCoin: Address};

/** Queue the handover to `newOwner`; it takes effect when the timelock has run. */
export async function transferOwnership(o: Base & {newOwner: Address}): Promise<Hex> {
  const {hash} = await relayVaultWrite({...o, abi: VAULT_OWNERSHIP_ABI, functionName: 'transferOwnership', args: [o.newOwner]});
  return hash;
}

/** Call off a handover still waiting out the timelock. */
export async function cancelOwnershipTransfer(o: Base): Promise<Hex> {
  const {hash} = await relayVaultWrite({...o, abi: VAULT_OWNERSHIP_ABI, functionName: 'cancelOwnershipTransfer', args: []});
  return hash;
}

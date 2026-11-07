/**
 * Handing the vault to another key (v1.0.0). Queued behind the risk timelock, like every other
 * loosening; the pending handover itself is read with the other pending changes ({getPendingChanges}).
 */
import type {Address, Hex} from 'viem';
import type {Network} from '@/core/chain';
import {VAULT_OWNERSHIP_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];
type Base = {account: Acct; vault: Address; network: Network; stableCoin: Address};

/** Queue the handover to `newOwner`; it takes effect when the timelock has run. */
export async function transferOwnership(o: Base & {newOwner: Address}): Promise<Hex> {
  const {hash} = await relayVaultWrite({...o, abi: VAULT_OWNERSHIP_ABI, functionName: 'transferOwnership', args: [o.newOwner]});
  return hash;
}

/**
 * Take a vault handed to this key: the second step of the two-step handover the vaults deployed
 * today use. Signed by the RECEIVING key — `account` is that key, and `vault` is not its own.
 */
export async function acceptOwnership(o: Base): Promise<Hex> {
  const {hash} = await relayVaultWrite({...o, abi: VAULT_OWNERSHIP_ABI, functionName: 'acceptOwnership', args: []});
  return hash;
}

/** Call off a handover still waiting out the timelock. */
export async function cancelOwnershipTransfer(o: Base): Promise<Hex> {
  const {hash} = await relayVaultWrite({...o, abi: VAULT_OWNERSHIP_ABI, functionName: 'cancelOwnershipTransfer', args: []});
  return hash;
}

/**
 * Hand the vault to a fresh one-time key now, on its own (quantum-safe keys, see wallet/rotation):
 * for a key that has signed and has no operation coming to carry the handover. The fresh key is the
 * one the signer picked and checked; when it could not pick one, the reason is the error.
 */
export async function handOverToFreshKey(o: Base): Promise<Hex> {
  const t = (key: string) => translate(useLanguage.getState().language, key);
  const r = o.account.rotation;
  if (!r) throw new Error(t('mobile.quantum.held_off'));
  if ('held' in r) throw new Error(t(`mobile.quantum.held_${r.held.replace('-', '_')}`));
  const {hash} = await relayVaultWrite({
    ...o,
    abi: VAULT_OWNERSHIP_ABI,
    functionName: 'transferOwnership',
    args: [r.to],
    noRotate: true,
  });
  return hash;
}

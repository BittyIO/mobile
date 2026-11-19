import type {Address, Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {unlockImported} from '@/wallet/keyring';
import {sendFromOwner} from './direct';
import {fetchSafe, type SafeInfo} from './safe';

/**
 * Send a Safe deployment (a new Safe, or one copied from another network) from the imported Safe
 * owner key, which pays its gas — behind Face ID — and wait until the Safe is readable at `safe`.
 * Null if Face ID was cancelled. Throws what the send throws (OwnerGasShort: the key needs gas).
 */
export async function deploySafeFromKey(o: {key: Address; network: Network; factory: Address; data: Hex; safe: Address}): Promise<SafeInfo | null> {
  const account = await unlockImported(o.key);
  if (!account) return null;
  const {hash} = await sendFromOwner({account, network: o.network, to: o.factory, data: o.data});
  const receipt = await publicClientFor(o.network).waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') throw new Error(`Multisig deployment reverted (${hash})`);
  // The server reads the chain it may be a block behind on: asked again for a short while.
  let last: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      return await fetchSafe(o.network, o.safe);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

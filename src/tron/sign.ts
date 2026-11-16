/**
 * Several Tron transactions behind one Face ID: a swap and the fee after it, or an approval and the
 * swap it lets through. The key is derived once, used for each transaction in turn, and wiped when
 * the last is done or one fails. Each is encoded and signed here (see ./tx); the node only gives
 * the block to anchor to and takes the broadcast.
 */
import {unlockRoot} from '@/wallet/keyring';
import {tronAccountAt} from './address';
import {encodeRaw, encodeSigned, signRaw, type TronCall} from './tx';
import {broadcast, refBlock, txStatus} from './client';
import {UnlockCancelled} from './send';
import type {TronNet} from './config';

export type TronSigner = {
  /** Sign and broadcast one transaction; resolves with its id once a node has taken it. */
  send: (call: TronCall, feeLimitSun?: bigint) => Promise<string>;
  /** Wait until `txID` is in a block: true when it did what it said, false when it failed. */
  settle: (txID: string) => Promise<boolean>;
};

export async function withTronKey<T>(net: TronNet, from: string, run: (s: TronSigner) => Promise<T>): Promise<T> {
  const root = await unlockRoot();
  if (!root) throw new UnlockCancelled();
  const account = tronAccountAt(root);
  try {
    // The address the user was shown, and whose balance was checked, must be the key that signs.
    if (account.address !== from) throw new Error("This phone's Tron key does not match the address shown. Unlock the app again and retry.");
    const signer: TronSigner = {
      send: async (call, feeLimitSun) => {
        const raw = encodeRaw(call, await refBlock(net), {feeLimitSun});
        const {txID, signature} = signRaw(raw, account.privateKey);
        return broadcast(net, encodeSigned(raw, signature), txID);
      },
      settle: async (txID) => {
        // Tron confirms in about three seconds; a minute is long past any normal block.
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const s = await txStatus(net, txID).catch(() => 'pending' as const);
          if (s === 'success') return true;
          if (s === 'failed') return false;
        }
        throw new Error('The Tron network has not confirmed the transaction yet. Check it on Tronscan.');
      },
    };
    return await run(signer);
  } finally {
    account.privateKey.fill(0);
  }
}

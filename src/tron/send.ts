/**
 * A payment out of the Tron wallet: TRX, or a listed TRC-20 token.
 *
 * Face ID reads the phrase, the Tron key is derived from it for this one transaction and wiped
 * after, and the transaction is encoded and signed here (see ./tx) — the node is only asked for the
 * block to anchor it to, and to broadcast it.
 */
import {unlockRoot} from '@/wallet/keyring';
import {tronAccountAt} from './address';
import {encodeRaw, encodeSigned, signRaw, type TronCall} from './tx';
import {broadcast, refBlock, type TronFee} from './client';
import type {TronAsset, TronNet} from './config';

export class UnlockCancelled extends Error {
  constructor() {
    super('Unlock cancelled');
    this.name = 'UnlockCancelled';
  }
}

export async function sendTron(opts: {net: TronNet; from: string; to: string; asset: TronAsset; amount: bigint; fee: TronFee}): Promise<string> {
  const {net, from, to, asset, amount, fee} = opts;
  const root = await unlockRoot();
  if (!root) throw new UnlockCancelled();
  const account = tronAccountAt(root);
  try {
    // The address the user was shown — and checked the balance of — must be the key that signs.
    if (account.address !== from) throw new Error('This phone\'s Tron key does not match the address shown. Unlock the app again and retry.');
    const call: TronCall = asset.contract ? {kind: 'trc20', from, token: asset.contract, to, amount} : {kind: 'trx', from, to, amountSun: amount};
    const raw = encodeRaw(call, await refBlock(net), {feeLimitSun: asset.contract ? fee.feeLimitSun : undefined});
    const {txID, signature} = signRaw(raw, account.privateKey);
    return await broadcast(net, encodeSigned(raw, signature), txID);
  } finally {
    account.privateKey.fill(0);
  }
}

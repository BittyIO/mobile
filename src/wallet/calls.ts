/**
 * A WALLET's multi-step writes (core/account-mode): an approval, then the call it allows, and so on.
 *
 * A vault puts such steps in one multicall; a key cannot, so they go as separate transactions from
 * the key, each waiting for the one before to land — the next is simulated against the chain
 * (vault/direct `planOwnerTx`), and an allowance not mined yet would make it revert there.
 *
 * The same path on every chain: vault/direct `sendFromOwner` signs an EVM transaction, or a Tron
 * TriggerSmartContract, from the key, and pays the chain's own fee from it.
 */
import {encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import type {Signer} from '@/wallet/signer';
import {sendFromOwner} from '@/vault/direct';

export type WalletCall = {to: Address; data?: Hex; value?: bigint};

/** The token's `approve` for `spender`, when what it already allows is under `amount`; else nothing. */
export async function approvalIfNeeded(network: Network, owner: Address, token: Address, spender: Address, amount: bigint): Promise<WalletCall[]> {
  const allowed = (await publicClientFor(network).readContract({address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender]})) as bigint;
  if (allowed >= amount) return [];
  /**
   * USDT on Ethereum refuses an approve from one non-zero allowance to another: it must go to zero
   * first. Exactly the amount otherwise, so nothing is left allowed after the call it is for.
   */
  const reset = allowed > BigInt(0) ? [{to: token, data: encodeFunctionData({abi: erc20Abi, functionName: 'approve', args: [spender, BigInt(0)]})}] : [];
  return [...reset, {to: token, data: encodeFunctionData({abi: erc20Abi, functionName: 'approve', args: [spender, amount]})}];
}

/** An unlimited approval, for spenders the app returns to (CoW's relayer): one prompt, not one per trade. */
export async function standingApprovalIfNeeded(network: Network, owner: Address, token: Address, spender: Address, amount: bigint): Promise<WalletCall[]> {
  const allowed = (await publicClientFor(network).readContract({address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender]})) as bigint;
  if (allowed >= amount) return [];
  const reset = allowed > BigInt(0) ? [{to: token, data: encodeFunctionData({abi: erc20Abi, functionName: 'approve', args: [spender, BigInt(0)]})}] : [];
  return [...reset, {to: token, data: encodeFunctionData({abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256]})}];
}

/**
 * Send `calls` in order from the wallet, each once the one before has landed. Resolves with the
 * LAST one's hash (the one the toast follows); a step that reverts stops the rest.
 */
export async function sendWalletCalls(o: {account: Signer; network: Network; calls: WalletCall[]; onStep?: (i: number, n: number) => void}): Promise<{hash: Hex}> {
  const client = publicClientFor(o.network);
  let last: Hex | null = null;
  for (let i = 0; i < o.calls.length; i++) {
    o.onStep?.(i, o.calls.length);
    const c = o.calls[i];
    const {hash} = await sendFromOwner({account: o.account, network: o.network, to: c.to, data: c.data, value: c.value});
    last = hash;
    if (i < o.calls.length - 1) {
      const r = await client.waitForTransactionReceipt({hash, timeout: 180_000});
      if (r.status !== 'success') throw new Error(`Step ${i + 1} of ${o.calls.length} failed on chain (${hash})`);
    }
  }
  if (!last) throw new Error('Nothing to send');
  return {hash: last};
}

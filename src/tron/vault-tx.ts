/**
 * A vault transaction on a Tron network: what vault/direct `sendFromOwner` does on an EVM chain,
 * for a chain whose JSON-RPC accepts no transactions.
 *
 * The call itself is the vault's ordinary calldata — the same bytes the EVM path signs — carried in
 * a Tron `TriggerSmartContract` from the owner's address. It is encoded here (./tx), from the fields
 * the app built, and signed here; the node is asked only for the block to anchor it to (TaPoS) and
 * to broadcast it, exactly as the Tron wallet's own payments are (./send).
 *
 * The key is the vault owner's: the same secp256k1 key, and the same 20 bytes, as on every EVM
 * chain — Tron only writes them as T… — so the owner signs Tron's transaction id with the key the
 * vault already answers to. (Not the Tron wallet's key, which the phrase derives on Tron's own coin
 * type, m/44'/195'.)
 *
 * The id it returns is the transaction id as a 0x hash: Tron's JSON-RPC answers
 * `eth_getTransactionReceipt` for it, so the toasts and receipt waits that follow an EVM hash
 * follow this one unchanged.
 */
import {hexToBytes, type Address, type Hex} from 'viem';
import {sha256} from '@noble/hashes/sha256';
import type {Signer} from '@/wallet/signer';
import {evmToTron, toHex} from './address';
import {broadcast, refBlock} from './client';
import {encodeRaw, encodeSigned} from './tx';
import type {TronChain} from './config';

export async function sendVaultTxOnTron(o: {
  account: Signer;
  net: TronChain;
  to: Address;
  data: Hex;
  value: bigint;
  /** The most the call may burn, in sun (Tron's fee_limit): energy at the plan's estimate and price. */
  feeLimitSun: bigint;
}): Promise<{hash: Hex}> {
  if (!o.account.sign) throw new Error('This key cannot sign a Tron transaction');
  const raw = encodeRaw(
    {kind: 'call', from: evmToTron(o.account.address), contract: evmToTron(o.to), data: hexToBytes(o.data), callValueSun: o.value},
    await refBlock(o.net),
    {feeLimitSun: o.feeLimitSun},
  );
  const txID = toHex(sha256(raw));
  // r ‖ s ‖ v with v = 27 / 28: what TronWeb and TronLink produce, over the transaction id.
  const signature = await o.account.sign({hash: `0x${txID}`});
  const id = await broadcast(o.net, encodeSigned(raw, signature.replace(/^0x/, '')), txID);
  return {hash: `0x${id}`};
}

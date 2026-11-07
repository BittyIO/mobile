/**
 * Tron transactions, built and signed on this phone.
 *
 * The node will happily build a transaction for you (`/wallet/createtransaction`) and hand back the
 * bytes to sign — but then the phone signs whatever the node says, and a node that lied about the
 * recipient would be paid with the user's Face ID. So the bytes are encoded here, from the fields
 * the user confirmed, and only the recent block they reference (TaPoS) comes from the node.
 *
 * The encoding is the protobuf of java-tron's `Transaction.raw` (core/Tron.proto) for the two
 * contracts a wallet pays with — a TRX transfer and a TRC-20 `transfer` call — and nothing more.
 */
import {secp256k1} from '@noble/curves/secp256k1';
import {sha256} from '@noble/hashes/sha256';
import {decodeTronAddress, fromHex, toHex} from './address';

// ---- protobuf, the few wire types needed ----

function varint(n: bigint): number[] {
  if (n < 0n) throw new Error('negative varint');
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return out;
}

const tag = (field: number, wire: 0 | 2) => varint(BigInt((field << 3) | wire));
const fInt = (field: number, v: bigint): number[] => (v === 0n ? [] : [...tag(field, 0), ...varint(v)]);
const fBytes = (field: number, b: Uint8Array | number[]): number[] => (b.length === 0 ? [] : [...tag(field, 2), ...varint(BigInt(b.length)), ...b]);
const fString = (field: number, s: string) => fBytes(field, Array.from(s, (ch) => ch.charCodeAt(0)));

// ---- contracts ----

const TRANSFER = 1; // ContractType.TransferContract
const TRIGGER = 31; // ContractType.TriggerSmartContract

export type TronCall =
  | {kind: 'trx'; from: string; to: string; amountSun: bigint}
  | {kind: 'trc20'; from: string; token: string; to: string; amount: bigint};

const addr = (a: string) => {
  const b = decodeTronAddress(a);
  if (!b) throw new Error(`Not a Tron address: ${a}`);
  return b;
};

/** ABI data for TRC-20 `transfer(address,uint256)`: the selector, then the 20-byte recipient and the amount, each in a 32-byte word. */
export function trc20TransferData(to: string, amount: bigint): Uint8Array {
  const out = new Uint8Array(4 + 64);
  out.set([0xa9, 0x05, 0x9c, 0xbb], 0);
  out.set(addr(to).slice(1), 4 + 12);
  const amt = fromHex(amount.toString(16).padStart(64, '0'));
  out.set(amt, 4 + 32);
  return out;
}

function contractOf(call: TronCall): number[] {
  if (call.kind === 'trx') {
    const value = [...fBytes(1, addr(call.from)), ...fBytes(2, addr(call.to)), ...fInt(3, call.amountSun)];
    const any = [...fString(1, 'type.googleapis.com/protocol.TransferContract'), ...fBytes(2, value)];
    return [...fInt(1, BigInt(TRANSFER)), ...fBytes(2, any)];
  }
  const value = [...fBytes(1, addr(call.from)), ...fBytes(2, addr(call.token)), ...fBytes(4, trc20TransferData(call.to, call.amount))];
  const any = [...fString(1, 'type.googleapis.com/protocol.TriggerSmartContract'), ...fBytes(2, value)];
  return [...fInt(1, BigInt(TRIGGER)), ...fBytes(2, any)];
}

/** The block a transaction is anchored to (TaPoS): it is only valid on a chain that has this block. */
export type RefBlock = {blockID: string; timestamp: number};

/**
 * The raw transaction bytes (what is hashed and signed).
 *
 * Expiry is a minute past the reference block, the node default: long enough to broadcast, short
 * enough that a transaction that did not go out cannot be replayed into the chain later.
 */
export function encodeRaw(call: TronCall, ref: RefBlock, opts: {feeLimitSun?: bigint; now?: number} = {}): Uint8Array {
  const id = ref.blockID;
  const raw = [
    ...fBytes(1, fromHex(id.slice(12, 16))), // ref_block_bytes: bytes 6–7 of the block number
    ...fBytes(4, fromHex(id.slice(16, 32))), // ref_block_hash: bytes 8–15 of the block id
    ...fInt(8, BigInt(ref.timestamp + 60_000)), // expiration
    ...fBytes(11, contractOf(call)),
    ...fInt(14, BigInt(opts.now ?? Date.now())), // timestamp
    ...fInt(18, opts.feeLimitSun ?? 0n), // fee_limit: the most a contract call may burn
  ];
  return Uint8Array.from(raw);
}

/** The transaction id: sha256 of the raw bytes. */
export const txIdOf = (raw: Uint8Array): string => toHex(sha256(raw));

/**
 * Sign: secp256k1 over the transaction id, as r ‖ s ‖ v with v = recovery id + 27 (what TronWeb
 * and TronLink produce; the node accepts 0/1 too).
 */
export function signRaw(raw: Uint8Array, privateKey: Uint8Array): {txID: string; signature: string} {
  const hash = sha256(raw);
  const sig = secp256k1.sign(hash, privateKey);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = sig.recovery + 27;
  return {txID: toHex(hash), signature: toHex(out)};
}

/** The whole signed `Transaction` (raw_data = 1, signature = 2), hex, for `/wallet/broadcasthex`. */
export function encodeSigned(raw: Uint8Array, signatureHex: string): string {
  return toHex(Uint8Array.from([...fBytes(1, raw), ...fBytes(2, fromHex(signatureHex))]));
}

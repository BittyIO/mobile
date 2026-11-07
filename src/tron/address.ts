/**
 * Tron keys and addresses.
 *
 * Same curve as Ethereum (secp256k1) and the same 20 bytes — the last 20 of keccak256 of the public
 * key — behind a 0x41 prefix and written in Base58Check, so they read "T…". The key comes from the
 * same recovery phrase on Tron's own BIP-44 coin type, m/44'/195'/0'/0/0: what TronLink, Trust and
 * Ledger derive, so the phrase opens the same Tron wallet there too.
 */
import {secp256k1} from '@noble/curves/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {sha256} from '@noble/hashes/sha256';
import {createBase58check} from '@scure/base';
import type {HDKey} from 'viem/accounts';

const b58c = createBase58check(sha256);

/** 0x41 + 20 bytes: an address as Tron's protocol carries it. */
export type TronAddressBytes = Uint8Array;

export type TronAccount = {address: string; privateKey: Uint8Array};

/** The Tron path for account `index`. Only 0 is used today: one Tron wallet per phrase. */
export const tronPath = (index = 0) => `m/44'/195'/${index}'/0/0`;

/** The base58 address of an uncompressed or compressed secp256k1 public key. */
export function addressOfPublicKey(pub: Uint8Array): string {
  const full = pub.length === 65 ? pub : secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false);
  const hash = keccak_256(full.slice(1));
  const bytes = new Uint8Array(21);
  bytes[0] = 0x41;
  bytes.set(hash.slice(12), 1);
  return b58c.encode(bytes);
}

/** The Tron account at `index` of the phrase whose root key this is. */
export function tronAccountAt(root: HDKey, index = 0): TronAccount {
  const key = root.derive(tronPath(index));
  if (!key.privateKey || !key.publicKey) throw new Error('Could not derive the Tron key');
  return {address: addressOfPublicKey(key.publicKey), privateKey: key.privateKey};
}

/** The 21 bytes of a base58 Tron address, or null when it is not one (bad checksum, wrong prefix or length). */
export function decodeTronAddress(address: string): TronAddressBytes | null {
  const s = address.trim();
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return null;
  try {
    const bytes = b58c.decode(s);
    return bytes.length === 21 && bytes[0] === 0x41 ? bytes : null;
  } catch {
    return null;
  }
}

export const isTronAddress = (address: string) => decodeTronAddress(address) !== null;

/** The 21-byte address as the 42 hex digits (41…) the node's JSON uses. */
export const tronHex = (address: string): string => {
  const b = decodeTronAddress(address);
  if (!b) throw new Error(`Not a Tron address: ${address}`);
  return toHex(b);
};

/** A 41… hex address from the node back to base58. */
export const fromTronHex = (hex: string): string => b58c.encode(fromHex(hex));

/**
 * The address in a scanned QR code, or null. Wallets encode a Tron address bare or as a `tron:` link
 * (`tron:T…?amount=…`); either way it is the first well-formed T-address in the text.
 */
export function tronAddressInQr(text: string): string | null {
  for (const m of text.matchAll(/T[1-9A-HJ-NP-Za-km-z]{33}/g)) if (isTronAddress(m[0])) return m[0];
  return null;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('Bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

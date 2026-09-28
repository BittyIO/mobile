import type {Hex, TypedDataDefinition} from 'viem';

/**
 * The only capability the vault modules need from "whoever owns this vault": an address, and the
 * ability to sign an EIP-712 typed-data payload (ForwardRequest, CoW order, activation, …).
 *
 * The signer is backed by the on-device embedded keyring — the mnemonic is read from the Keychain
 * (Face ID) per action and derived into a viem account, which satisfies this shape directly.
 */
export interface Signer {
  address: Hex;
  signTypedData(params: TypedDataDefinition): Promise<Hex>;
}

import type {Address, Hex, LocalAccount, TypedDataDefinition} from 'viem';

/**
 * The only capability the vault modules need from "whoever owns this vault": an address, and the
 * ability to sign an EIP-712 typed-data payload (ForwardRequest, CoW order, activation, …).
 *
 * The signer is backed by the on-device embedded keyring — the mnemonic is read from the Keychain
 * (Face ID) per action and derived into a viem account, which satisfies this shape directly.
 *
 * A vault owned by a Safe has a signer of the same shape (see vault/safe `safeSigner`): its address
 * is the Safe, and its signature is the Safe's — this device's key as one of the Safe's owners, plus
 * whichever co-owners the Safe's threshold needs.
 */
export interface Signer {
  address: Hex;
  signTypedData(params: TypedDataDefinition): Promise<Hex>;
  /**
   * True when {@link address} is a contract wallet (a Safe) rather than a key. Its signatures are
   * checked with ERC-1271 against that address, never recovered, so wherever a signature goes to a
   * contract that would otherwise recover it — the CoW intent clone — it has to say who signed
   * (see core/cow `orderSignerSig`). Absent means a key.
   */
  isContract?: boolean;
  /**
   * How long a signed payload must stay valid, at least, because collecting the signature takes
   * that long — co-owners of a Safe sign on their own time. Payloads that carry a deadline use this
   * instead of their usual few minutes. Absent means the signature is ready the moment it is asked
   * for.
   */
  approvalWindowSeconds?: number;
  /**
   * Sign a transaction for the owner to send itself — the network fee paid by the owner wallet
   * rather than the vault (see vault/direct). Only a key can: a Safe has no transactions of its
   * own, so its signer leaves this out and its vault always pays through the relayer.
   */
  signTransaction?: LocalAccount['signTransaction'];
  /**
   * For a vault on quantum-safe keys (see ./rotation): the fresh key this write hands the vault to,
   * appended to the write itself by the relay — or why this one does not. Absent for a vault that
   * does not use them.
   */
  rotation?: {to: Address} | {held: import('./rotation').RotationHold};
}

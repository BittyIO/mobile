/**
 * Vaults owned by a Safe.
 *
 * Every vault contract that takes an owner signature — the factory's signed activation, the
 * forwarder, the CoW adapter from 1.0.2 — checks it with ERC-1271 against the Safe. So a Safe vault
 * runs the same flows as any other; only the SIGNATURE differs: it is the Safe's, made of its
 * owners' signatures of the Safe's EIP-712 `SafeMessage` over what the vault asks to be signed.
 *
 * This device's key is one of those owners. With a threshold of one it is the whole signature and a
 * Safe vault behaves exactly like a key-owned one. Above that, the device's signature is filed with
 * the Bitty API (web /api/ethereum/safe/*), co-owners add theirs — from this app on their own
 * phones, a wallet, or scripts/safe-vault-call.mjs — and the operation is finished once there are
 * enough (see ./safe-finish). The API keeps the payload itself, so any owner can finish it from any
 * device; nothing about a pending request is kept on this phone.
 */
import {hashTypedData, type Address, type Hex, type LocalAccount, type TypedDataDefinition} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiUrl, CHAIN_ID, type Network} from '@/core/chain';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';

/**
 * How long a payload signed by a multi-owner Safe stays valid: long enough for co-owners to sign on
 * their own time. Forwarder requests and activations carry this as their deadline.
 */
export const SAFE_APPROVAL_WINDOW_SECONDS = 24 * 3600;

export type SafeInfo = {
  address: Address;
  chainId: number;
  version: string;
  owners: Address[];
  threshold: number;
  nonce: string;
  fallbackHandler: Address | null;
  supported: boolean;
  problems: ('unsupported-version' | 'no-fallback-handler')[];
};

/** A payload being signed by a Safe's owners, as the API reports it. */
export type SafeMessageStatus = {
  messageHash: Hex;
  safe: Address;
  primaryType: 'ForwardRequest' | 'Activation' | 'Order' | 'TwapOrder' | 'OrderCancellations' | string;
  /** The EIP-712 payload, JSON: bigints as decimal strings, EIP712Domain spelled out. */
  typedData: {
    domain: {name?: string; version?: string; chainId: number; verifyingContract: Address};
    types: Record<string, {name: string; type: string}[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  proposedBy: Address;
  expiresAt: number | null;
  threshold: number;
  signers: Address[];
  /** The Safe's combined signature, once enough current owners signed and the Safe accepts it. */
  signature: Hex | null;
  ready: boolean;
};

export class SafeApiError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function api<T>(network: Network, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path, network), {
    method,
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as ({ok?: boolean; reason?: string; error?: string} & T) | null;
  if (!res.ok || !json?.ok) throw new SafeApiError(json?.reason ?? json?.error ?? `HTTP ${res.status}`);
  return json;
}

/** The Safe at `safe` on `network`, read on-chain by the API; throws `safe-not-found` if none. */
export async function fetchSafe(network: Network, safe: Address): Promise<SafeInfo> {
  return (await api<{safe: SafeInfo}>(network, 'GET', `/api/ethereum/safe/${safe}`)).safe;
}

/** What is waiting to be signed for `safe`, newest first. */
export async function listSafeMessages(network: Network, safe: Address): Promise<SafeMessageStatus[]> {
  return (await api<{messages: SafeMessageStatus[]}>(network, 'GET', `/api/ethereum/safe/${safe}/messages`)).messages;
}

export async function getSafeMessage(network: Network, hash: Hex): Promise<SafeMessageStatus> {
  return (await api<{status: SafeMessageStatus}>(network, 'GET', `/api/ethereum/safe/messages/${hash}`)).status;
}

/** EIP-712 typed data as JSON the API takes: bigints as decimal strings. */
export function typedDataJson(td: TypedDataDefinition): unknown {
  return JSON.parse(JSON.stringify(td, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** The Safe's SafeMessage over `inner` — what each owner signs, and what the Safe verifies. */
export function safeMessageFor(network: Network, safe: Address, innerHash: Hex): TypedDataDefinition {
  return {
    domain: {chainId: CHAIN_ID[network], verifyingContract: safe},
    types: {SafeMessage: [{name: 'message', type: 'bytes'}]},
    primaryType: 'SafeMessage',
    message: {message: innerHash},
  };
}

/** The API's typed data, with the domain type viem derives on its own left out. */
export function definitionOf(status: SafeMessageStatus): TypedDataDefinition {
  const {EIP712Domain: _domain, ...types} = status.typedData.types;
  return {...status.typedData, types} as unknown as TypedDataDefinition;
}

/**
 * Add this device's signature to a pending message. The API checks it recovers to a current owner.
 */
export async function cosign(o: {network: Network; device: LocalAccount; status: SafeMessageStatus}): Promise<SafeMessageStatus> {
  // Signed over what the payload hashes to HERE, not over the hash the server reports: a co-owner
  // signs what they were shown, and a server that lied about the payload gets a useless signature.
  const inner = hashTypedData(definitionOf(o.status));
  const msg = safeMessageFor(o.network, o.status.safe, inner);
  if (hashTypedData(msg).toLowerCase() !== o.status.messageHash.toLowerCase()) {
    throw new SafeApiError('message-mismatch');
  }
  const signature = await o.device.signTypedData(msg);
  return (await api<{status: SafeMessageStatus}>(o.network, 'POST', `/api/ethereum/safe/messages/${o.status.messageHash}/signatures`, {signature})).status;
}

/**
 * Thrown by a Safe signer when its signature is not complete yet: this device has signed and filed
 * the payload, and co-owners still have to sign. The operation is not lost — it finishes from the
 * Safe approvals screen once they have.
 */
export class SafeSignaturePending extends Error {
  constructor(readonly status: SafeMessageStatus) {
    super(
      translate(useLanguage.getState().language, 'mobile.safe.pending_toast', {
        have: status.signers.length,
        need: status.threshold,
      }),
    );
  }
}

/**
 * The signer for a Safe-owned vault: address = the Safe, signature = the Safe's.
 *
 * `threshold` is read by the caller when the signer is made, so it is current for this operation.
 * With one, this device's signature of the SafeMessage IS the Safe's signature and comes back at
 * once. Above one it is filed with the API; if co-owners have already brought it to the threshold
 * the combined signature comes back, otherwise {@link SafeSignaturePending} is thrown.
 */
export function safeSigner(o: {device: LocalAccount; safe: Address; network: Network; threshold: number}): Signer {
  const multi = o.threshold > 1;
  return {
    address: o.safe,
    isContract: true,
    approvalWindowSeconds: multi ? SAFE_APPROVAL_WINDOW_SECONDS : undefined,
    async signTypedData(td) {
      const signature = await o.device.signTypedData(safeMessageFor(o.network, o.safe, hashTypedData(td)));
      if (!multi) return signature;
      const {status} = await api<{status: SafeMessageStatus}>(o.network, 'POST', `/api/ethereum/safe/${o.safe}/messages`, {
        typedData: typedDataJson(td),
        signature,
      });
      if (status.ready && status.signature) return status.signature;
      throw new SafeSignaturePending(status);
    },
  };
}

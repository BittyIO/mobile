/**
 * Payments — plain sends and the whitelist (address book), all relayed gaslessly. A send pays from
 * the vault's free balance (empty withdraw arrays) or pulls from named positions to cover itself.
 *
 * Scheduled payments and the operator-proposed-send flow are GONE: the vault redesign removed both
 * from the contract, so the functions that drove those screens went with the screens.
 */
import {maxUint256, parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, apiUrl, publicClientFor, type Network} from '@/core/chain';
import {VAULT_PAYMENTS_ABI, VAULT_RISK_ABI, WHITELIST_STATUS} from '@/core/abi';
import {assetMeta} from '@/core/assets';
import {relayVaultMulticall, relayVaultWrite, type VaultCall} from './relay';

/** Send `amount` of `asset` from the vault to `recipient` (from free balance). */
export async function sendPayment(o: {
  account: Signer;
  vault: Address;
  network: Network;
  recipient: Address;
  asset: Address;
  amount: string; // human — the TOTAL to send (free + any protocol-sourced amounts)
  decimals?: number;
  stableCoin: Address;
  /** Bill exactly `stableCoin`: see {relayVaultWrite}. */
  pinFee?: boolean;
  /** Pull these amounts from these protocol positions to cover the send (e.g. an Aave/Sky position). */
  withdrawProtocols?: Address[];
  withdrawAmounts?: bigint[];
}): Promise<Hex> {
  const decimals = o.decimals ?? assetMeta(o.network, o.asset).decimals;
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'send',
    args: [o.recipient, o.asset, parseUnits(o.amount, decimals), o.withdrawProtocols ?? [], o.withdrawAmounts ?? []],
    stableCoin: o.stableCoin,
    pinFee: o.pinFee,
  });
  return hash;
}

/**
 * One leg of a payment: what, how much, and which positions to unwind to cover it. Every leg goes to
 * the same recipient — the vault pays one recipient per call.
 */
export type SendRow = {
  asset: Address;
  amount: string;
  /** The token's decimals, for one the catalog does not know (a token pasted in by address). */
  decimals?: number;
  withdrawProtocols?: Address[];
  withdrawAmounts?: bigint[];
};

/**
 * Several assets to one recipient, as one `batchSend` — or, with `andAdd`, as one
 * `batchSendAndAddWhitelistedRecipient`, which also saves the recipient.
 */
function batchSendCall(network: Network, recipient: Address, rows: SendRow[], andAdd = false): VaultCall {
  const assets = rows.map((r) => r.asset);
  const amounts = rows.map((r) => parseUnits(r.amount, r.decimals ?? assetMeta(network, r.asset).decimals));
  const withdrawProtocols = rows.map((r) => r.withdrawProtocols ?? []);
  const withdrawAmounts = rows.map((r) => r.withdrawAmounts ?? []);
  return {
    abi: VAULT_PAYMENTS_ABI,
    functionName: andAdd ? 'batchSendAndAddWhitelistedRecipient' : 'batchSend',
    args: [recipient, assets, amounts, withdrawProtocols, withdrawAmounts],
  };
}

/** Send several assets to one recipient in ONE tx. */
export async function batchSendPayment(o: {
  account: Signer;
  vault: Address;
  network: Network;
  recipient: Address;
  rows: SendRow[];
  stableCoin: Address;
  /** Bill exactly `stableCoin`: see {relayVaultWrite}. */
  pinFee?: boolean;
}): Promise<Hex> {
  const call = batchSendCall(o.network, o.recipient, o.rows);
  const {hash} = await relayVaultWrite({account: o.account, vault: o.vault, network: o.network, ...call, stableCoin: o.stableCoin, pinFee: o.pinFee});
  return hash;
}

/**
 * Pay one recipient and, if asked, add them to the address book, in ONE transaction.
 *
 * As two transactions that is two Face ID prompts and two relay fees, and a window in between where
 * the book has an entry that was never paid. It is one call that does both —
 * `sendAndAddWhitelistedRecipient`, or the batch form for several assets — which costs about 9,000
 * gas less than the same two in a multicall: the owner and lock checks run once and the calldata is
 * under half the size. One signature and one fee, and both land or neither does.
 * Without the add it falls through to the plain send.
 */
export async function sendWithWhitelist(o: {
  account: Signer;
  vault: Address;
  network: Network;
  recipient: Address;
  rows: SendRow[];
  /** Write the recipient into the book in the same transaction. */
  addToWhitelist: boolean;
  stableCoin: Address;
  /** Bill exactly `stableCoin`: see {relayVaultWrite}. */
  pinFee?: boolean;
}): Promise<Hex> {
  if (!o.addToWhitelist) {
    return o.rows.length === 1
      ? sendPayment({...o, ...o.rows[0]})
      : batchSendPayment({account: o.account, vault: o.vault, network: o.network, recipient: o.recipient, rows: o.rows, stableCoin: o.stableCoin, pinFee: o.pinFee});
  }

  const row = o.rows[0];
  const call: VaultCall =
    o.rows.length === 1
      ? {
          abi: VAULT_PAYMENTS_ABI,
          functionName: 'sendAndAddWhitelistedRecipient',
          args: [o.recipient, row.asset, parseUnits(row.amount, row.decimals ?? assetMeta(o.network, row.asset).decimals), row.withdrawProtocols ?? [], row.withdrawAmounts ?? []],
        }
      : batchSendCall(o.network, o.recipient, o.rows, true);
  const {hash} = await relayVaultWrite({account: o.account, vault: o.vault, network: o.network, ...call, stableCoin: o.stableCoin, pinFee: o.pinFee});
  return hash;
}

// ---- Whitelist / address book ----

/**
 * An address-book entry. It is read from the vault itself and carries what the contract says about
 * it: its `status` (WHITELIST_STATUS), when it becomes payable, and when a queued removal lands (unix
 * seconds, 0 for none). An entry from the server — when the chain read failed — has none of those.
 * An entry accepts any asset.
 */
export type WhitelistedRecipient = {
  id: string;
  recipientAddress: string;
  status?: number;
  effectiveAt?: number;
  removeAt?: number;
};

/** The call that writes `recipient` into the book. */
function addRecipientCall(recipient: Address): VaultCall {
  return {abi: VAULT_PAYMENTS_ABI, functionName: 'addWhitelistedRecipient', args: [recipient]};
}

/** Add a recipient to the address book. It accepts any asset the vault holds. */
export async function addWhitelisted(o: {
  account: Signer;
  vault: Address;
  network: Network;
  recipient: Address;
  stableCoin: Address;
  /** Bill exactly `stableCoin`: see {relayVaultWrite}. */
  pinFee?: boolean;
}): Promise<Hex> {
  const call = addRecipientCall(o.recipient);
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    stableCoin: o.stableCoin,
    pinFee: o.pinFee,
  });
  return hash;
}

export async function removeWhitelisted(o: {
  account: Signer;
  vault: Address;
  network: Network;
  id: string;
  stableCoin: Address;
  /** Bill exactly `stableCoin`: see {relayVaultWrite}. */
  pinFee?: boolean;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'removeWhitelistedRecipients',
    args: [[BigInt(o.id)]],
    stableCoin: o.stableCoin,
    pinFee: o.pinFee,
  });
  return hash;
}

/**
 * Pay a whitelisted recipient by id: one `sendToWhitelistedRecipient` per row, several as one
 * multicall. The way out for anything a plain send refuses — a token that is not an allowed
 * stablecoin, or one the catalog does not list at all — since the vault pays a whitelisted
 * recipient any token it holds, unmetered by the daily send allowance.
 */
export async function sendToWhitelisted(o: {
  account: Signer;
  vault: Address;
  network: Network;
  id: string;
  rows: SendRow[];
  stableCoin: Address;
  /** Bill exactly `stableCoin`: see {relayVaultWrite}. */
  pinFee?: boolean;
}): Promise<Hex> {
  const calls: VaultCall[] = o.rows.map((r) => ({
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'sendToWhitelistedRecipient',
    args: [
      BigInt(o.id),
      r.asset,
      parseUnits(r.amount, r.decimals ?? assetMeta(o.network, r.asset).decimals),
      r.withdrawProtocols ?? [],
      r.withdrawAmounts ?? [],
    ],
  }));
  const base = {account: o.account, vault: o.vault, network: o.network, stableCoin: o.stableCoin, pinFee: o.pinFee};
  const {hash} = calls.length === 1 ? await relayVaultWrite({...base, ...calls[0]}) : await relayVaultMulticall({...base, calls});
  return hash;
}

/**
 * The address book, read straight from the vault — the list is the vault's way out after a key
 * leaks, so it comes from the contract rather than an indexer that can lag or be wrong — in one
 * call, with removed entries left out. The server's list is the fallback, only when the chain cannot
 * be reached.
 */
export async function fetchWhitelist(vault: Address, network: Network): Promise<WhitelistedRecipient[]> {
  // From the vault only, never the server: these are the addresses money may leave to, so a list a
  // compromised server supplied could steer a payment. A failed read shows an empty book, not a
  // stand-in.
  try {
    const [, entries] = await publicClientFor(network).readContract({
      address: vault,
      abi: VAULT_PAYMENTS_ABI,
      functionName: 'getWhitelist',
      args: [1n, maxUint256],
    });
    return entries
      .filter((e) => e.status !== WHITELIST_STATUS.removed)
      .map((e) => ({
        id: e.id.toString(),
        recipientAddress: e.recipient,
        status: e.status,
        effectiveAt: Number(e.effectiveAt),
        removeAt: Number(e.removeAt),
      }));
  } catch {
    return [];
  }
}

/**
 * The entries a forever lock may name as its way out: the ones the vault can pay right now.
 *
 * Both answers come from the contract, never from windows and lock epochs rebuilt here, since a copy
 * of the vault's rule in the app is one that can drift. An entry read from the vault already carries
 * the contract's verdict: payable, or payable until a queued removal lands. One that came from the
 * server instead is asked by simulating `foreverLock(id)` as the owner, which changes nothing.
 */
export async function fetchEscapeIds(
  vault: Address,
  owner: Address,
  network: Network,
  book: WhitelistedRecipient[],
): Promise<string[]> {
  // Never the vault itself: after a forever lock money can only leave to the escape, and an escape
  // back into the vault leaves it nowhere to go — the contract refuses it (requireEscape), so it was
  // offered here, picked by default, and then failed on confirm.
  book = book.filter((b) => b.recipientAddress.toLowerCase() !== vault.toLowerCase());
  if (book.length === 0) return [];
  if (book.every((b) => b.status !== undefined)) {
    return book
      .filter((b) => b.status === WHITELIST_STATUS.payable || b.status === WHITELIST_STATUS.removalQueued)
      .map((b) => b.id);
  }
  const ids = book.map((b) => b.id);
  const client = publicClientFor(network);
  const ok = await Promise.all(
    ids.map((id) =>
      client
        .simulateContract({address: vault, abi: VAULT_RISK_ABI, functionName: 'foreverLock', args: [BigInt(id)], account: owner})
        .then(() => true)
        .catch(() => false),
    ),
  );
  return ids.filter((_, i) => ok[i]);
}

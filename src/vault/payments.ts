/**
 * Payments — plain sends and the whitelist (address book), all relayed gaslessly. A send pays from
 * the vault's free balance (empty withdraw arrays) or pulls from named positions to cover itself.
 *
 * Scheduled payments and the operator-proposed-send flow are GONE: the vault redesign removed both
 * from the contract, so the functions that drove those screens went with the screens.
 */
import {maxUint256, parseUnits, zeroAddress, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, apiUrl, customRpc, publicClientFor, type Network} from '@/core/chain';
import {VAULT_PAYMENTS_ABI, VAULT_PAYMENTS_V103_ABI, VAULT_RISK_ABI, WHITELIST_STATUS} from '@/core/abi';
import {isLegacy} from '@/core/vault-generation';
import {assetMeta} from '@/core/assets';
import {relayVaultWrite, relayVaultMulticall, type VaultCall} from './relay';

/** Send `amount` of `asset` from the vault to `recipient` (from free balance). */
export async function sendPayment(o: {
  account: Signer;
  vault: Address;
  network: Network;
  recipient: Address;
  asset: Address;
  amount: string; // human — the TOTAL to send (free + any protocol-sourced amounts)
  stableCoin: Address;
  /** Pull these amounts from these protocol positions to cover the send (e.g. an Aave/Sky position). */
  withdrawProtocols?: Address[];
  withdrawAmounts?: bigint[];
}): Promise<Hex> {
  const {decimals} = assetMeta(o.network, o.asset);
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'send',
    args: [o.recipient, o.asset, parseUnits(o.amount, decimals), o.withdrawProtocols ?? [], o.withdrawAmounts ?? []],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Send the same/different assets to several recipients in ONE tx (from free balance). */
export async function batchSendPayment(o: {
  account: Signer;
  vault: Address;
  network: Network;
  rows: {recipient: Address; asset: Address; amount: string; withdrawProtocols?: Address[]; withdrawAmounts?: bigint[]}[];
  stableCoin: Address;
}): Promise<Hex> {
  const recipients = o.rows.map((r) => r.recipient);
  const assets = o.rows.map((r) => r.asset);
  const amounts = o.rows.map((r) => parseUnits(r.amount, assetMeta(o.network, r.asset).decimals));
  const withdrawProtocols = o.rows.map((r) => r.withdrawProtocols ?? []);
  const withdrawAmounts = o.rows.map((r) => r.withdrawAmounts ?? []);
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'batchSend',
    args: [recipients, assets, amounts, withdrawProtocols, withdrawAmounts],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** One row of a send: who, what, how much, and which positions to unwind to cover it. */
export type SendRow = {
  recipient: Address;
  asset: Address;
  amount: string;
  withdrawProtocols?: Address[];
  withdrawAmounts?: bigint[];
};

/**
 * Add recipients to the address book and pay them, in ONE transaction.
 *
 * A vault with new-payment protection on will not pay an address it has never seen, so sending to
 * someone new is two steps — whitelist, then send. As two transactions that is two Face ID prompts
 * and two relay fees, and a window in between where the book has an entry that was never paid. As
 * one `vault.multicall` it is one signature, one fee, and either both land or neither does.
 *
 * `addRecipients` is only the addresses not already in the book; the caller works that out, since
 * it is the one holding the book. An empty list falls through to the plain send, which is cheaper
 * to encode and identical in effect.
 *
 * Order matters and is the whole point: every `addWhitelistedRecipient` is encoded before the
 * send, and multicall preserves it, so the send is validated against a book that already has the
 * recipient in it.
 */
export async function sendWithWhitelist(o: {
  account: Signer;
  vault: Address;
  network: Network;
  rows: SendRow[];
  /** Entries to write into the book first, deduplicated by the caller. */
  addRecipients: {recipient: Address}[];
  stableCoin: Address;
}): Promise<Hex> {
  if (o.addRecipients.length === 0) {
    return o.rows.length === 1
      ? sendPayment({...o, ...o.rows[0]})
      : batchSendPayment({account: o.account, vault: o.vault, network: o.network, rows: o.rows, stableCoin: o.stableCoin});
  }

  const amount = (r: SendRow) => parseUnits(r.amount, assetMeta(o.network, r.asset).decimals);
  const send: VaultCall =
    o.rows.length === 1
      ? {
          abi: VAULT_PAYMENTS_ABI,
          functionName: 'send',
          args: [o.rows[0].recipient, o.rows[0].asset, amount(o.rows[0]), o.rows[0].withdrawProtocols ?? [], o.rows[0].withdrawAmounts ?? []],
        }
      : {
          abi: VAULT_PAYMENTS_ABI,
          functionName: 'batchSend',
          args: [
            o.rows.map((r) => r.recipient),
            o.rows.map((r) => r.asset),
            o.rows.map(amount),
            o.rows.map((r) => r.withdrawProtocols ?? []),
            o.rows.map((r) => r.withdrawAmounts ?? []),
          ],
        };

  const {hash} = await relayVaultMulticall({
    account: o.account,
    vault: o.vault,
    network: o.network,
    calls: [
      ...o.addRecipients.map((r) => addRecipientCall(r.recipient)),
      send,
    ],
    stableCoin: o.stableCoin,
  });
  return hash;
}

// ---- Whitelist / address book ----

/**
 * An address-book entry. On v1.0.0 it is read from the vault itself and carries what the contract
 * says about it: its `status` (WHITELIST_STATUS), when it becomes payable, and when a queued removal
 * lands (unix seconds, 0 for none). An entry from the server — every v1.0.3 one, or a v1.0.0 one when
 * the chain read failed — has none of those. `allowedAsset` only ever appears on a v1.0.3 entry, and
 * the app no longer narrows one: a v1.0.0 entry accepts any asset.
 */
export type WhitelistedRecipient = {
  id: string;
  recipientAddress: string;
  allowedAsset?: string;
  status?: number;
  effectiveAt?: number;
  removeAt?: number;
};

/**
 * The call that writes `recipient` into the book. v1.0.0 takes the address alone; v1.0.3 also names
 * the asset the entry may be paid in, and is always given "any", which is what its zero address means.
 */
function addRecipientCall(recipient: Address): VaultCall {
  return isLegacy()
    ? {abi: VAULT_PAYMENTS_V103_ABI, functionName: 'addWhitelistedRecipient', args: [recipient, zeroAddress]}
    : {abi: VAULT_PAYMENTS_ABI, functionName: 'addWhitelistedRecipient', args: [recipient]};
}

/** Add a recipient to the address book. It accepts any asset the vault holds. */
export async function addWhitelisted(o: {
  account: Signer;
  vault: Address;
  network: Network;
  recipient: Address;
  stableCoin: Address;
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
  });
  return hash;
}

export async function removeWhitelisted(o: {
  account: Signer;
  vault: Address;
  network: Network;
  id: string;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'removeWhitelistedRecipients',
    args: [[BigInt(o.id)]],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Pay a whitelisted recipient by id (from free balance). */
export async function sendToWhitelisted(o: {
  account: Signer;
  vault: Address;
  network: Network;
  id: string;
  asset: Address;
  amount: string;
  stableCoin: Address;
}): Promise<Hex> {
  const {decimals} = assetMeta(o.network, o.asset);
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'sendToWhitelistedRecipient',
    args: [BigInt(o.id), o.asset, parseUnits(o.amount, decimals), [], []],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/**
 * The address book. On v1.0.0 it is read straight from the vault — the list is the vault's way out
 * after a key leaks, so it comes from the contract rather than an indexer that can lag or be wrong —
 * in one call, with removed entries left out. The server's list is the fallback: always for v1.0.3,
 * which has no such read, and for v1.0.0 only when the chain cannot be reached.
 */
export async function fetchWhitelist(vault: Address, network: Network): Promise<WhitelistedRecipient[]> {
  if (!isLegacy()) {
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
      // With the owner's own RPC set, the server's list is exactly the source they chose not to
      // trust; otherwise fall through to it.
      if (customRpc(network)) return [];
    }
  }
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/whitelisted-recipients/${vault}`, network));
    if (!res.ok) return [];
    const j = (await res.json()) as {data?: WhitelistedRecipient[]};
    return j.data ?? [];
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
  if (isLegacy() || book.length === 0) return [];
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

/**
 * Payments — plain sends and the whitelist (address book), all relayed gaslessly. A send pays from
 * the vault's free balance (empty withdraw arrays) or pulls from named positions to cover itself.
 *
 * Scheduled payments and the operator-proposed-send flow are GONE: the vault redesign removed both
 * from the contract, so the functions that drove those screens went with the screens.
 */
import {parseUnits, zeroAddress, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, apiUrl, publicClientFor, type Network} from '@/core/chain';
import {VAULT_PAYMENTS_ABI, VAULT_PAYMENTS_V103_ABI, VAULT_RISK_ABI} from '@/core/abi';
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
 * An address-book entry as the server lists it. `allowedAsset` only ever appears on a v1.0.3 vault's
 * entries, and the app no longer narrows one: a v1.0.0 entry accepts any asset.
 */
export type WhitelistedRecipient = {id: string; recipientAddress: string; allowedAsset?: string};

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

export async function fetchWhitelist(vault: Address, network: Network): Promise<WhitelistedRecipient[]> {
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
 * When each entry's queued removal lands (unix seconds), keyed by id — only the entries with one.
 *
 * On v1.0.0, removing an entry the vault can already pay does not take it off at once: it waits out
 * the timelock, staying payable until then, and a lock voids it. So the ✕ may only have queued it,
 * and the book has to say so rather than show the entry as if nothing had happened. v1.0.3 removes
 * at once, so there is nothing to read there. An empty answer on any failure: this only annotates.
 */
export async function fetchRemovals(vault: Address, network: Network, ids: string[]): Promise<Record<string, number>> {
  if (isLegacy() || ids.length === 0) return {};
  try {
    const ats = await publicClientFor(network).readContract({
      address: vault,
      abi: VAULT_PAYMENTS_ABI,
      functionName: 'getWhitelistedRecipientRemovals',
      args: [ids.map((id) => BigInt(id))],
    });
    const out: Record<string, number> = {};
    ats.forEach((at, i) => {
      if (at > 0n) out[ids[i]] = Number(at);
    });
    return out;
  } catch {
    return {};
  }
}

/**
 * The entries a forever lock may name as its way out: the ones the vault can pay right now.
 *
 * Asked of the contract itself, by simulating `foreverLock(id)` as the owner, rather than rebuilt
 * here from windows and lock epochs: the vault's own rule is the one that decides, and a copy of it
 * in the app is one that can drift. A simulation changes nothing.
 */
export async function fetchEscapeIds(vault: Address, owner: Address, network: Network, ids: string[]): Promise<string[]> {
  if (isLegacy() || ids.length === 0) return [];
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

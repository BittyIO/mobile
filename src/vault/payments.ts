/**
 * Payments — plain sends and scheduled/recurring payments, all relayed gaslessly. Ported from web
 * sendPayment / addScheduledPayment. A send pays from the vault's free balance (empty withdraw arrays);
 * a scheduled payment recurs from a start time and is executed with payScheduled when due.
 */
import {parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, apiUrl, type Network} from '@/core/chain';
import {VAULT_PAYMENTS_ABI} from '@/core/abi';
import {assetMeta} from '@/core/assets';
import {relayVaultWrite, relayVaultMulticall, type VaultCall} from './relay';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

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

/** Schedule a payment. `interval` = 0 for one-time; `count` = number of payments. */
export async function addScheduledPayment(o: {
  account: Signer;
  vault: Address;
  network: Network;
  recipient: Address;
  asset: Address;
  amount: string; // human, per payment
  startTimestamp: number; // unix seconds
  intervalSeconds: number; // 0 = one-time
  count: number;
  stableCoin: Address;
  /** An address allowed to trigger the payment (zero = anyone / the keeper). */
  trigger?: Address;
  /** Locked once approved: no later edit or removal. */
  isImmutable?: boolean;
  /** Pay what the vault holds when the full amount is short, instead of skipping. */
  payWithInsufficientBalance?: boolean;
}): Promise<Hex> {
  const {decimals} = assetMeta(o.network, o.asset);
  const payment = {
    scheduledPaymentAddress: o.recipient,
    paymentCount: BigInt(o.count),
    isImmutable: o.isImmutable ?? false,
    payWithInsufficientBalance: o.payWithInsufficientBalance ?? false,
    trigger: o.trigger ?? ZERO,
    assetAddress: o.asset,
    amount: parseUnits(o.amount, decimals),
    startTimestamp: BigInt(o.startTimestamp),
    paymentInterval: BigInt(o.intervalSeconds),
  };
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'addScheduledPayment',
    args: [payment],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Remove a scheduled payment by id. */
export async function removeScheduledPayment(o: {
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
    functionName: 'removeScheduledPayments',
    args: [[BigInt(o.id)]],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/**
 * Execute a due scheduled payment now. `withdrawProtocols` (adapter addresses) funds the payment by
 * pulling from those positions when free balance is short — the v1.0.x replacement for the old
 * payScheduledFromStaking/Lending. Empty = pay from free balance.
 */
export async function payScheduledNow(o: {
  account: Signer;
  vault: Address;
  network: Network;
  id: string;
  stableCoin: Address;
  withdrawProtocols?: Address[];
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'payScheduled',
    args: [BigInt(o.id), o.withdrawProtocols ?? []],
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
  /**
   * Entries to write into the book first, deduplicated by the caller.
   *
   * `allowedAsset` is what that entry may be paid in; the zero address means any of them, which
   * is what the contract reads an unset asset as.
   */
  addRecipients: {recipient: Address; allowedAsset?: Address}[];
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
      ...o.addRecipients.map((r): VaultCall => ({
        abi: VAULT_PAYMENTS_ABI,
        functionName: 'addWhitelistedRecipient',
        args: [r.recipient, r.allowedAsset ?? ZERO],
      })),
      send,
    ],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Edit an existing scheduled payment (same struct as add). */
export async function updateScheduledPayment(o: {
  account: Signer;
  vault: Address;
  network: Network;
  id: string;
  recipient: Address;
  asset: Address;
  amount: string;
  startTimestamp: number;
  intervalSeconds: number;
  count: number;
  stableCoin: Address;
  /** An address allowed to trigger the payment (zero = anyone / the keeper). */
  trigger?: Address;
  /** Locked once approved: no later edit or removal. */
  isImmutable?: boolean;
  /** Pay what the vault holds when the full amount is short, instead of skipping. */
  payWithInsufficientBalance?: boolean;
}): Promise<Hex> {
  const {decimals} = assetMeta(o.network, o.asset);
  const payment = {
    scheduledPaymentAddress: o.recipient,
    paymentCount: BigInt(o.count),
    isImmutable: o.isImmutable ?? false,
    payWithInsufficientBalance: o.payWithInsufficientBalance ?? false,
    trigger: o.trigger ?? ZERO,
    assetAddress: o.asset,
    amount: parseUnits(o.amount, decimals),
    startTimestamp: BigInt(o.startTimestamp),
    paymentInterval: BigInt(o.intervalSeconds),
  };
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'updateScheduledPayments',
    args: [[BigInt(o.id)], [payment]],
    stableCoin: o.stableCoin,
  });
  return hash;
}

// ---- Whitelist / address book ----

export type WhitelistedRecipient = {id: string; recipientAddress: string; allowedAsset: string};

/** Add a recipient to the address book. `allowedAsset` = zero address means any asset is allowed. */
export async function addWhitelisted(o: {
  account: Signer;
  vault: Address;
  network: Network;
  recipient: Address;
  allowedAsset?: Address;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_PAYMENTS_ABI,
    functionName: 'addWhitelistedRecipient',
    args: [o.recipient, o.allowedAsset ?? ZERO],
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

// ---- Operator-proposed send governance ----

export async function approveSend(o: {
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
    functionName: 'approveSend',
    args: [BigInt(o.id)],
    stableCoin: o.stableCoin,
  });
  return hash;
}

export async function cancelSend(o: {
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
    functionName: 'cancelSend',
    args: [BigInt(o.id)],
    stableCoin: o.stableCoin,
  });
  return hash;
}

export type PaymentAction = {kind: string; action: string; itemId: string; blockTimestamp: string; txHash: string};

/** Pending payment-governance actions (operator proposals awaiting owner approval). */
export async function fetchPaymentActions(vault: Address, network: Network): Promise<PaymentAction[]> {
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/payment-actions/${vault}`, network));
    if (!res.ok) return [];
    const j = (await res.json()) as {data?: PaymentAction[]};
    return j.data ?? [];
  } catch {
    return [];
  }
}

export type ScheduledPayment = {
  id: string;
  scheduledPaymentAddress: string;
  assetAddress: string;
  amount: string;
  paymentCount: number;
  startTimestamp: string;
  paymentInterval: string;
  approved: boolean;
  lastPaidTimestamp: string;
  triggerAddress?: string;
  isImmutable?: boolean;
  payWithInsufficientBalance?: boolean;
};

/** The vault's active scheduled payments (server-indexed). */
export async function fetchScheduledPayments(
  vault: Address,
  network: Network,
): Promise<ScheduledPayment[]> {
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/scheduled-payments/${vault}`, network));
    if (!res.ok) return [];
    const j = (await res.json()) as {data?: ScheduledPayment[]};
    return j.data ?? [];
  } catch {
    return [];
  }
}

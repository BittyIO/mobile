import {encodeFunctionData, parseAbi, type Address, type Hex, type LocalAccount} from 'viem';
import {apiUrl, CHAIN_ID, publicClientFor, type Network} from '@/core/chain';

/**
 * The Tron smart wallet's writes (core/tron-account): batches its owner key signs (EIP-712, "Bitty
 * Account" v1) and Bitty's relayer sends (web /api/accounts/relay), paid inside the batch by one
 * USDT `sendUsdt(relayer, fee)`. The key needs no TRX.
 *
 * Activation is its own first step ({activateAccount}): the account's only batch until it exists is
 * that fee, and the factory creates the account as it runs it. Everything else waits for it.
 */

export const ACCOUNT_ABI = parseAbi([
  'function sendUsdt(address to, uint256 amount)',
  'function sendTrx(address to, uint256 amount)',
  'function nonce() view returns (uint256)',
  'function owner() view returns (address)',
]);

export type AccountCall = {to: Address; value: bigint; data: Hex};

/** What the server quotes for a batch: the fee to add, and what the signature needs. */
export type AccountQuote = {account: Address; exists: boolean; nonce: bigint; relayer: Address; fee: bigint; chainId: number};

/** A relay refused for a reason the app can name: the server's code, kept for the message. */
export class AccountRelayError extends Error {
  constructor(
    readonly reason: string,
    readonly code?: string | null,
  ) {
    super(code ? `${reason}: ${code}` : reason);
  }
}

const toJson = (calls: AccountCall[]) => calls.map((c) => ({to: c.to, value: c.value.toString(), data: c.data}));

async function post<T>(path: string, network: Network, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path, network), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const json = (await res.json().catch(() => null)) as (T & {ok?: boolean; reason?: string; code?: string | null; error?: string}) | null;
  if (!json) throw new AccountRelayError(`http-${res.status}`);
  if (json.ok === false || json.error) throw new AccountRelayError(json.reason ?? json.error ?? 'failed', json.code);
  return json;
}

/** The fee for `calls` (without it), from the relayer's own estimate. */
export async function quoteAccount(o: {network: Network; owner: Address; calls: AccountCall[]}): Promise<AccountQuote> {
  const r = await post<{account: Address; exists: boolean; nonce: string; relayer: Address; fee: string; chainId: number}>('/api/ethereum/accounts/quote', o.network, {
    owner: o.owner,
    index: '0',
    calls: toJson(o.calls),
  });
  return {account: r.account, exists: r.exists, nonce: BigInt(r.nonce), relayer: r.relayer, fee: BigInt(r.fee), chainId: r.chainId};
}

/** The relayer's fee, as the batch pays it: a USDT send from the account to the relayer. */
export const feeCall = (q: AccountQuote): AccountCall => ({
  to: q.account,
  value: BigInt(0),
  data: encodeFunctionData({abi: ACCOUNT_ABI, functionName: 'sendUsdt', args: [q.relayer, q.fee]}),
});

/** Signatures last ten minutes: long enough for the relayer, short enough not to linger. */
const DEADLINE_SECONDS = 600;

/**
 * Sign `calls` (the fee already in them) for the quoted account and have the relayer send them.
 * Returns the transaction's hash.
 */
export async function relayAccount(o: {network: Network; signer: LocalAccount; quote: AccountQuote; calls: AccountCall[]}): Promise<{hash: Hex}> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
  const signature = await o.signer.signTypedData({
    domain: {name: 'Bitty Account', version: '1', chainId: CHAIN_ID[o.network], verifyingContract: o.quote.account},
    types: {
      Call: [
        {name: 'to', type: 'address'},
        {name: 'value', type: 'uint256'},
        {name: 'data', type: 'bytes'},
      ],
      Execute: [
        {name: 'calls', type: 'Call[]'},
        {name: 'nonce', type: 'uint256'},
        {name: 'deadline', type: 'uint256'},
      ],
    },
    primaryType: 'Execute',
    message: {calls: o.calls, nonce: o.quote.nonce, deadline},
  });
  const r = await post<{hash: Hex}>('/api/ethereum/accounts/relay', o.network, {
    owner: o.signer.address,
    index: '0',
    calls: toJson(o.calls),
    deadline: deadline.toString(),
    signature,
  });
  return {hash: r.hash};
}

/** Whether the account exists yet (has code): activated. */
export async function isAccountActive(network: Network, account: Address): Promise<boolean> {
  const code = await publicClientFor(network).getBytecode({address: account});
  return !!code && code !== '0x';
}

/** The activation's fee, quoted: the fee is the whole batch. */
export const quoteActivation = (o: {network: Network; owner: Address}) => quoteAccount({...o, calls: []});

/** Activate: the relayer creates the account, paid by its fee out of the USDT already there. */
export async function activateAccount(o: {network: Network; signer: LocalAccount; quote: AccountQuote}): Promise<{hash: Hex}> {
  return relayAccount({network: o.network, signer: o.signer, quote: o.quote, calls: [feeCall(o.quote)]});
}

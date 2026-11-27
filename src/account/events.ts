import {decodeEventLog, getAddress, type Abi, type Address, type Hex} from 'viem';
import ACCOUNT_ABI_JSON from './BittyAccount.abi.json';
import type {Network} from '@/core/chain';
import {TRON_API, type TronChain} from '@/tron/config';
import {evmToTron} from '@/tron/address';

/**
 * The smart wallet's (BittyAccount's) events, from its own logs.
 *
 * Each account is an ERC-1167 clone, and Tron publishes no ABI for the clone or its implementation, so
 * TronGrid's `/v1/contracts/{addr}/events` lists them with no name and an empty `result`. It still names
 * the transactions, and each one's receipt (`gettransactioninfobyid`) carries the raw logs: those are
 * decoded here against the account's own ABI, so the readers above it stay as they are.
 *
 * `BittyAccount.abi.json` is the vault repo's compiled ABI (contracts/vault, `FOUNDRY_PROFILE=tron forge
 * build`, out-tron/BittyAccount.sol/BittyAccount.json at d0f55bc), copied as is.
 */
export const ACCOUNT_ABI = ACCOUNT_ABI_JSON as Abi;
export const ACCOUNT_EVENTS = ACCOUNT_ABI.filter((e) => e.type === 'event');

/** One event, as TronGrid gives a decoded one: its name, its arguments as strings (addresses 0x). */
export type AccountEvent = {event_name: string; result: Record<string, string>; block_timestamp: number; transaction_id: string; index: number};

type Log = {address: string; topics?: string[]; data?: string};

const strOf = (v: unknown): string => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? (v.startsWith('0x') && v.length === 42 ? getAddress(v) : v) : String(v));

/** Every event of `account`, oldest first (up to a thousand transactions). */
export async function accountEvents(network: Network, account: Address): Promise<AccountEvent[]> {
  const host = TRON_API[network as TronChain];
  // The transactions that logged anything on the account, with when.
  const txs = new Map<string, number>();
  let url: string | null = `${host}/v1/contracts/${evmToTron(account)}/events?limit=200&only_confirmed=false&order_by=block_timestamp,asc`;
  for (let page = 0; url && page < 5; page++) {
    const res: {data?: {transaction_id: string; block_timestamp: number}[]; meta?: {links?: {next?: string}}} = await fetch(url).then((r) => r.json());
    for (const e of res.data ?? []) if (!txs.has(e.transaction_id)) txs.set(e.transaction_id, e.block_timestamp);
    url = res.meta?.links?.next ?? null;
  }
  const me = account.toLowerCase().slice(2);
  const ids = [...txs.keys()];
  const out: AccountEvent[] = [];
  // A few receipts at a time: TronGrid's free tier limits the rate.
  for (let i = 0; i < ids.length; i += 8) {
    const infos = await Promise.all(
      ids.slice(i, i + 8).map((id) =>
        fetch(`${host}/wallet/gettransactioninfobyid`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({value: id})})
          .then((r) => r.json() as Promise<{log?: Log[]}>)
          .catch(() => ({}) as {log?: Log[]}),
      ),
    );
    infos.forEach((info, k) => {
      const id = ids[i + k];
      (info.log ?? []).forEach((l, index) => {
        // Tron logs name the contract by its 20 bytes, without the 41 prefix.
        if (l.address.toLowerCase().slice(-40) !== me || !l.topics?.length) return;
        try {
          const d = decodeEventLog({abi: ACCOUNT_EVENTS, topics: l.topics.map((t) => `0x${t}` as Hex) as [Hex, ...Hex[]], data: `0x${l.data ?? ''}` as Hex});
          const result: Record<string, string> = {};
          Object.entries((d.args ?? {}) as Record<string, unknown>).forEach(([key, v], n) => {
            result[key] = strOf(v);
            result[String(n)] = strOf(v);
          });
          out.push({event_name: d.eventName, result, block_timestamp: txs.get(id) ?? 0, transaction_id: id, index});
        } catch {
          /* not one of the account's events */
        }
      });
    });
  }
  return out.sort((a, b) => a.block_timestamp - b.block_timestamp || a.index - b.index);
}

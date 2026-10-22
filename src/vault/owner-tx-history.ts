/**
 * What the owner wallet spent on network fees, for the history page.
 *
 * A relayed operation carries its fee in the history already: the relayer bills the vault in a fee
 * coin, which is a token transfer out of the vault, and the history is built from token transfers.
 * When the OWNER pays (see ./direct) nothing like that happens — the gas comes out of the owner
 * wallet's ETH, which is not the vault and moves no token — so the fee has to be read from the
 * transaction's receipt instead. Receipts never change, so each is read once and kept.
 *
 * The same gap hides some operations entirely. A settings change sent by the owner moves no token,
 * so the server's history never lists it; relayed, it was only ever listed because of its fee leg.
 * So every transaction this phone sends from the owner key is noted here when it is sent, with the
 * words its toast used, and the history draws the ones the server does not have. A note is this
 * device's: a change made from another phone shows its fee on any row the server lists, but a row
 * the server does not list exists only where it was sent.
 */
import {useEffect, useState} from 'react';
import {MMKV} from 'react-native-mmkv';
import type {Address, Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';

const notes = new MMKV({id: 'bitty.owner-txs'});
const receipts = new MMKV({id: 'bitty.tx-gas'});

/** How many of a vault's owner transactions are remembered. Older ones are in the explorer. */
const KEEP = 100;

export type OwnerTxNote = {hash: Hex; at: number; title?: string};

const noteKey = (network: string, vault: string) => `${network}:${vault.toLowerCase()}`;

function readNotes(key: string): OwnerTxNote[] {
  try {
    const raw = notes.getString(key);
    return raw ? (JSON.parse(raw) as OwnerTxNote[]) : [];
  } catch {
    return [];
  }
}

/** Note a transaction the owner key just sent for `vault`. */
export function recordOwnerTx(network: string, vault: string, hash: Hex): void {
  const key = noteKey(network, vault);
  const list = readNotes(key).filter((n) => n.hash !== hash);
  notes.set(key, JSON.stringify([{hash, at: Date.now()}, ...list].slice(0, KEEP)));
}

/**
 * Give a noted transaction the words its toast used. Called for every broadcast the toast follows,
 * and a no-op for the ones that were relayed: only owner transactions were noted.
 */
export function titleOwnerTx(hash: string, title: string): void {
  for (const key of notes.getAllKeys()) {
    const list = readNotes(key);
    const i = list.findIndex((n) => n.hash.toLowerCase() === hash.toLowerCase());
    if (i < 0) continue;
    list[i] = {...list[i], title};
    notes.set(key, JSON.stringify(list));
    return;
  }
}

export function ownerTxNotes(network: string, vault: string): OwnerTxNote[] {
  return readNotes(noteKey(network, vault));
}

/** Who sent a transaction, what it cost them, and whether it succeeded — from its receipt. */
export type TxGas = {from: Address; fee: bigint; ok: boolean};

type StoredGas = {from: Address; fee: string; ok: boolean};

/**
 * Null until the transaction is mined, or when the RPC will not say; asked again next time. Base's
 * receipts carry the L1 data fee the sender paid on top of gas (`l1Fee`), and it is counted.
 */
export async function txGas(network: Network, hash: string): Promise<TxGas | null> {
  const key = `${network}:${hash.toLowerCase()}`;
  const hit = receipts.getString(key);
  if (hit) {
    try {
      const s = JSON.parse(hit) as StoredGas;
      return {from: s.from, fee: BigInt(s.fee), ok: s.ok};
    } catch {
      /* re-read below */
    }
  }
  try {
    const client = publicClientFor(network);
    const r = await client.getTransactionReceipt({hash: hash as Hex});
    const l1Fee = (r as {l1Fee?: bigint | null}).l1Fee ?? BigInt(0);
    const g: TxGas = {from: r.from, fee: r.gasUsed * r.effectiveGasPrice + l1Fee, ok: r.status === 'success'};
    receipts.set(key, JSON.stringify({from: g.from, fee: g.fee.toString(), ok: g.ok} satisfies StoredGas));
    return g;
  } catch {
    return null;
  }
}

/** At a time, so a long history does not fire a hundred receipt reads at the RPC at once. */
const CONCURRENCY = 4;
/** How soon a receipt that could not be read — not mined yet, or the RPC said no — is asked again. */
const RETRY_MS = 10_000;

/**
 * The receipt of each of `hashes` that the OWNER sent, by lowercase hash. A transaction someone else
 * sent — the relayer, a depositor — is left out: whatever it cost, the owner did not pay it.
 *
 * Results arrive one by one, and a receipt that cannot be read yet is asked for again every
 * {RETRY_MS} until it can. It used to be read once per list: a transaction still pending when the
 * page opened, or one a rate-limited public RPC refused, then stayed unknown for as long as the page
 * did — and so did the row the history draws from it. `refreshKey` (the feed, on a pull) starts a
 * fresh pass; a receipt already read comes back from the cache at once.
 */
export function useOwnerGas(network: Network, owner: string | null, hashes: string[], refreshKey?: unknown): Map<string, TxGas> {
  const [out, setOut] = useState<Map<string, TxGas>>(() => new Map());
  const [tick, setTick] = useState(0);
  const wanted = hashes.map((h) => h.toLowerCase()).join(',');
  useEffect(() => {
    if (!owner || !wanted) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queue = wanted.split(',');
    let unread = 0;
    const worker = async () => {
      for (let h = queue.shift(); h && live; h = queue.shift()) {
        const g = await txGas(network, h);
        if (!live) return;
        if (!g) unread++;
        else if (g.from.toLowerCase() === owner.toLowerCase()) {
          const hash = h;
          setOut((prev) => (prev.has(hash) ? prev : new Map(prev).set(hash, g)));
        }
      }
    };
    Promise.all(Array.from({length: CONCURRENCY}, worker)).then(() => {
      if (live && unread > 0) timer = setTimeout(() => setTick((n) => n + 1), RETRY_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [network, owner, wanted, tick, refreshKey]);
  return out;
}

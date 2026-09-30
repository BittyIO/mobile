/**
 * Transactions this device has submitted and the chain has not confirmed yet.
 *
 * The history feed comes from the indexer, which only knows MINED transactions, so a just-submitted
 * one has nowhere to appear. This store is that missing piece: every relayed write records itself
 * here, a poller watches each for a receipt, and the header's badge counts what is still in flight.
 *
 * It is persisted, because a relayed transaction outlives the screen that sent it — and the app —
 * and it keeps a mined entry for a short while so a row never vanishes from Confirming before the
 * indexer has it in the ordinary history.
 */
import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import {publicClientFor, type Network} from '@/core/chain';

/**
 * `dropped` is a transaction the chain will never include: the relayer's nonce was consumed by a
 * different transaction, so this hash can sit in a mempool for ever and never appear in a block.
 * It is NOT `failed` — nothing executed — and it must not be left `pending`, which is what kept the
 * badge counting and the row spinning against a hash Etherscan cannot find.
 */
export type PendingStatus = 'pending' | 'confirmed' | 'failed' | 'dropped';

export type PendingTx = {
  hash: string;
  network: Network;
  /** What the user did, in their words: "Deposit 100 USDC". */
  title: string;
  submittedAt: number;
  status: PendingStatus;
  /** When it stopped being pending; the row lingers briefly after that. */
  settledAt?: number;
  /** The user has opened the Confirming tab since this was submitted. */
  seen?: boolean;
  error?: string;
};

/** How long a row the user has already seen stays on the Confirming tab, covering the indexer's lag. */
const LINGER_MS = 90_000;
/** Gap between receipt checks while a transaction is in flight. */
const POLL_MS = 12_000;
/** After this long with no receipt and no verdict, the transaction is called dropped, not pending. */
const GIVE_UP_MS = 30 * 60_000;
/** Most rows kept, so a badge left untouched for a long time cannot grow without bound. */
const MAX_ROWS = 50;

const store = new MMKV({id: 'bitty.pending'});
const KEY = 'txs';

const load = (): PendingTx[] => {
  try {
    return JSON.parse(store.getString(KEY) ?? '[]') as PendingTx[];
  } catch {
    return [];
  }
};
const save = (txs: PendingTx[]) => store.set(KEY, JSON.stringify(txs));

type State = {
  txs: PendingTx[];
  add: (tx: Omit<PendingTx, 'submittedAt' | 'status'>) => void;
  settle: (hash: string, status: 'confirmed' | 'failed' | 'dropped', error?: string) => void;
  /** Drop one row from the list for good. The user's way out of a transaction that never landed. */
  remove: (hash: string) => void;
  /** Drop every row that is no longer in flight, on this network. */
  clearSettled: (network: Network) => void;
  /** Called when the Confirming tab is opened: the badge clears, the rows start ageing out. */
  acknowledge: () => void;
  prune: () => void;
};

export const usePending = create<State>((set, get) => ({
  txs: load(),
  add: (tx) => {
    const next = [{...tx, submittedAt: Date.now(), status: 'pending' as const}, ...get().txs.filter((t) => t.hash !== tx.hash)];
    save(next);
    set({txs: next});
    void watch(tx.hash as `0x${string}`, tx.network);
  },
  settle: (hash, status, error) => {
    const next = get().txs.map((t) => (t.hash === hash ? {...t, status, error, settledAt: Date.now()} : t));
    save(next);
    set({txs: next});
  },
  remove: (hash) => {
    const next = get().txs.filter((t) => t.hash !== hash);
    save(next);
    set({txs: next});
  },
  clearSettled: (network) => {
    const next = get().txs.filter((t) => t.network !== network || t.status === 'pending');
    save(next);
    set({txs: next});
  },
  acknowledge: () => {
    // Only what has actually settled is dismissed. A transaction still in flight keeps counting,
    // whether or not the user has looked at the tab: the badge is the app's one answer to "is
    // anything still going on", and it has to stay true while something is.
    const next = get().txs.map((t) => (t.status === 'pending' ? t : {...t, seen: true}));
    save(next);
    set({txs: next});
  },
  prune: () => {
    const now = Date.now();
    // A row the user has not looked at stays, however it ended: the badge is a notice, and it is
    // theirs to dismiss by opening the tab. Only seen rows age out.
    const next = get().txs
      .filter((t) => !t.seen || t.status === 'pending' || now - (t.settledAt ?? t.submittedAt) < LINGER_MS)
      .slice(0, MAX_ROWS);
    if (next.length !== get().txs.length) {
      save(next);
      set({txs: next});
    }
  },
}));

/**
 * Follow one transaction to a verdict.
 *
 * Three things can end it, and only asking for the receipt catches one of them:
 *  - it is mined — success or revert;
 *  - it is still in flight — keep waiting;
 *  - its NONCE was used by another transaction, so it can never be mined. The node keeps answering
 *    "known, pending" for the hash and no receipt ever arrives. That is what left a supply spinning
 *    in Confirming against a hash Etherscan had no record of, so it is checked explicitly here.
 */
async function watch(hash: `0x${string}`, network: Network) {
  const client = publicClientFor(network);
  // The sender and nonce of the transaction itself, which is what makes the third case detectable.
  let sender: `0x${string}` | null = null;
  let nonce: number | null = null;
  try {
    const tx = await client.getTransaction({hash});
    sender = tx.from;
    nonce = tx.nonce;
  } catch {
    // Not in the pool yet, or an RPC hiccup. The receipt poll below still works without it.
  }

  const until = Date.now() + GIVE_UP_MS;
  const stillWatched = () => usePending.getState().txs.some((t) => t.hash === hash && t.status === 'pending');

  while (Date.now() < until) {
    if (!stillWatched()) return; // settled elsewhere, or cleared by the user

    try {
      const receipt = await client.getTransactionReceipt({hash});
      if (receipt) {
        usePending.getState().settle(hash, receipt.status === 'success' ? 'confirmed' : 'failed');
        return;
      }
    } catch {
      // viem throws when there is no receipt yet; that is the ordinary case here.
    }

    if (sender == null) {
      // Not visible on the first ask — a relayed transaction can take a moment to reach the RPC
      // this device talks to. Keep asking, because without it the nonce check below cannot run.
      try {
        const tx = await client.getTransaction({hash});
        sender = tx.from;
        nonce = tx.nonce;
      } catch {
        /* still not there */
      }
    }

    if (sender && nonce != null) {
      try {
        // The mined nonce, not the pending one: pending counts this very transaction.
        const used = await client.getTransactionCount({address: sender, blockTag: 'latest'});
        if (used > nonce) {
          // The nonce is spent. Ask once more for the receipt in case this transaction is what
          // spent it and the receipt was simply a moment behind.
          try {
            const late = await client.getTransactionReceipt({hash});
            if (late) {
              usePending.getState().settle(hash, late.status === 'success' ? 'confirmed' : 'failed');
              return;
            }
          } catch {
            /* no receipt: another transaction took the nonce */
          }
          usePending.getState().settle(hash, 'dropped');
          return;
        }
      } catch {
        // Nonce read failed — try again on the next pass.
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Half an hour with no block and no answer. Calling it dropped is the honest report, and it is
  // one the user can clear; leaving it pending is what nothing could ever resolve.
  if (stillWatched()) usePending.getState().settle(hash, 'dropped');
}

/** Resume watching anything left pending from a previous run. Called once at startup. */
export function resumePending() {
  usePending.getState().prune();
  for (const t of usePending.getState().txs) if (t.status === 'pending') void watch(t.hash as `0x${string}`, t.network);
}

/** Record a submitted transaction. */
export function trackTx(hash: string, network: Network, title: string) {
  usePending.getState().add({hash, network, title});
}

/**
 * The badge's number: everything on this network still in flight, plus anything that has settled
 * since the user last opened the Confirming tab. A settled one is dismissed by looking at it; one
 * that is still confirming stays counted until the chain says otherwise.
 */
export function pendingCount(txs: PendingTx[], network: Network): number {
  return txs.filter((t) => t.network === network && (t.status === 'pending' || !t.seen)).length;
}

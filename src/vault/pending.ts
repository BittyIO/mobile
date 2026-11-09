/**
 * Transactions this device has submitted and the chain has not confirmed yet.
 *
 * The history feed comes from the indexer, which only knows MINED transactions, so a just-submitted
 * one has nowhere to appear. This store is that missing piece: every relayed write records itself
 * here, a poller watches each for a receipt, and the header's badge counts what is still in flight.
 *
 * It is persisted, because a relayed transaction outlives the screen that sent it — and the app.
 *
 * It is also the only record of a FAILED one. The history feed is built from ERC-20 Transfer logs,
 * and a reverted transaction emits none, so a trade that failed can never appear there; the history
 * screen reads the failures from here instead. See {FAILED_LINGER_MS}.
 */
import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import {isTronNetwork, publicClientFor, type Network} from '@/core/chain';
import {activeVaultAddress} from '@/core/active-vault';

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
  error?: string;
  /**
   * WHICH vault this was for, lowercased.
   *
   * One device can hold several vaults, and the lists that read these records are all per-vault —
   * so without this a failure on vault 1 appeared in vault 2's order history and its transaction
   * feed, with its amounts and its asset, as if that vault had tried it. The network alone was
   * never enough to say whose a record was.
   *
   * Absent on a record written before this field, which is shown everywhere rather than hidden
   * from the vault it belongs to.
   */
  vault?: string;
  /**
   * What sort of write this was, for a list that only wants one sort.
   *
   * Separate from {trade} on purpose. The order history needs to know "was this an order" even
   * when it cannot draw one, and requiring the legs is what left a failure sitting in the
   * transaction history with no matching row on the order page.
   *
   * Every write sets it, including the ones that are NOT trades — that is the point. Absent means
   * a record written before this field existed, which is the one case nothing can classify, and
   * the order history chooses to show those rather than lose them. Were `other` left unset, every
   * failed deposit would be an unknown for ever and would turn up there too.
   */
  kind?: 'trade' | 'other';
};

/**
 * How long a CONFIRMED row is kept.
 *
 * Only long enough to be watched: it is what resolves a toast to Confirmed and what tells the
 * balances to re-read. A minute and a half past settlement covers the indexer's lag and a relaunch
 * mid-flight, and once the operation is in the ordinary history nothing needs it here.
 */
const LINGER_MS = 90_000;
/**
 * How long a FAILED or DROPPED row is kept. A week.
 *
 * Far longer than a confirmed one, because a failure is the one outcome the history CANNOT show. The
 * feed behind it is built from ERC-20 Transfer logs, and a reverted transaction moves nothing and
 * emits no logs — so a market trade that failed left no trace at all: the toast said so and then
 * went away, and the history it sent the user to had never heard of it.
 *
 * So this store is where a failure lives, and the history screen reads it. A week is long enough to
 * come back and find out why; the row can also be cleared by hand before then. See {clear}.
 */
const FAILED_LINGER_MS = 7 * 24 * 60 * 60_000;
/** Gap between receipt checks while a transaction is in flight. */
const POLL_MS = 12_000;
/** After this long with no receipt and no verdict, the transaction is called dropped, not pending. */
const GIVE_UP_MS = 30 * 60_000;
/** A ceiling regardless, so a long session cannot grow the list without bound. */
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
  /** Dismiss one row for good — the ✕ on a failed row in the history. */
  clear: (hash: string) => void;
  prune: () => void;
};

export const usePending = create<State>((set, get) => ({
  txs: load(),
  add: (tx) => {
    /**
     * Stamped with the vault in front, here rather than at each of the twenty-odd call sites.
     *
     * Every one of them is a write to the vault the user is looking at — that is what makes it
     * derivable, and what makes asking each caller to pass it both tedious and a thing one of them
     * would eventually get wrong. Read at RECORD time, so switching vaults afterwards cannot
     * change whose a record is.
     */
    const vault = activeVaultAddress(tx.network)?.toLowerCase();
    const next = [
      {...tx, vault: tx.vault ?? vault, submittedAt: Date.now(), status: 'pending' as const},
      ...get().txs.filter((t) => t.hash !== tx.hash),
    ];
    save(next);
    set({txs: next});
    void watch(tx.hash as `0x${string}`, tx.network);
  },
  settle: (hash, status, error) => {
    const next = get().txs.map((t) => (t.hash === hash ? {...t, status, error, settledAt: Date.now()} : t));
    save(next);
    set({txs: next});
  },
  clear: (hash) => {
    const next = get().txs.filter((t) => t.hash !== hash);
    save(next);
    set({txs: next});
  },
  prune: () => {
    const now = Date.now();
    // In flight, or settled recently enough to still matter. A failure matters for far longer than
    // a success: the success turns up in the ordinary history and the failure never does.
    const next = get().txs
      .filter((t) => {
        if (t.status === 'pending') return true;
        const age = now - (t.settledAt ?? t.submittedAt);
        return age < (t.status === 'confirmed' ? LINGER_MS : FAILED_LINGER_MS);
      })
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
/** A Tron transaction expires a minute after its reference block; with time to land and be read. */
const TRON_EXPIRY_MS = 3 * 60_000;

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
  // Tron has no nonces: a transaction that is not in a block by its expiration — a minute past the
  // block it was anchored to (tron/tx `encodeRaw`) — can never be, so that is the third case there.
  const tronDropAt = isTronNetwork(network) ? Date.now() + TRON_EXPIRY_MS : null;

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

    if (tronDropAt != null) {
      if (Date.now() > tronDropAt) {
        usePending.getState().settle(hash, 'dropped');
        return;
      }
    } else if (sender && nonce != null) {
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
  for (const t of usePending.getState().txs)
    if (t.status === 'pending') void watch(t.hash as `0x${string}`, t.network);
}


/** Record a submitted transaction, so the toast can follow it to a verdict. */
export function trackTx(hash: string, network: Network, title: string) {
  usePending.getState().add({hash, network, title});
}




/**
 * Operations the relayer was asked to perform for this vault, including the ones that never happened.
 *
 * The companion to the transfer feed. That feed is built from ERC-20 `Transfer` logs and answers
 * "what moved"; this answers "what was attempted" — the half no log can carry, because a reverted
 * transaction emits none and an operation the relayer REFUSED has no transaction at all.
 *
 * It replaces a local record this app used to keep. Local was the wrong place for two reasons that
 * only became obvious once there were two: a vault can be operated from the web, and a failure
 * there was invisible here; and a record written by an older build could not be repaired, because
 * there was nothing to re-derive it from. The relayer is the server, so the server always knew —
 * it simply was not writing it down. Now it does, and both clients read the same list.
 *
 * {usePending} stays, for the job it was built for: following the write the user is standing over,
 * so the toast can resolve. It is not a history any more.
 */
import {useCallback, useEffect, useState} from 'react';
import {formatUnits, type Address} from 'viem';
import {apiFetch, apiUrl, type Network} from '@/core/chain';
import {assetMeta, underlyingOf} from '@/core/assets';
import {currentCatalog} from '@/core/asset-catalog';
import type {VaultAction} from '@/vault/tx-actions';

/**
 * Where an attempt has got to, as the server reports it.
 *
 * `refused` is the one with no transaction behind it: the relayer simulates before it signs and
 * turns down what would revert, so nothing was broadcast and there is no hash to open.
 *
 * Which is why the feed no longer carries them: the service serves only attempts that reached a
 * chain (see {listAttempts}). A refusal moved nothing, cost nothing and left nothing to open, and
 * a row with no amounts and no name could only be drawn as a network fee — for a transaction that
 * never existed. The status stays in the type because the record still has it, and because a
 * `submitted` row can still settle to anything.
 */
export type AttemptStatus = 'submitted' | 'confirmed' | 'failed' | 'refused';

export type Attempt = {
  id: number;
  txHash: string | null;
  status: AttemptStatus;
  /** The relayer's refusal and the contract's own objection, where there is one. */
  reason: string | null;
  /** What the operation WAS — the vault calls, forwarder and multicall already unwrapped. */
  actions: VaultAction[];
  /** Unix seconds. */
  at: number;
};

/** Did this ever reach a chain? False for a refusal, which has nothing to link to. */
export const wasSent = (a: Attempt) => !!a.txHash;

/** Is this one of the ones the ordinary history cannot show? */
export const isFailure = (a: Attempt) => a.status === 'failed' || a.status === 'refused';

export async function fetchAttempts(vault: string, network: Network): Promise<Attempt[]> {
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/relay-attempts/${vault}`, network));
    if (!res.ok) return [];
    const json = (await res.json()) as {attempts?: Attempt[]};
    return json.attempts ?? [];
  } catch {
    // Offline, or the service is down. An empty list leaves whatever is drawn alone rather than
    // replacing it with an error — this is a side record, not the page.
    return [];
  }
}

/** The two legs of a market swap in an attempt, for an order row. Null when it was not one. */
export type AttemptTrade = {
  buy: boolean;
  sold: {symbol: string; amount: number};
  bought: {symbol: string; amount: number};
};

/**
 * The swap inside an attempt, as the two legs an order row needs.
 *
 * `marketSell` and `marketBuy` put their arguments in the same places — only the MEANING of the two
 * amounts differs (exact-in with a minimum out, against a maximum in with an exact out). An attempt
 * that never filled wants the figures as asked either way, so one read serves both.
 *
 * Which way round is decided as every other row decides it: the leg that is a stablecoin is what
 * was spent on a buy.
 */
export function attemptTrade(a: Attempt, network: Network): AttemptTrade | null {
  const swap = a.actions.find((x) => x.name === 'marketSell' || x.name === 'marketBuy');
  if (!swap) return null;
  const arg = (k: string) => {
    const v = swap.args[k];
    return typeof v === 'string' ? v : undefined;
  };
  const sellToken = arg('sellToken');
  const buyToken = arg('buyToken');
  const sellRaw = arg('sellAmount') ?? arg('sellAmountMax');
  const buyRaw = arg('buyAmountMin') ?? arg('buyAmount');
  if (!sellToken || !buyToken || sellRaw == null || buyRaw == null) return null;

  const sellM = assetMeta(network, sellToken as Address);
  const buyM = assetMeta(network, buyToken as Address);
  const stable = (addr: string) => {
    const sym = underlyingOf(network, addr) ?? assetMeta(network, addr as Address).symbol;
    return currentCatalog(network).some((x) => x.kind === 'stable' && x.symbol === sym);
  };
  try {
    return {
      buy: stable(sellToken) && !stable(buyToken),
      sold: {symbol: sellM.symbol, amount: Number(formatUnits(BigInt(sellRaw), sellM.decimals))},
      bought: {symbol: buyM.symbol, amount: Number(formatUnits(BigInt(buyRaw), buyM.decimals))},
    };
  } catch {
    return null;
  }
}

/**
 * This vault's attempts. `refresh()` re-reads; `nonce` re-reads when something else already did.
 *
 * Empty while it loads and empty on failure, which are the same thing as far as the lists are
 * concerned: these rows are added to a page, never the page itself.
 */
export function useVaultAttempts(
  vault: string | null,
  network: Network,
  nonce = 0,
): {attempts: Attempt[]; refresh: () => void} {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [own, setOwn] = useState(0);
  const refresh = useCallback(() => setOwn((n) => n + 1), []);

  useEffect(() => {
    if (!vault) {
      setAttempts([]);
      return;
    }
    let live = true;
    fetchAttempts(vault, network).then((rows) => live && setAttempts(rows));
    return () => {
      live = false;
    };
  }, [vault, network, nonce, own]);

  return {attempts, refresh};
}

/**
 * Tell the server about an attempt it never saw.
 *
 * The relayer records everything it is asked to do and everything it refuses, which covers every
 * failure that reaches it. A client can fail earlier: no route for the pair, a quote that will not
 * come back, an adapter the vault has not got. Nothing is built, so there is no request for the
 * service to have witnessed — and this device is then the only thing that knows the owner tried.
 *
 * Reported rather than kept locally, so there is still ONE list. The row is stored as refused with
 * its reason prefixed `client:`, because the server did not witness it and should not pretend to.
 *
 * Best effort by design: it is a note about something that already failed, and failing to file the
 * note must not become a second error in front of the user.
 */
export async function reportFailedAttempt(opts: {
  vault: string;
  network: Network;
  signer: string;
  reason: string;
  sellToken: string;
  sellAmount: string;
  buyToken: string;
  buyAmount: string;
}): Promise<void> {
  try {
    await apiFetch(apiUrl(`/api/ethereum/vaults/relay-attempts/${opts.vault}`, opts.network), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        signer: opts.signer,
        reason: opts.reason,
        sellToken: opts.sellToken,
        sellAmount: opts.sellAmount,
        buyToken: opts.buyToken,
        buyAmount: opts.buyAmount,
      }),
    });
  } catch {
    // Offline, or the service is down. Nothing to do and nothing to say: the toast has already
    // told the user what went wrong.
  }
}

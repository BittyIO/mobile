import {useEffect, useState} from 'react';
import {parseAbi, type Address} from 'viem';
import {publicClientFor, GUARD_ADDRESS, type Network} from '@/core/chain';
import type {ProtocolCategory} from '@/core/protocols';

/**
 * The protocol adapters the guard is actually running, read from the chain.
 *
 * This is the reason a vault can move to a new release without the app moving with it. The guard
 * holds the live set and reports each entry's category itself, so when the market-trade and
 * market-maker adapters were split for 1.0.3 the routing changed on chain and nothing here had to
 * be rebuilt. A table of addresses in the binary would have meant a release per chain per
 * deployment — and would have been wrong the day after it shipped: measured on 2026-10-05 the
 * guard already served a market-maker adapter and a newer trade adapter on mainnet and Base that
 * the vendored table in {protocols} had never heard of.
 *
 * `getProtocols()` returns the ACTIVE set — deprecated entries are already excluded — in
 * registration order, which puts the most recently registered adapter LAST. Order matters to
 * every caller, because `[0]` is the one a trade is routed through, so the list is REVERSED and
 * handed back newest first.
 *
 * Registration order, not `protocolVersion()`. The version is per lineage and a replacement
 * starts a new one at 1.0.0, so sorting by it picks the old adapter: on mainnet the split's
 * trade adapter reports 1.0.0 while the combined one it replaced reports 1.0.1. Reversed
 * registration order agrees with the canonical choice in the web's own config on all four
 * chains, which is the check that settled it.
 */

const GUARD_ABI = parseAbi([
  'function getProtocols() view returns (address[])',
  'function protocolCategory(address) view returns (uint8)',
]);

/**
 * The guard's category numbers.
 *
 * 3 is the market-TRADE adapter: `PROTOCOL_MARKET_TRADE` aliases the old `PROTOCOL_AMM`, so a
 * chain on the combined adapter and a chain on the split one both report 3 for the thing a swap
 * routes through. 5 is the split's maker side, and its absence is how a pre-split chain is
 * recognised — see {marketMakerAdapters}.
 */
const CATEGORY: Record<number, ProtocolCategory> = {
  1: 'lending',
  2: 'staking',
  3: 'amm',
  4: 'intent',
  5: 'marketMaker',
};

export type GuardProtocol = {address: Address; category: ProtocolCategory};

const cache = new Map<Network, GuardProtocol[]>();
const inflight = new Map<Network, Promise<GuardProtocol[] | null>>();

/**
 * Read the catalog for one network. Null when the guard cannot be reached, which leaves whatever
 * the caller already had — the last good read, or the vendored table.
 */
export async function fetchGuardProtocols(network: Network): Promise<GuardProtocol[] | null> {
  const running = inflight.get(network);
  if (running) return running;

  const task = (async () => {
    try {
      const client = publicClientFor(network);
      const list = (await client.readContract({
        address: GUARD_ADDRESS,
        abi: GUARD_ABI,
        functionName: 'getProtocols',
      })) as readonly Address[];
      if (list.length === 0) return null;

      // One category per entry, in parallel. An adapter that does not answer is kept with an
      // unknown category rather than dropped: it is still a registered protocol, and a history
      // row that names it is better than one that shows a bare address.
      const cats = await Promise.all(
        list.map((a) =>
          client
            .readContract({address: GUARD_ADDRESS, abi: GUARD_ABI, functionName: 'protocolCategory', args: [a]})
            .catch(() => 0),
        ),
      );

      // Reversed, so `[0]` of any category is the most recently registered — the canonical target
      // for a fresh clone, a market swap and an upgrade.
      const out: GuardProtocol[] = list
        .map((address, i) => ({address, category: CATEGORY[Number(cats[i])] ?? 'unknown'}))
        .reverse();
      cache.set(network, out);
      return out;
    } catch {
      return null;
    } finally {
      inflight.delete(network);
    }
  })();
  inflight.set(network, task);
  return task;
}

/** The best catalog we have right now, or null when the guard has never answered. */
export const currentGuardProtocols = (network: Network): GuardProtocol[] | null => cache.get(network) ?? null;

/**
 * Keep the catalog warm and re-render when it lands.
 *
 * The accessors in {protocols} are plain functions — a relayed write cannot call a hook — so they
 * read the snapshot above. This is what fills it, and what makes a screen showing a protocol's
 * name redraw once the chain has answered.
 */
export function useGuardProtocols(network: Network): GuardProtocol[] | null {
  const [list, setList] = useState<GuardProtocol[] | null>(() => currentGuardProtocols(network));
  useEffect(() => {
    let live = true;
    setList(currentGuardProtocols(network));
    fetchGuardProtocols(network).then((r) => {
      if (live && r) setList(r);
    });
    return () => {
      live = false;
    };
  }, [network]);
  return list;
}

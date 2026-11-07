import {useEffect, useState} from 'react';
import type {Network} from '@/core/chain';
import {quoteRelayFeeUsd, relayGasFor} from './fee-quote';
import {useActiveFeePayer} from './useFeePayer';

/**
 * Gas for the heaviest operation a form can send: a swap that unwinds two positions, on an asset or
 * adapter used for the first time. The floor covers whatever this operation turns out to be.
 */
const FLOOR_GAS = relayGasFor({swap: 1, withdraw: 2, setup: true});

// Gas goes stale slowly, and every form on the chain asks the same question.
const TTL_MS = 60_000;
const cache = new Map<Network, {usd: number; at: number}>();

/**
 * The least a vault-paid operation must leave in its fee coin, in dollars, whatever the reserve says.
 *
 * The reserve is the owner's float for LATER operations, and "None" turns it off. It cannot turn off
 * the fee for THIS one: the relayer bills it after the call runs, so a Max that spends the last of the
 * fee coin reverts at the charge (`fee-leg-failed`) with nothing wrong with the operation. With the
 * reserve off, this is what is held back instead (see {resolveFeeReserve}'s `floorUsd`).
 *
 * Zero when the owner pays, since nothing is billed to the vault then. Zero, too, until the first
 * quote arrives, which is one gas-price read and then shared for a minute.
 */
export function useFeeFloor(network: Network): number {
  const {payer} = useActiveFeePayer(network);
  const [usd, setUsd] = useState(() => cache.get(network)?.usd ?? 0);
  useEffect(() => {
    if (payer !== 'vault') return;
    const hit = cache.get(network);
    if (hit) setUsd(hit.usd);
    if (hit && Date.now() - hit.at < TTL_MS) return;
    let live = true;
    quoteRelayFeeUsd(network, FLOOR_GAS).then((v) => {
      if (v == null || !(v > 0)) return;
      cache.set(network, {usd: v, at: Date.now()});
      if (live) setUsd(v);
    });
    return () => {
      live = false;
    };
  }, [network, payer]);
  return payer === 'vault' ? usd : 0;
}

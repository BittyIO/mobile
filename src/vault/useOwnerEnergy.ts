import {useEffect, useState} from 'react';
import type {Address} from 'viem';
import {isTronNetwork, type Network} from '@/core/chain';
import {useWallet} from '@/wallet/store';
import type {TronEnergy} from '@/tron/client';
import {fetchOwnerEnergy} from './tron-stake';

/**
 * The owner's Tron energy and today's energy per staked TRX, for TRON Stake's rows in place of an APY.
 * Null off Tron, before the read lands, or when the node will not say. `nonce` re-reads it.
 */
export function useOwnerEnergy(network: Network, nonce: unknown = 0): TronEnergy | null {
  const owner = useWallet((s) => s.address) as Address | null;
  const [energy, setEnergy] = useState<TronEnergy | null>(null);
  useEffect(() => {
    if (!owner || !isTronNetwork(network)) return setEnergy(null);
    let live = true;
    fetchOwnerEnergy(owner, network).then((e) => live && setEnergy(e));
    return () => {
      live = false;
    };
  }, [owner, network, nonce]);
  return energy;
}

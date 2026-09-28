import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {fetchFlows, type Flows} from './flows';

/** Lifetime stake/supply flows for the vault, for the earned overlay. Null until first load. */
export function useFlows(vault: Address | null, network: Network) {
  const [flows, setFlows] = useState<Flows | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!vault) {
      setFlows(null);
      return;
    }
    let live = true;
    fetchFlows(vault, network)
      .then((f) => live && setFlows(f))
      .catch(() => live && setFlows(null));
    return () => {
      live = false;
    };
  }, [vault, network, nonce]);

  return {flows, refresh};
}

import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {readLpPositions, type LpPosition} from './lp';

type State = {
  lp: LpPosition[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** The vault's Uniswap V3 LP positions (on-chain). `refresh()` re-reads on demand. */
export function useVaultLp(vault: Address | null, network: Network): State {
  const [lp, setLp] = useState<LpPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!vault) {
      setLp([]);
      /**
       * The flag too, not just the data.
       *
       * A run superseded mid-flight drops its own clear (`live` is false by the time the request
       * settles), on the assumption that the run replacing it sets the flag itself. This path does
       * not: it starts no request. So a load that was in flight when the vault went away — a
       * switch, a lock, a wallet still deriving its owner — left `loading` true with nothing left
       * that could ever clear it, and the screen spun for ever.
       */
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    readLpPositions(vault, network)
      .then((p) => live && setLp(p))
      .catch((e) => live && setError(String((e as Error)?.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [vault, network, nonce]);

  return {lp, loading, error, refresh};
}

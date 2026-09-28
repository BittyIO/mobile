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

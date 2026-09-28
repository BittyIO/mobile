import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {fetchPositions, fetchSkyPosition, type Position} from './positions';

type State = {
  positions: Position[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * The vault's staking + lending positions (via the backend cache). `refresh()` forces a fresh chain
 * re-read on the server — call it after a stake/withdraw so the numbers reflect the tx. Null vault
 * (owner not derived yet) yields an empty, non-loading state.
 */
export function useVaultPositions(
  vault: Address | null,
  network: Network,
): State {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 0 = use cache; >0 = force fresh (post-tx).
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!vault) {
      setPositions([]);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    // The cached positions, plus a live Sky read when the cache has no (Sky, USDC) row — see
    // fetchSkyPosition. The Sky read never fails the load: a null just leaves the list as served.
    Promise.all([fetchPositions(vault, network, nonce > 0), fetchSkyPosition(vault, network).catch(() => null)])
      .then(([served, sky]) => {
        if (!live) return;
        const hasSky =
          sky != null &&
          served.some(
            (p) => p.protocol.toLowerCase() === sky.protocol.toLowerCase() && p.asset.toLowerCase() === sky.asset.toLowerCase(),
          );
        setPositions(sky && !hasSky ? [...served, sky] : served);
      })
      .catch((e) => live && setError(String((e as Error)?.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [vault, network, nonce]);

  return {positions, loading, error, refresh};
}

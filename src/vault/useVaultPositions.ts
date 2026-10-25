import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {fetchPositions, fetchSkyPosition, type Position} from './positions';
import {usePending} from './pending';

type State = {
  positions: Position[];
  loading: boolean;
  /** The first read for this vault has answered (or failed). Stays true through later refreshes. */
  loaded: boolean;
  error: string | null;
  refresh: () => void;
};

const sameRow = (a: Position, b: Position) =>
  a.protocol.toLowerCase() === b.protocol.toLowerCase() && a.asset.toLowerCase() === b.asset.toLowerCase();

/**
 * The vault's staking + lending positions.
 *
 * Two sources, deliberately independent:
 *  - the backend cache, which the server refreshes from chain on its own schedule;
 *  - a live Sky read (see fetchSkyPosition), merged in when the cache has no Sky row.
 * A failure in either must not blank the other.
 *
 * `refresh()` re-reads. It asks the SERVER to re-read the chain (`?fresh=1`) in the BACKGROUND only,
 * applying that answer if it arrives: on a chain with many registered assets that request can take
 * longer than the server's own time limit, and making the visible read depend on it turned every
 * post-deposit refresh into an empty list — which is what showed a funded Sky position as 0.
 */
export function useVaultPositions(vault: Address | null, network: Network): State {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  // Which vault the last finished read was for, so a switch counts as not loaded yet.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadKey = vault ? `${network}:${vault.toLowerCase()}` : null;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  /**
   * Re-read, fresh, whenever a transaction on this network confirms — from any screen.
   *
   * Each screen holds its own copy and only refreshed on its own pull, so a supply made from Earn
   * never reached the Overview or the Trade sheet: both kept the server's cached answer, which still
   * said 0 WETH supplied, and the sheet offered no Lending source to sell from. A confirmed write
   * is exactly when positions move, and the fresh read also corrects the server's cache.
   */
  const lastConfirmed = usePending((s) =>
    s.txs.reduce((at, t) => (t.network === network && t.status === 'confirmed' ? Math.max(at, t.settledAt ?? 0) : at), 0),
  );
  useEffect(() => {
    if (lastConfirmed) refresh();
  }, [lastConfirmed, refresh]);

  useEffect(() => {
    if (!vault) {
      setPositions([]);
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
    const forKey = `${network}:${vault.toLowerCase()}`;
    let sky: Position | null = null;
    setLoading(true);
    setError(null);

    const merge = (served: Position[]) => (sky && !served.some((p) => sameRow(p, sky!)) ? [...served, sky] : served);

    let apiError: string | null = null;
    Promise.all([
      fetchPositions(vault, network, false).catch((e) => {
        apiError = String((e as Error)?.message ?? e);
        return [] as Position[];
      }),
      fetchSkyPosition(vault, network).catch(() => null),
    ])
      .then(([served, live_sky]) => {
        if (!live) return;
        sky = live_sky;
        const merged = merge(served);
        /**
         * A failed read is not an empty vault.
         *
         * The served list is `[]` when the request errored or timed out, and writing that over the
         * rows already on screen made a refresh that merely failed look like the positions had been
         * withdrawn. Keep the last good answer and say what went wrong instead.
         */
        if (apiError && merged.length === 0) {
          setError(apiError);
          return;
        }
        setPositions(merged);
        setError(null);
      })
      .finally(() => {
        if (!live) return;
        setLoading(false);
        setLoadedFor(forKey);
      });

    // After a write, ask the server for a chain re-read too, and take it if it answers in time.
    if (nonce > 0) {
      fetchPositions(vault, network, true)
        .then((fresh) => live && setPositions(merge(fresh)))
        .catch(() => {});
    }

    return () => {
      live = false;
    };
  }, [vault, network, nonce]);

  return {positions, loading, loaded: loadKey != null && loadedFor === loadKey, error, refresh};
}

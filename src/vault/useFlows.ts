import {useCallback, useEffect, useMemo, useState} from 'react';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {fetchFlows, prunePendingFlows, usePendingFlows, withPendingFlows, type Flows} from './flows';
import {usePending} from './pending';

/** Lifetime stake/supply flows for the vault, for the earned overlay. Null until first load. */
export function useFlows(vault: Address | null, network: Network) {
  // The server's ledger, and when the read that returned it started.
  const [server, setServer] = useState<{flows: Flows; readFrom: number} | null>(null);
  // True while a read is out, the first or a refresh: a pull's spinner waits on it.
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  /**
   * Read again when the ledger or the position can have moved, as the positions do.
   *
   * Earned is the position less this ledger's principal. The positions re-read the moment a write
   * confirms, and this did not, so straight after a deposit the new balance was measured against the
   * principal from before it and the deposit itself showed as earned until a pull. A move the server
   * has just accepted is a cue too: the next read holds it, and its local copy can go.
   */
  const pending = usePendingFlows((s) => s.byTx);
  const accepted = usePendingFlows((s) => s.accepted);
  const lastConfirmed = usePending((s) =>
    s.txs.reduce((at, t) => (t.network === network && t.status === 'confirmed' ? Math.max(at, t.settledAt ?? 0) : at), 0),
  );

  useEffect(() => {
    if (!vault) {
      setServer(null);
      return;
    }
    let live = true;
    const readFrom = Date.now();
    setLoading(true);
    fetchFlows(vault, network)
      .then((f) => {
        if (!live) return;
        setServer({flows: f, readFrom});
        prunePendingFlows(readFrom);
      })
      .catch(() => live && setServer(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [vault, network, nonce, accepted, lastConfirmed]);

  // What this device has sent and the server does not hold yet counts from the moment it was sent.
  const flows = useMemo(
    () => (server && vault ? withPendingFlows(server.flows, vault, network, server.readFrom) : null),
    // `pending` is read inside withPendingFlows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, vault, network, pending],
  );

  return {flows, loading, refresh};
}

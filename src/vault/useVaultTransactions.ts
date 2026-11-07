import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {fetchTransactions, type Operation} from './transactions';

type State = {
  ops: Operation[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** The vault's transaction history (grouped by tx). `refresh()` re-fetches. */
export function useVaultTransactions(vault: Address | null, network: Network): State {
  const [ops, setOps] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!vault) {
      setOps([]);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    fetchTransactions(vault, network)
      .then((o) => live && setOps(o))
      .catch((e) => live && setError(String((e as Error)?.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [vault, network, nonce]);

  return {ops, loading, error, refresh};
}

import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {useWallet} from '@/wallet/store';
import {ownerVaultAddress, readVaultBalances, type VaultBalances} from './read';

type State = {
  vault: Address | null;
  balances: VaultBalances | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * Owner → predicted vault address → on-chain balances. Recomputes when the owner or network changes;
 * `refresh()` re-reads on demand (pull-to-refresh, post-tx). Prediction is local (no RPC), so the vault
 * address is available immediately even before the first read resolves.
 */
export function useVaultBalances(network: Network): State {
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [balances, setBalances] = useState<VaultBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!vault) {
      setBalances(null);
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
    readVaultBalances(vault, network)
      .then((b) => live && setBalances(b))
      .catch((e) => live && setError(String((e as Error)?.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [vault, network, nonce]);

  return {vault, balances, loading, error, refresh};
}

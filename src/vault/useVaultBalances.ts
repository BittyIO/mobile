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

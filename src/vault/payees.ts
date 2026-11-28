import {useEffect, useState} from 'react';
import {useIsFocused} from '@react-navigation/native';
import {create} from 'zustand';
import type {Network} from '@/core/chain';
import {fetchWhitelist} from '@/vault/payments';
import {WHITELIST_STATUS} from '@/core/abi';
import {usePending} from '@/vault/pending';

/**
 * Vaults with a payee on its way in: the add was accepted by the relayer and is not mined yet, so
 * the book does not show it. Kept so the Payees dot goes away as soon as the user has done their part.
 */
export const usePayeeAdding = create<{adding: Record<string, true>; mark: (vault: string) => void}>((set) => ({
  adding: {},
  mark: (vault) => set((s) => ({adding: {...s.adding, [vault.toLowerCase()]: true}})),
}));

/**
 * Whether the vault has any payee, added or still waiting out its timelock. A payee a lock voided
 * does not count: it will never be paid. Null until the chain answers, so nothing is flagged on a guess.
 * Read again on coming back to the page and whenever a relayed write settles.
 */
export function useHasPayees(vault: string | null | undefined, network: Network, nonce = 0): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  const focused = useIsFocused();
  const settled = usePending((s) => s.txs.filter((x) => x.status !== 'pending').length);
  const adding = usePayeeAdding((s) => (vault ? !!s.adding[vault.toLowerCase()] : false));
  useEffect(() => {
    if (!vault || !focused) return;
    let live = true;
    fetchWhitelist(vault as `0x${string}`, network)
      .then((rows) => live && setHas(rows.some((r) => r.status !== WHITELIST_STATUS.voided)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vault, network, focused, settled, nonce]);
  return adding || has;
}

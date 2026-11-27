import {useEffect} from 'react';
import {create} from 'zustand';
import type {Network} from '@/core/chain';
import {getRiskConfig} from '@/vault/risk';
import {usePending} from '@/vault/pending';
import {guardShieldOf, type ShieldKind} from '@/core/new-vault-defaults';
import {useActiveAccount} from '@/core/account-mode';
import {readGuard} from '@/account/guard';
import {accountRiskValues} from '@/account/guard-evm';
import {useAccountWrites} from '@/account/writes';

/** The Guard level read for each vault, shared: the corner's shield and Overview's dot agree. */
const useShieldKinds = create<{levels: Record<string, ShieldKind>; put: (key: string, level: ShieldKind) => void}>((set) => ({
  levels: {},
  put: (key, level) => set((s) => (s.levels[key] === level ? s : {levels: {...s.levels, [key]: level}})),
}));

/**
 * The vault's Guard level from the numbers in force (see {guardLevelOf}): 0 with no timelock — a
 * 1.2.0 vault's start, flagged with a red dot on Overview's Guard — 1 or 2 with one. Null until the
 * chain answers or when it could not be read, so nothing is drawn on a guess. Read again whenever a
 * relayed write settles, and on `nonce` (Overview's pull and return).
 */
export function useGuardLevel(vault: string | null | undefined, network: Network, nonce = 0): ShieldKind | null {
  const key = vault ? `${network}:${vault.toLowerCase()}` : '';
  const level = useShieldKinds((s) => (key ? s.levels[key] : undefined));
  const settled = usePending((s) => s.txs.filter((x) => x.status !== 'pending').length);
  // The Tron smart wallet: its level from its own timelock and limit.
  const smart = useActiveAccount(network).kind === 'account';
  const acctWrites = useAccountWrites((s) => s.n);
  useEffect(() => {
    if (!vault) return;
    let live = true;
    if (smart) {
      readGuard(network, vault as `0x${string}`)
        .then((g) => live && useShieldKinds.getState().put(key, guardShieldOf(accountRiskValues(g))))
        .catch(() => {});
      return () => {
        live = false;
      };
    }
    getRiskConfig(vault as `0x${string}`, network)
      .then((r) => {
        if (live && r.read) useShieldKinds.getState().put(key, guardShieldOf(r));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vault, network, key, settled, nonce, smart, acctWrites]);
  return level ?? null;
}

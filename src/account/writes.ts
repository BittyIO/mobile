import {create} from 'zustand';

/**
 * A count of the smart wallet's relayed changes that have had time to land: what the vault's settled
 * pending transactions are to its readers (see vault/guard `useGuardLevel`), so the corner's shield
 * and Overview's dots read the account again after a change.
 */
export const useAccountWrites = create<{n: number; bump: () => void}>((set) => ({n: 0, bump: () => set((s) => ({n: s.n + 1}))}));

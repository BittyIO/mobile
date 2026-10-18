import {create} from 'zustand';
import type {RiskChanges, RiskField} from '@/vault/risk';

/**
 * Risk values picked but not saved yet. The value pages write here; Risk settings shows them, saves
 * them all in one transaction, and clears them on save or discard. Not persisted: an unsaved edit
 * belongs to this visit to the page, not to the next launch.
 */
export const useRiskDraft = create<{
  changes: RiskChanges;
  set: (field: RiskField, value: bigint | undefined) => void;
  clear: () => void;
}>((set) => ({
  changes: {},
  set: (field, value) =>
    set((s) => {
      const changes = {...s.changes};
      if (value === undefined) delete changes[field];
      else changes[field] = value;
      return {changes};
    }),
  clear: () => set({changes: {}}),
}));

import {create} from 'zustand';
import type {Address} from 'viem';

/** A recipient chosen on the Select recipient page, on its way back to the Send card. */
export type PickedRecipient = {
  /** Which recipient card asked for it. */
  slot: number;
  address: Address;
  /** What to show beside the address — a saved name, or a vault's own. */
  label?: string;
  /** Write the address into the whitelist, in the same transaction as the payment. */
  addToBook: boolean;
};

/**
 * The hand-back from the picker page to the Send card.
 *
 * A route param carried this, and a route param has to be delivered by `navigate`, which resolves
 * a name against the navigator and PUSHES a second copy of the Send page as readily as it returns
 * to the first. `goBack` cannot do that — it only ever unwinds — so the value travels beside the
 * navigation rather than through it.
 *
 * One slot, read once: the Send card applies it and clears it, so coming back to the screen later
 * does not re-apply a stale choice over whatever is there now.
 */
type State = {
  picked: PickedRecipient | null;
  set: (p: PickedRecipient) => void;
  clear: () => void;
};

export const useRecipientPick = create<State>((set) => ({
  picked: null,
  set: (picked) => set({picked}),
  clear: () => set({picked: null}),
}));

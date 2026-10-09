import {create} from 'zustand';

/** Which leg of the pair the picker was opened for. */
export type AssetSlot = 'base' | 'quote';

/**
 * The asset a pushed picker chose, on its way back to the screen that asked.
 *
 * A pushed page cannot hand a value to the page under it the way a sheet's `onSelect` could, and
 * the alternative — a callback in the navigation params — is a function in state React Navigation
 * is right to warn about. So the choice goes through here: the picker writes it and pops, and the
 * Trade screen applies it when it comes back into view.
 *
 * `seq` is what makes it a message rather than a value. Choosing USDC twice in a row writes the
 * same slot and the same symbol, and an effect watching those would not fire the second time —
 * which is not academic, because the quote the user re-picked may have been changed underneath
 * them by a pair switch in between.
 */
type State = {
  slot: AssetSlot | null;
  symbol: string | null;
  seq: number;
  pick: (slot: AssetSlot, symbol: string) => void;
  clear: () => void;
};

export const useAssetPick = create<State>((set, get) => ({
  slot: null,
  symbol: null,
  seq: 0,
  pick: (slot, symbol) => set({slot, symbol, seq: get().seq + 1}),
  // Called once the choice has been applied, so a screen that mounts later does not act on a
  // message meant for the one before it.
  clear: () => set({slot: null, symbol: null}),
}));

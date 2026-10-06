import {useRef, useState} from 'react';
import type {TextInputProps} from 'react-native';

/**
 * Props that put the caret at the END of a prefilled field when it gains focus.
 *
 * A controlled TextInput whose value is written programmatically — the order sheet seeds the price
 * with the market rate, and the parts field opens on a default — has its caret reset to position 0,
 * so typing landed in front of the number. The selection is forced once on focus and handed straight
 * back to the system, so the user can still tap anywhere in the text afterwards.
 *
 * The handing back is the subtle half. iOS reports the caret it placed on focus — position 0 — as a
 * selection change, and that event lands in the SAME React batch as the forced selection: both
 * updates run, the last one wins, and the field was released before it had moved. So the release
 * waits for an event that actually reports the forced position; anything else while armed is the
 * stale caret talking and is ignored. A tap the user makes afterwards arrives unarmed and is obeyed,
 * which is what keeps the field editable in the middle.
 */
export function useEndCaret(value: string): Pick<TextInputProps, 'selection' | 'onFocus' | 'onSelectionChange'> {
  const [selection, setSelection] = useState<{start: number; end: number} | undefined>(undefined);
  const armed = useRef(false);
  const forced = useRef(0);
  return {
    selection,
    onFocus: () => {
      armed.current = true;
      forced.current = value.length;
      setSelection({start: value.length, end: value.length});
    },
    onSelectionChange: (e) => {
      const {start, end} = e.nativeEvent.selection;
      const stale = armed.current && (start !== forced.current || end !== forced.current);
      // Disarmed either way, so exactly ONE event can be ignored. If the forced position is never
      // reported back, the next event is the user's own tap and it has to win — a field pinned to
      // its end would be one the caret could not be placed in the middle of.
      armed.current = false;
      if (stale) return;
      setSelection(undefined);
    },
  };
}

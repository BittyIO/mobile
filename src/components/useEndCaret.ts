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
 * The handing back is the subtle half, and it has two halves of its own.
 *
 * iOS reports the caret it placed on focus — position 0 — as a selection change, and that event
 * lands in the SAME React batch as the forced selection: both updates run, the last one wins, and
 * the field was released before it had moved. So the release waits for an event that actually
 * reports the forced position; anything else while armed is the stale caret talking and is ignored.
 * A tap the user makes afterwards arrives unarmed and is obeyed, which is what keeps the field
 * editable in the middle.
 *
 * But that release can be denied the chance to happen. If the user TYPES before iOS reports the
 * forced position, the keystroke's own selection change is the thing that gets ignored, and the
 * forced position is still pinned — so it is re-applied on the render that delivers the new text
 * and drags the caret back in front of what was just typed. An EMPTY field hit this every single
 * time: empty means a forced position of 0, which is also where the caret already is, so nothing
 * ever contradicted it. Typing "0.01" put the "0" in, snapped the caret to its left, and sent the
 * "." to the wrong side.
 *
 * So the pin carries the TEXT it was forced for and applies only while that text is unchanged.
 * A keystroke makes it stale in the same render that delivers the keystroke, which is the part a
 * post-render effect cannot do — by then the stale selection has already been applied.
 */
export function useEndCaret(value: string): Pick<TextInputProps, 'selection' | 'onFocus' | 'onSelectionChange'> {
  const [pin, setPin] = useState<{at: number; text: string} | null>(null);
  const armed = useRef(false);
  const forced = useRef(0);
  // Derived, not stored: the pin cannot outlive the text it belongs to.
  const selection = pin && pin.text === value ? {start: pin.at, end: pin.at} : undefined;
  return {
    selection,
    onFocus: () => {
      armed.current = true;
      forced.current = value.length;
      setPin({at: value.length, text: value});
    },
    onSelectionChange: (e) => {
      const {start, end} = e.nativeEvent.selection;
      const stale = armed.current && (start !== forced.current || end !== forced.current);
      // Disarmed either way, so exactly ONE event can be ignored. If the forced position is never
      // reported back, the next event is the user's own tap and it has to win — a field pinned to
      // its end would be one the caret could not be placed in the middle of.
      armed.current = false;
      if (stale) return;
      setPin(null);
    },
  };
}

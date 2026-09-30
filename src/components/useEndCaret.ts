import {useState} from 'react';
import type {TextInputProps} from 'react-native';

/**
 * Props that put the caret at the END of a prefilled field when it gains focus.
 *
 * A controlled TextInput whose value is written programmatically — the order sheet seeds the price
 * with the market rate — has its caret reset to position 0, so typing landed in front of the number.
 * The selection is forced once on focus and handed straight back to the system, so the user can
 * still tap anywhere in the text afterwards.
 */
export function useEndCaret(value: string): Pick<TextInputProps, 'selection' | 'onFocus' | 'onSelectionChange'> {
  const [selection, setSelection] = useState<{start: number; end: number} | undefined>(undefined);
  return {
    selection,
    onFocus: () => setSelection({start: value.length, end: value.length}),
    onSelectionChange: () => setSelection(undefined),
  };
}

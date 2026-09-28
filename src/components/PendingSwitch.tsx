import React from 'react';
import {ActivityIndicator, StyleSheet, Switch, View} from 'react-native';
import {useColors} from '@/theme';

// A UISwitch is 51×31 points. The slot is fixed at that size so swapping in the spinner cannot move
// anything around it.
const W = 51;
const H = 31;

/**
 * The app's switch, in the iOS system's own pattern: while the change is being written the switch is
 * replaced, in place, by a spinner in the same slot — the way Settings behaves for iCloud Drive or a
 * Mail account. When the write lands the switch comes back in its new position.
 *
 * It is never left on screen dimmed and mid-write, which in the light theme made an off switch read
 * as an empty space. The switch itself is unstyled — the system control is the design.
 */
export function PendingSwitch({
  value,
  pending,
  disabled,
  onValueChange,
}: {
  value: boolean;
  pending?: boolean;
  disabled?: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const c = useColors();
  return (
    <View style={styles.slot}>
      {pending ? (
        <ActivityIndicator size="small" color={c.subtext} />
      ) : (
        // The plain system control, unstyled. Every colour I set on it made the light theme worse:
        // a tinted off track filled the pill grey, and ios_backgroundColor drew a second shape behind
        // it. UISwitch already renders correctly on both grounds, so nothing here overrides it.
        <Switch value={value} disabled={disabled} onValueChange={onValueChange} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {width: W, height: H, alignItems: 'center', justifyContent: 'center'},
});

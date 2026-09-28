import {useEffect, useRef} from 'react';
import {Animated, Easing} from 'react-native';

/**
 * A bottom sheet's entrance: the sheet slides up from below while the dimmed backdrop behind it is
 * simply there (the Modal itself uses no animation, so the shade does not fade or slide). Returns the
 * transform for the sheet view; it restarts each time `visible` turns on.
 */
export function useSlideUp(visible: boolean, distance = 480) {
  const y = useRef(new Animated.Value(distance)).current;
  useEffect(() => {
    if (!visible) {
      y.setValue(distance);
      return;
    }
    Animated.timing(y, {toValue: 0, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
  }, [visible, distance, y]);
  return {transform: [{translateY: y}]};
}

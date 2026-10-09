import {useCallback, useEffect, useRef, useState} from 'react';
import {Animated, Easing, PanResponder, useWindowDimensions} from 'react-native';

/**
 * A bottom sheet's motion: it rises on open, follows a downward drag, and slides back out.
 *
 * The sheet OWNS its unmounting. `visible` turning false starts the exit and the Modal stays up
 * until it finishes, which is the part the first attempt at this was missing — it closed the Modal
 * on the same frame the finger lifted, so the sheet vanished instead of leaving. A dismissal you
 * can see is the difference between the gesture feeling like it moved something and feeling like
 * it broke something.
 *
 * The drag is claimed on the MOVE phase only, so buttons, fields and switches keep their taps, and
 * a list inside the sheet keeps its scroll: the responder system offers the gesture to the deepest
 * view first, and a ScrollView being touched will not give it up.
 */
export function useSheetAnim(visible: boolean, onClose: () => void) {
  const {height: screen} = useWindowDimensions();
  // Far enough that the sheet is gone whatever its height.
  const travel = screen;
  const y = useRef(new Animated.Value(travel)).current;
  const [mounted, setMounted] = useState(visible);
  const closing = useRef(false);

  /**
   * Who is told when the exit finishes.
   *
   * An exit the SHEET started (a ✕, a swipe) has to tell its owner, because the owner does not yet
   * know. An exit that `visible` turning false started must not: the owner is the one who turned it
   * false, and calling back into them would be reporting their own instruction to them — which for
   * an owner whose `onClose` is `goBack` would pop a second screen.
   */
  const notify = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  const slideOut = useCallback(
    (velocity = 0) => {
      closing.current = true;
      Animated.timing(y, {
        toValue: travel,
        // A flick carries its own speed into the exit, so a fast throw leaves fast.
        duration: Math.max(140, Math.min(260, 260 - velocity * 60)),
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({finished}) => {
        if (!finished) return;
        closing.current = false;
        setMounted(false);
        /**
         * AFTER the animation, not when it starts.
         *
         * `onClose` used to run on the same tick as the exit began, which is survivable for an
         * owner that only flips a state flag — the sheet stays mounted on its own `mounted` and
         * finishes leaving. It is not survivable for an owner that POPS A ROUTE: the screen was
         * torn down mid-flight, and the card froze halfway down and vanished. (The Earn sheet did
         * exactly that; the order sheet, whose `onClose` is `setSheetSide(null)`, did not.)
         *
         * Running it at the end is also what the order sheet wants. Clearing `sheetSide` while the
         * card is still on screen changes what the card SAYS mid-exit — which is the whole reason
         * it carries a `lastSide` to fall back to.
         */
        if (notify.current) {
          notify.current = false;
          close.current();
        }
      });
    },
    [travel, y],
  );

  useEffect(() => {
    if (visible) {
      closing.current = false;
      setMounted(true);
      y.setValue(travel);
      Animated.timing(y, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else if (mounted && !closing.current) {
      notify.current = false;
      slideOut();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const responder = useRef(
    PanResponder.create({
      // Never on start: every control in the sheet must keep its own tap.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => y.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        // Far enough, or thrown hard enough, to mean it. Either way the sheet carries on from
        // where the finger left it rather than jumping.
        if (g.dy > 110 || g.vy > 0.7) {
          notify.current = true;
          slideOut(g.vy);
          return;
        }
        Animated.spring(y, {toValue: 0, useNativeDriver: true, bounciness: 2, speed: 14}).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(y, {toValue: 0, useNativeDriver: true, bounciness: 2, speed: 14}).start();
      },
    }),
  ).current;

  return {
    /** Drives the Modal: true through the exit animation, false once it has finished. */
    mounted,
    /** On the sheet itself. */
    sheetStyle: {transform: [{translateY: y}]},
    /** On the backdrop, so the shade thins as the sheet is pulled away. */
    backdropStyle: {
      opacity: y.interpolate({inputRange: [0, travel], outputRange: [1, 0], extrapolate: 'clamp'}),
    },
    panHandlers: responder.panHandlers,
    /** Dismiss from a control rather than a gesture — same exit, same timing. */
    requestClose: useCallback(() => {
      notify.current = true;
      slideOut();
    }, [slideOut]),
  };
}

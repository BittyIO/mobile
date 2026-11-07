import React, {useEffect, useLayoutEffect, useMemo, useState} from 'react';
import {Alert, PanResponder, StyleSheet, View} from 'react-native';
import {useNavigation, usePreventRemove} from '@react-navigation/native';
import {useT} from '@/i18n';

/** How far in from the left edge a swipe back starts, as the system's own edge gesture. */
const EDGE_WIDTH = 24;
/** How far it has to travel before it counts as asking to leave. */
const SWIPE_DISTANCE = 40;

/**
 * Leaving a page with unsaved changes asks whether to discard them — and asks BEFORE the page goes.
 *
 * `usePreventRemove` alone handled the back button, but not the swipe: on the native stack iOS lets
 * the page slide off, snaps it back once the pop is refused, and only then is the question asked,
 * so the page looked like it had gone back and returned. While there is something to lose the
 * native swipe is switched off, and a strip along the left edge takes the same gesture and asks
 * first. Nothing to lose, and the page behaves as any other.
 *
 * `active` is whether there is anything to lose; `onDiscard` drops it. Render the returned `edge`
 * as the last child of the page's root view, so it sits over the content.
 */
export function useDiscardGuard(active: boolean, onDiscard: () => void): {edge: React.ReactNode} {
  const {t} = useT();
  const nav = useNavigation();
  // Set once the user has chosen to discard, so the pop that follows is let through.
  const [leaving, setLeaving] = useState(false);

  const ask = (leave: () => void) =>
    Alert.alert(t('mobile.vault.discard_title'), t('mobile.vault.discard_msg'), [
      {text: t('mobile.vault.keep_editing'), style: 'cancel'},
      {
        text: t('mobile.vault.discard'),
        style: 'destructive',
        onPress: () => {
          onDiscard();
          leave();
        },
      },
    ]);

  // The back button (and any other pop): asked, then the same action carried out.
  usePreventRemove(active && !leaving, ({data}) => ask(() => nav.dispatch(data.action)));

  // Discarded from the edge swipe: go once the guard above has stood down.
  useEffect(() => {
    if (leaving) nav.goBack();
  }, [leaving, nav]);

  useLayoutEffect(() => {
    nav.setOptions({gestureEnabled: !active});
  }, [nav, active]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderRelease: (_e, g) => {
          if (g.dx > SWIPE_DISTANCE) ask(() => setLeaving(true));
        },
      }),
    // `ask` reads the latest props through its closure on each call it is given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active],
  );

  return {edge: active ? <View style={styles.edge} {...pan.panHandlers} /> : null};
}

const styles = StyleSheet.create({
  edge: {position: 'absolute', left: 0, top: 0, bottom: 0, width: EDGE_WIDTH},
});

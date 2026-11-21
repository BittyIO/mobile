import React, {useEffect, useMemo, useRef} from 'react';
import {Animated, PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import {useColors, useStyles, type Colors} from '@/theme';

/** How far the row slides to show its action: the button's own width. */
const ACTION_WIDTH = 96;

/**
 * A list row that slides left to show one action behind it, as iOS lists do ("Remove").
 *
 * Built on React Native's own responder system rather than a gesture library's swipeable, which
 * needs its root view wrapped around the whole app. The row only claims the touch once it is
 * clearly moving sideways, so a scroll down the page and a tap on the row (or on a button inside
 * it) behave as they did. `open` is held by the list, so opening one row closes the one before.
 */
export function SwipeRow({
  open,
  onOpen,
  onClose,
  actionLabel,
  onAction,
  disabled = false,
  children,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  actionLabel: string;
  onAction: () => void;
  /** No action for this row (the last vault on the phone): it does not slide. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const x = useRef(new Animated.Value(0)).current;
  const openRef = useRef(open);
  openRef.current = open;
  const cb = useRef({onOpen, onClose});
  cb.current = {onOpen, onClose};

  const settle = (to: number) => Animated.spring(x, {toValue: to, useNativeDriver: true, bounciness: 0, speed: 20}).start();
  useEffect(() => {
    settle(open ? -ACTION_WIDTH : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Sideways and past a few points: a scroll or a tap never gets here.
        onMoveShouldSetPanResponderCapture: (_, g) => !disabled && Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, g) => {
          const base = openRef.current ? -ACTION_WIDTH : 0;
          x.setValue(Math.max(-ACTION_WIDTH * 1.3, Math.min(0, base + g.dx)));
        },
        onPanResponderRelease: (_, g) => {
          const base = openRef.current ? -ACTION_WIDTH : 0;
          const end = base + g.dx;
          const opening = end < -ACTION_WIDTH / 2 || g.vx < -0.5;
          settle(opening ? -ACTION_WIDTH : 0);
          if (opening && !openRef.current) cb.current.onOpen();
          if (!opening && openRef.current) cb.current.onClose();
        },
        onPanResponderTerminate: () => settle(openRef.current ? -ACTION_WIDTH : 0),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled],
  );

  return (
    <View style={styles.wrap}>
      {/* Behind the row, uncovered as it slides. */}
      <Pressable
        style={[styles.action, {backgroundColor: c.danger}]}
        onPress={() => {
          onClose();
          onAction();
        }}
        accessibilityRole="button"
        accessibilityLabel={actionLabel}>
        <Text style={styles.actionText} numberOfLines={2}>
          {actionLabel}
        </Text>
      </Pressable>
      <Animated.View
        style={[styles.front, {transform: [{translateX: x}]}]}
        {...pan.panHandlers}
        // VoiceOver has no swipe to find: the action is offered as one of the row's own.
        accessibilityActions={disabled ? undefined : [{name: 'remove', label: actionLabel}]}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === 'remove' && onAction()}>
        {children}
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {position: 'relative', overflow: 'hidden'},
    action: {position: 'absolute', top: 0, bottom: 0, right: 0, width: ACTION_WIDTH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8},
    actionText: {color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center'},
    // Opaque, in the card's colour, so the action shows only where the row has slid away.
    front: {backgroundColor: c.card},
  });

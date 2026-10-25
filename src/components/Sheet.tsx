import React, {useEffect, useRef, useState} from 'react';
import {Animated, Keyboard, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {useSheetAnim} from '@/components/useSheetAnim';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * How much of the screen a sheet covers. One number for every sheet in the app, so they all come up
 * to the same line and the app does not look like it has five different kinds of popup. The trade
 * order form is the exception and sets its own, because it carries a whole form.
 */
export const SHEET_HEIGHT_RATIO = 0.618;

/**
 * The app's bottom sheet: a dimmed backdrop, a card that slides up from the bottom, and a title row
 * with a close control.
 *
 * Everything that would otherwise be a pushed page but is really one short decision belongs here —
 * an asset choice, the network, the fee coins. The chrome lives in one place so the drag, the
 * corner radius and the safe-area padding cannot drift between sheets.
 *
 * Dismissed three ways, all of which run the same exit: a swipe down on the card, the backdrop,
 * or the close control. The backdrop closes on tap, so the card itself swallows taps that are not
 * aimed at a control.
 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
  height,
  done,
  right,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Overrides the shared height, in points. */
  height?: number;
  /**
   * Label the dismiss control "Done" instead of drawing a ✕.
   *
   * For a sheet the user composes something in — ticking sources, setting amounts — every edit
   * is already applied, so a ✕ reads as "discard" when closing in fact commits. Sheets that
   * pick one thing and close, or that carry their own confirm button, keep the ✕.
   */
  done?: boolean;
  /**
   * Something to show at the right of the title INSTEAD of the dismiss control — a figure the sheet
   * is about. The backdrop and the swipe still close it, so a read-only sheet needs no ✕.
   */
  right?: React.ReactNode;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {height: screenHeight} = useWindowDimensions();
  const {mounted, sheetStyle, backdropStyle, panHandlers, requestClose} = useSheetAnim(visible, onClose);

  /**
   * Get out of the keyboard's way.
   *
   * A sheet is pinned to the bottom of the screen, which is exactly where the keyboard appears, so
   * any sheet with a field in it had its field and its confirm button underneath one — the rename
   * sheets were unusable. Lifting by the keyboard's own height puts the whole card above it.
   *
   * `keyboardWillShow` rather than `Did`: it fires BEFORE the keyboard moves and carries the
   * duration of that movement, so the card travels with it instead of jumping once it has arrived.
   * The height is capped as well as lifted — a tall sheet plus a keyboard is taller than the
   * screen, and without the cap the top of the card would be pushed off it.
   *
   * The lift sits on its OWN view, which is not a tidiness choice. The card below it is animated by
   * `useSheetAnim` with `useNativeDriver: true`, which hands that node to the native animation
   * driver; a JS-driven prop on a node the native driver owns throws, and `marginBottom` is a
   * layout property that can never be native. Putting the two animations on the same view crashed
   * the app the moment a keyboard opened over a sheet. Two nodes, two drivers, no argument.
   */
  const lift = useRef(new Animated.Value(0)).current;
  const [keyboard, setKeyboard] = useState(0);
  /**
   * The offset belongs to a sheet that is ON SCREEN, and to no other.
   *
   * It used to be tracked for the life of the component, which outlives every appearance: a sheet
   * is rendered with `visible={false}` and sits there listening. So a keyboard that had nothing to
   * do with it — the list name being typed in the nav bar, a field in the sheet before this one —
   * moved its lift and shrank its height, and the next time it opened it came up short with a
   * keyboard-sized band of nothing under it. The source picker has no field at all and was showing
   * the gap left by the paste field it replaced.
   *
   * So the listeners live and die with the card, and going off screen puts the offset back to zero
   * rather than waiting for a `keyboardWillHide` that may never arrive — a keyboard dismissed by
   * the modal going away is dismissed by UIKit, not by anything this sheet can hear.
   *
   * Seeded from the keyboard that is already up, because a sheet opened from a focused field has
   * missed the `willShow` that would have told it.
   */
  useEffect(() => {
    if (!mounted) {
      setKeyboard(0);
      lift.setValue(0);
      return;
    }
    const move = (to: number, duration: number) => {
      setKeyboard(to);
      Animated.timing(lift, {toValue: to, duration: duration || 250, useNativeDriver: false}).start();
    };
    const open = Keyboard.metrics?.()?.height ?? 0;
    if (open > 0) {
      setKeyboard(open);
      lift.setValue(open);
    }
    const show = Keyboard.addListener('keyboardWillShow', (e) => move(e.endCoordinates.height, e.duration));
    const hide = Keyboard.addListener('keyboardWillHide', (e) => move(0, e.duration));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [mounted, lift]);

  // 72 leaves a strip of backdrop above the card, so it never reads as a full-screen page.
  const wanted = height ?? Math.round(screenHeight * SHEET_HEIGHT_RATIO);
  const sheetHeight = Math.min(wanted, screenHeight - keyboard - 72);
  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={requestClose}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.shade, backdropStyle]} />
      <Pressable style={styles.backdrop} onPress={requestClose}>
        <Animated.View style={{marginBottom: lift}}>
          <Animated.View style={[{height: sheetHeight}, sheetStyle]} {...panHandlers}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <View style={styles.head}>
                <Text style={styles.title}>{title}</Text>
                {right ?? (
                  <Pressable onPress={requestClose} hitSlop={10}>
                    <Text style={done ? styles.done : styles.close}>{done ? t('vault.done') : '✕'}</Text>
                  </Pressable>
                )}
              </View>
              {children}
            </Pressable>
          </Animated.View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    // The shade is its own layer so it can fade with the drag; the backdrop above it only catches
    // taps, which is why it has no colour of its own.
    shade: {backgroundColor: c.overlay},
    backdrop: {flex: 1, justifyContent: 'flex-end'},
    sheet: {
      flex: 1,
      backgroundColor: c.elevated,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      padding: 20,
      paddingBottom: 34,
      gap: 12,
    },
    head: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
    title: {color: c.text, fontSize: 18, fontWeight: '700'},
    close: {color: c.subtext, fontSize: 18},
    done: {color: c.accent, fontSize: 16, fontWeight: '600'},
  });

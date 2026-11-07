import React from 'react';
import {Animated, Keyboard, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {initialWindowMetrics, useSafeAreaInsets} from 'react-native-safe-area-context';
import {useSheetAnim} from '@/components/useSheetAnim';
import {useStyles, type Colors} from '@/theme';

/**
 * The tall sheet a FORM lives in: the trade order sheet, and the Earn deposit/withdraw sheet.
 *
 * Distinct from {Sheet}, which is for one short decision and stops at 0.618 of the screen. A form
 * carries fields, a slider and a confirm button, and with a keyboard over them two thirds of a
 * screen means scrolling to reach the button that commits — so this one is inset from the TOP by
 * the status bar and takes everything below it.
 *
 * It exists because there were two of these and they had drifted. The order sheet had the backdrop,
 * the drag, the inset and the ✕; the Earn form was being hand-built to match and came out centred,
 * with a navigation bar, no swipe, and its card under the clock. The chrome belongs in one place
 * for the same reason the order row did: every correction to it was otherwise a correction to make
 * twice, and the second one never happened.
 */
export const FORM_SHEET_BODY = {gap: 10, paddingBottom: 34} as const;

export function FormSheet({
  visible,
  onClose,
  children,
  closable = true,
  overlay,
  ownModal = true,
}: {
  visible: boolean;
  /** Run when the sheet has finished leaving — pop the route, clear the state, whatever opened it. */
  onClose: () => void;
  children: React.ReactNode;
  /**
   * False while something is in flight, which withholds every way out at once: the ✕, the backdrop
   * and the drag. A sheet whose work cannot be interrupted should not look interruptible.
   */
  closable?: boolean;
  /**
   * Rendered inside the host but OUTSIDE the card: a picker the form opens, a toast host.
   *
   * A sheet presented from outside this one opens BEHIND it — it belongs to a view hierarchy the
   * card is already covering — so anything the form puts on top of itself has to be mounted in
   * here. It is a slot rather than part of `children` because its contents must not sit in the
   * card's padding or scroll with the form.
   */
  overlay?: React.ReactNode;
  /**
   * False when this is already the content of a modal ROUTE.
   *
   * Opened from inside a screen it needs a Modal of its own; presented as a `transparentModal`
   * route it is in one already, and nesting a second would be asking iOS to present over a
   * presentation it has only just finished — which it drops. One flag, because the thing it
   * describes is genuinely two different hosts and not a style.
   */
  ownModal?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  /**
   * Where the card's top edge sits: the status bar plus 8.
   *
   * `useSafeAreaInsets` reads a CONTEXT, and a transparent modal route is presented by
   * react-native-screens in its own view controller — the provider the hook reads from belongs to
   * the tree underneath, so in that case it can answer 0, and the card starts 8 points from the
   * top of the screen, under the clock. `initialWindowMetrics` is measured once at launch and is
   * not a context, so it survives the presentation; the literal is a last resort.
   */
  const top = insets.top || initialWindowMetrics?.insets.top || 44;
  const sheet = useSheetAnim(visible, onClose);
  const close = () => closable && sheet.requestClose();
  if (!sheet.mounted) return null;

  const body = (
    <View style={styles.wrap}>
      {/* The shade fades as the card is pulled away, so the gesture moves the whole thing rather
          than sliding a card off a fixed grey. */}
      <Animated.View style={[styles.backdrop, sheet.backdropStyle]}>
        <Pressable style={styles.fill} onPress={close} />
      </Animated.View>
      {/* The drag is on the CARD and is claimed on movement only, so fields keep their taps and a
          ScrollView inside keeps its own gesture. See {useSheetAnim}. */}
      <Animated.View style={[styles.card, {marginTop: top + 8}, sheet.sheetStyle]} {...(closable ? sheet.panHandlers : {})}>
        {/* The way out, and nothing else. What the sheet is FOR is said by the control that opened
            it and by the button that commits it; a title between them is a third telling. */}
        <View style={styles.head}>
          <Pressable onPress={close} hitSlop={10}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        {/* Tapping the card's own ground puts the keyboard away. The form's controls are nested
            pressables and still win their taps. */}
        <Pressable style={styles.fill} onPress={() => Keyboard.dismiss()}>
          {children}
        </Pressable>
      </Animated.View>
      {overlay}
    </View>
  );

  if (!ownModal) return body;
  return (
    <Modal transparent visible animationType="none" onRequestClose={close}>
      {body}
    </Modal>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    // Pushed to the bottom so the card's own `marginTop` is what decides its height — the same way
    // the order sheet has always been sized, and why it stands on the same line on any screen.
    wrap: {flex: 1, justifyContent: 'flex-end'},
    backdrop: {...StyleSheet.absoluteFillObject, backgroundColor: c.overlay},
    fill: {flex: 1},
    card: {
      flex: 1,
      backgroundColor: c.elevated,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: 20,
      paddingTop: 12,
    },
    /**
     * 12 under the ✕, not 4.
     *
     * The order sheet's first row is its mode strip, whose buttons carry 6 points of their own
     * padding, so its content has always sat about ten points below the close control. A form
     * whose first row is a field or a chip has no such padding and came up hard against it — the
     * amount looked like it was trying to get out from under the button. The gap belongs to the
     * chrome, so both get it and neither caller has to know the number.
     */
    head: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 12},
    close: {color: c.subtext, fontSize: 18},
    /**
     * What a form's own content wants: the order sheet's rhythm, exported so a caller does not
     * have to know it. The 34 clears the home indicator, since the card runs to the very bottom.
     *
     * The component does NOT impose a ScrollView. The order sheet does not scroll — its fields fit
     * the card — and wrapping it in one would have changed how its nested pickers and its keyboard
     * behave for no gain. A form that needs to scroll brings its own and spreads this on it.
     */
    body: {gap: 10, paddingBottom: 34},
  });

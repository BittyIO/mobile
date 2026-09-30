import React from 'react';
import {Animated, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
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
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {height: screenHeight} = useWindowDimensions();
  const {mounted, sheetStyle, backdropStyle, panHandlers, requestClose} = useSheetAnim(visible, onClose);
  const sheetHeight = height ?? Math.round(screenHeight * SHEET_HEIGHT_RATIO);
  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={requestClose}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.shade, backdropStyle]} />
      <Pressable style={styles.backdrop} onPress={requestClose}>
        <Animated.View style={[{height: sheetHeight}, sheetStyle]} {...panHandlers}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.head}>
              <Text style={styles.title}>{title}</Text>
              <Pressable onPress={requestClose} hitSlop={10}>
                <Text style={done ? styles.done : styles.close}>{done ? t('vault.done') : '✕'}</Text>
              </Pressable>
            </View>
            {children}
          </Pressable>
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

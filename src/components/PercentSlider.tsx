import React, {useEffect, useRef, useState} from 'react';
import {Animated, PanResponder, StyleSheet, View} from 'react-native';
import {useStyles, type Colors} from '@/theme';

/**
 * A 0–100 slider for "how much of the balance", with the quarter marks called out.
 *
 * Built on PanResponder rather than a slider package: the only thing that would provide this is a
 * native module, and the Overview's drag-to-reorder rows already do their gesture work this way.
 *
 * Two things make it behave. The thumb is driven by an Animated value the GESTURE owns, so a
 * drag repaints the track on the native thread and never re-renders the screen behind it — the
 * Trade sheet rebuilds two amount fields and a quote on every value change, and committing on
 * each touch-move made the whole sheet flash. And the value is committed on RELEASE (plus on a
 * tap, and when a mark is hit), so the figures settle once instead of forty times.
 *
 * The quarter marks are dots on the track, not a row of captions: the drag snaps to one within
 * two percent, and a tap anywhere on the track lands on the nearest, so 50% is reachable with a
 * thumb without spending a line of the sheet on labels that repeat what the thumb already shows.
 */
const THUMB = 14;
const PAD = THUMB / 2;
const MARKS = [25, 50, 75, 100];
/** How near a mark counts as hitting it. Two percent of the track, in percent. */
const SNAP = 2;

export function PercentSlider({
  value,
  onChange,
  disabled,
}: {
  /** 0–100. Clamped here, so a caller may hand over a raw ratio. */
  value: number;
  onChange: (pct: number) => void;
  disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const span = Math.max(0, width - THUMB);
  const clamp = (p: number) => Math.max(0, Math.min(100, p));
  const shown = clamp(Number.isFinite(value) ? value : 0);

  /**
   * Where the thumb is, in percent, as an Animated value.
   *
   * Written by the gesture and by `value`, read only by the two transforms below — so neither a
   * drag nor a typed amount costs this component a render, let alone its parent.
   */
  const pos = useRef(new Animated.Value(shown)).current;
  const dragging = useRef(false);
  useEffect(() => {
    // A typed amount or a Max tap moves the thumb; a drag already owns it.
    if (!dragging.current) pos.setValue(shown);
  }, [shown, pos]);

  // Read inside the responder, which is created once and would otherwise close over the first
  // render's width — the same trap the reorder responder documents.
  const live = useRef({span: 0, disabled: false, onChange});
  live.current = {span, disabled: !!disabled, onChange};

  const pctAt = (x: number) => {
    const {span: s} = live.current;
    if (s <= 0) return 0;
    const raw = clamp(((x - PAD) / s) * 100);
    const mark = MARKS.find((m) => Math.abs(raw - m) <= SNAP);
    return mark ?? Math.round(raw);
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.disabled,
      onMoveShouldSetPanResponder: () => !live.current.disabled,
      // Claimed on grant: the sheet scrolls, and a drag along the track would otherwise be read
      // as a scroll and leave the thumb behind.
      onPanResponderGrant: (e) => {
        dragging.current = true;
        pos.setValue(pctAt(e.nativeEvent.locationX));
      },
      // Thumb only. The amount fields are not rebuilt until the finger lifts.
      onPanResponderMove: (e) => pos.setValue(pctAt(e.nativeEvent.locationX)),
      onPanResponderRelease: (e) => {
        dragging.current = false;
        const p = pctAt(e.nativeEvent.locationX);
        pos.setValue(p);
        live.current.onChange(p);
      },
      onPanResponderTerminate: () => {
        dragging.current = false;
        pos.setValue(shown);
      },
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  const toX = (extra = 0) =>
    pos.interpolate({inputRange: [0, 100], outputRange: [extra, span + extra], extrapolate: 'clamp'});

  return (
    <View style={styles.row} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} {...responder.panHandlers}>
      <View style={[styles.track, disabled && styles.off]} />
      {/* The quarter marks, on the track itself — a dot at each, filled once passed. */}
      {MARKS.map((m) => (
        <View
          key={m}
          style={[styles.mark, {left: PAD + (span * m) / 100 - 2}, shown >= m && styles.markOn, disabled && styles.off]}
        />
      ))}
      <Animated.View style={[styles.fill, {width: toX()}, disabled && styles.off]} />
      <Animated.View style={[styles.thumb, {transform: [{translateX: toX()}]}, disabled && styles.off]} />
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    // Tall enough to be hittable; the track inside it is a hairline.
    row: {height: 28, justifyContent: 'center'},
    track: {position: 'absolute', left: PAD, right: PAD, height: 2, borderRadius: 1, backgroundColor: c.border},
    fill: {position: 'absolute', left: PAD, height: 2, borderRadius: 1, backgroundColor: c.accent},
    mark: {position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: c.border},
    markOn: {backgroundColor: c.accent},
    thumb: {position: 'absolute', left: 0, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: c.accent},
    off: {opacity: 0.4},
  });

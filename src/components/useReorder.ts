import {useRef, useState} from 'react';
import {Animated, PanResponder, type GestureResponderEvent, type LayoutChangeEvent} from 'react-native';

/**
 * Long press and drag to reorder a list — the watch lists' gesture, shared.
 *
 * Row heights differ — an open row is taller than a closed one — so the drop target is worked
 * out from measured heights rather than assuming they match. The row in hand is lifted and
 * follows the finger; the rows it passes slide out of its way by exactly its height, so the gap
 * that opens is the one it will land in.
 *
 * Spread `rowProps(i)` on each row's Animated.View, and pass `onHold(i)` to the row's own long
 * press. `from` is the row in hand, for the caller's lifted style.
 */
export function useReorder<T>({
  items,
  enabled,
  onReorder,
  onDragging,
}: {
  items: T[];
  /** A list that cannot be reordered attaches nothing, so a hold on it is just a long press. */
  enabled: boolean;
  /** The new order, once a drag settles. */
  onReorder: (next: T[]) => void;
  /** The parent stops scrolling while a row is in hand. */
  onDragging: (active: boolean) => void;
}) {
  const [heights, setHeights] = useState<number[]>([]);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState(0);
  const dy = useRef(new Animated.Value(0)).current;
  // Read inside the responder, which is created once and would otherwise see the first render.
  //
  // `onReorder` has to live here too, not just the data. It is rebuilt every render around the
  // CURRENT network, so the copy the responder captured on mount writes to whichever network was
  // showing when the list first mounted — which is why a drag once appeared to work on Ethereum
  // and do nothing anywhere else: every other network's order was being saved under Ethereum's key.
  const live = useRef({items, heights, from: null as number | null, to: 0, onReorder, onDragging});
  live.current = {...live.current, items, heights, onReorder, onDragging};

  const measure = (i: number, h: number) =>
    setHeights((prev) => (prev[i] === h ? prev : Object.assign([...prev], {[i]: h})));

  /** Which slot the dragged row's own centre now sits over. */
  const slotFor = (offset: number) => {
    const {heights: hs, from: f} = live.current;
    if (f == null) return 0;
    const own = hs[f] ?? 0;
    let target = f;
    let travelled = 0;
    if (offset > 0) {
      for (let i = f + 1; i < hs.length; i++) {
        travelled += hs[i] ?? own;
        if (offset > travelled - (hs[i] ?? own) / 2) target = i;
        else break;
      }
    } else {
      for (let i = f - 1; i >= 0; i--) {
        travelled += hs[i] ?? own;
        if (-offset > travelled - (hs[i] ?? own) / 2) target = i;
        else break;
      }
    }
    return target;
  };

  const responder = useRef(
    PanResponder.create({
      // Only a long press starts this. A plain touch belongs to the row's own targets.
      onStartShouldSetPanResponder: () => false,
      // CAPTURE, not the bubbling variant. The row's own Pressable holds the responder from the
      // moment the finger lands, and a bubbling claim asks it to hand over — which it does not do
      // reliably once it has fired its long press. Asking on the way DOWN the tree takes the
      // gesture before the Pressable sees the move at all. The start handler stays false, so a
      // plain tap still belongs to the row.
      onMoveShouldSetPanResponderCapture: () => live.current.from != null,
      onMoveShouldSetPanResponder: () => live.current.from != null,
      // Nothing takes the gesture back mid-drag — not the page, not the row's own Pressable.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderMove: (_e: unknown, g: {dy: number}) => {
        dy.setValue(g.dy);
        const next = slotFor(g.dy);
        if (next !== live.current.to) {
          live.current.to = next;
          setTo(next);
        }
      },
      onPanResponderRelease: () => finish(),
      onPanResponderTerminate: () => finish(),
    }),
  ).current;

  const finish = () => {
    const {items: rs, from: f, to: target, onReorder: save, onDragging: dragging} = live.current;
    if (f != null && target !== f) {
      const next = [...rs];
      next.splice(target, 0, next.splice(f, 1)[0]);
      save(next);
    }
    cancelHold();
    live.current.from = null;
    setFrom(null);
    dy.setValue(0);
    dragging(false);
  };

  /**
   * Arm the drag on a long hold, timed from the touch itself.
   *
   * Pressable's own onLongPress cancels the moment the finger drifts, which on a scrolling list is
   * most holds. A timer started by the raw touch survives that, and the press handlers underneath
   * are left alone so a tap still does what it did.
   *
   * It survives drift, so it has to be told what drift means. The window was a fifth of a second
   * and ignored the finger entirely, and the first fifth of a second of a pull-to-refresh is a
   * finger resting on a row: the row came up, {onDragging} froze the scroll, and pulling the list
   * down to refresh reordered it instead. So the window is now the platform's own long press, and
   * travel inside it says the gesture was a scroll all along. The slop is wide enough for a hand
   * that is not quite still and far short of a scroll.
   */
  const HOLD_MS = 500;
  const HOLD_SLOP = 12;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdFrom = useRef<{x: number; y: number} | null>(null);
  const armHold = (i: number, e: GestureResponderEvent) => {
    holdFrom.current = {x: e.nativeEvent.pageX, y: e.nativeEvent.pageY};
    holdTimer.current = setTimeout(() => begin(i), HOLD_MS);
  };
  /**
   * The finger moved before the hold matured, so it was scrolling. Abandons the hold.
   *
   * Once a row IS in hand this is the drag itself and must be left alone — the PanResponder owns
   * the gesture from that point and the finger is meant to travel.
   */
  const holdDrift = (e: GestureResponderEvent) => {
    const at = holdFrom.current;
    if (!at || live.current.from != null) return;
    const {pageX, pageY} = e.nativeEvent;
    if (Math.abs(pageX - at.x) > HOLD_SLOP || Math.abs(pageY - at.y) > HOLD_SLOP) cancelHold();
  };
  const cancelHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdFrom.current = null;
  };
  /**
   * The finger left. Cancels a hold that never matured, and puts down a row that was lifted but
   * never moved — without this it stays picked up for ever, because the drag responder only ends
   * a gesture it actually took.
   */
  const endTouch = () => {
    cancelHold();
    if (live.current.from != null) finish();
  };

  const begin = (i: number) => {
    live.current.from = i;
    live.current.to = i;
    setFrom(i);
    setTo(i);
    dy.setValue(0);
    live.current.onDragging(true);
  };

  /** How far a row that is not the one in hand has to step aside. */
  const shiftFor = (i: number) => {
    if (from == null || i === from) return 0;
    const own = heights[from] ?? 0;
    if (from < to && i > from && i <= to) return -own;
    if (from > to && i >= to && i < from) return own;
    return 0;
  };

  return {
    from,
    rowProps: (i: number) => ({
      onLayout: (e: LayoutChangeEvent) => measure(i, e.nativeEvent.layout.height),
      style: {transform: [{translateY: from === i ? dy : shiftFor(i)}]},
      // Attached to every row of a list that CAN be reordered, always. Adding them only once a row
      // is held meant the view joined the responder negotiation after the touch had already
      // started, and the move was never offered to it — which is why nothing moved.
      ...(enabled
        ? {
            onTouchStart: (e: GestureResponderEvent) => armHold(i, e),
            onTouchMove: holdDrift,
            onTouchEnd: endTouch,
            onTouchCancel: endTouch,
            ...responder.panHandlers,
          }
        : {}),
    }),
    /**
     * For the row's own long press. Gated by the same drift check as the timer: Pressable keeps its
     * long press alive while the finger stays inside a generously padded press rect, so on its own
     * it would fire part-way through a slow pull and pick the row up after the drift check had
     * already decided the gesture was a scroll.
     */
    onHold: (i: number) => (enabled ? () => holdFrom.current && begin(i) : undefined),
  };
}

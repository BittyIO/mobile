import React, {useEffect, useRef} from 'react';
import {ActivityIndicator, Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {Path} from 'react-native-svg';
import Clipboard from '@react-native-clipboard/clipboard';
import {create} from 'zustand';
import {EXPLORER_TX, type Network} from '@/core/chain';
import {trackTx, usePending} from '@/vault/pending';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {openLink} from '@/core/open-link';

export type ToastKind = 'pending' | 'success' | 'error';

export type Toast = {
  id: number;
  kind: ToastKind;
  /** What the user did, in their own words: "Deposit 100 USDC", "Send 50 USDC". */
  title: string;
  /** The status line under it; defaults to Submitting / Confirmed / Failed. */
  detail?: string;
  hash?: string;
  network?: Network;
  /** Where the hash opens when it is not an EVM network's (a Tron send): the explorer's tx URL prefix. */
  explorer?: {url: string; name: string};
  /** How long a finished toast stays up, when not its kind's default. */
  ms?: number;
};

type State = {
  items: Toast[];
  show: (t: Omit<Toast, 'id'>) => number;
  update: (id: number, patch: Partial<Omit<Toast, 'id'>>) => void;
  dismiss: (id: number) => void;
};

let nextId = 1;

/** The toast queue. Two at most are on screen; the newest sits highest. */
export const useToasts = create<State>((set) => ({
  items: [],
  show: (t) => {
    const id = nextId++;
    set((s) => ({items: [...s.items, {...t, id}].slice(-2)}));
    return id;
  },
  update: (id, patch) => set((s) => ({items: s.items.map((i) => (i.id === id ? {...i, ...patch} : i))})),
  dismiss: (id) => set((s) => ({items: s.items.filter((i) => i.id !== id)})),
}));

/**
 * A submitted transaction, as one toast that follows it to settlement.
 *
 * It used to announce nothing while in flight and leave the counting to a badge in the header's
 * corner — which meant the hash, the only thing a user can take to a block explorer, was never
 * shown anywhere. Now the toast is the whole report: Submitting while the signature and the relay
 * are in progress, then the hash with a link to the explorer the moment it is broadcast, then
 * Confirmed or Failed when the chain says so.
 *
 * One toast, updated in place, rather than one per stage: three toasts for one deposit is a stack
 * that outlives the thing it describes, and the queue only holds two.
 *
 *   const tx = showTx('Deposit 100 USDC', network);
 *   try { tx.success(await deposit(...)); } catch (e) { tx.error(String(e)); }
 */
export function showTx(
  title: string,
  network: Network,
  opts?: {
    /**
     * Is anything actually going to the chain?
     *
     * False for an action that only SIGNS — a CoW limit or TWAP order is an off-chain signature
     * posted to the order book, so there is no broadcast to announce and no hash to wait for. Such
     * a toast resolves on its own `success`, since nothing will ever confirm it.
     */
    broadcast?: boolean;
  },
) {
  const id = useToasts.getState().show({kind: 'pending', title, network});
  /** Watching the chain for THIS hash; dropped the moment it settles or the write gives up. */
  let unwatch: (() => void) | null = null;
  const stop = () => {
    unwatch?.();
    unwatch = null;
  };
  return {
    success: (hash?: string) => {
      stop();
      // Nothing was broadcast — a signature, posted off chain. It is done, and done now.
      if (!hash || opts?.broadcast === false) {
        useToasts.getState().update(id, {kind: 'success'});
        return;
      }
      // The hash goes in first so the explorer link is there for the whole wait, which is when
      // somebody actually wants it.
      trackTx(hash, network, title);
      useToasts.getState().update(id, {kind: 'pending', hash});
      /**
       * Settlement comes from the pending store, which is already watching every tracked hash —
       * see {watch} there. Subscribing beats polling and means a confirmation that arrives after
       * the user has navigated away still closes the toast out.
       */
      unwatch = usePending.subscribe((s) => {
        const tx = s.txs.find((t) => t.hash === hash);
        if (!tx || tx.status === 'pending') return;
        useToasts.getState().update(id, {kind: tx.status === 'confirmed' ? 'success' : 'error', hash});
        stop();
      });
    },
    error: (detail?: string) => {
      stop();
      useToasts.getState().update(id, {kind: 'error', detail});
    },
    /**
     * Nothing was submitted after all — a precondition the handler only discovers once it is under
     * way. The toast goes with it: there is no outcome to report and a lingering "Submitting" over
     * a write that never started is worse than silence.
     */
    done: () => {
      stop();
      useToasts.getState().dismiss(id);
    },
  };
}

/** A toast for something that finished without a transaction (a local change, a failed precondition). */
export function showToast(kind: ToastKind, title: string, detail?: string, ms?: number) {
  useToasts.getState().show({kind, title, detail, ms});
}

const AUTO_MS: Record<ToastKind, number> = {pending: 0, success: 4000, error: 7000};

/** How far a swiped card travels before it is gone — past the widest phone, so it clears. */
const SWIPE_OUT = 500;

function Row({item, index}: {item: Toast; index: number}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const dismiss = useToasts((s) => s.dismiss);
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
  }, [enter]);

  // A finished toast clears itself; a pending one waits to be flipped.
  useEffect(() => {
    const ms = item.kind === 'pending' ? 0 : (item.ms ?? AUTO_MS[item.kind]);
    if (!ms) return;
    const timer = setTimeout(() => dismiss(item.id), ms);
    return () => clearTimeout(timer);
  }, [item.kind, item.id, item.ms, dismiss]);

  const explorer = item.explorer?.url ?? (item.network ? EXPLORER_TX[item.network] : null);
  /**
   * Broadcast is its own stage, and the hash is how it says so.
   *
   * A pending toast with no hash is still being signed or relayed; one WITH a hash is on the chain
   * and waiting for a block, which is the state the header badge used to count. The abbreviated
   * hash sits on the same line because it is the status, not a second fact — and it is what a
   * reader checks against the explorer a tap opens.
   */
  const stage = item.kind === 'pending' ? (item.hash ? 'mobile.home.confirming' : 'vault.submitting') : item.kind === 'success' ? 'vault.confirmed' : 'vault.failed';
  /**
   * As much of the hash as ONE line holds.
   *
   * It is the thing on the toast a reader checks character by character, so the elision is kept as
   * small as the width allows — but the card is inset 56 points on the left now to clear a back
   * button, and at eighteen-and-twelve the hash wrapped. A status line that takes two lines pushes
   * the card into the content below it for the sake of six more characters nobody was reading.
   */
  const short = item.hash ? `${item.hash.slice(0, 12)}…${item.hash.slice(-8)}` : null;
  const detail = item.detail ?? t(stage);
  const tint = item.kind === 'success' ? c.success : item.kind === 'error' ? c.danger : c.subtext;
  // Tronscan names a transaction by its id without the 0x the app carries it with.
  const tronTx = item.network === 'tron-nile' || explorer?.includes('tronscan');
  const link = item.hash && explorer ? explorer + (tronTx ? item.hash.replace(/^0x/, '') : item.hash) : null;

  /**
   * Swipe sideways to get rid of it; the ✕ in the corner for anyone who does not know that.
   *
   * The card's own tap used to dismiss, which spent the biggest target on the screen's least
   * interesting action and left the transaction — the thing the toast is ABOUT — reachable only
   * through a small "View ↗". Now the card opens the transaction and dismissing is the gesture
   * every notification on the platform already uses, with a visible control beside it.
   *
   * Built once per row and never rebuilt: a PanResponder re-created mid-gesture drops the gesture.
   * A row's `id` never changes and `dismiss` is a stable store action, so the closure stays true.
   */
  const dx = useRef(new Animated.Value(0)).current;
  const pan = useRef(
    PanResponder.create({
      // Only claim HORIZONTAL movement, and only past a threshold: the host sits over the tab bar
      // and a vertical drag belongs to whatever is scrolling underneath.
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_e, g) => dx.setValue(g.dx),
      onPanResponderRelease: (_e, g) => {
        // Distance OR speed: a short flick means the same thing as a long drag.
        if (Math.abs(g.dx) > 90 || Math.abs(g.vx) > 0.4) {
          Animated.timing(dx, {
            toValue: g.dx > 0 ? SWIPE_OUT : -SWIPE_OUT,
            duration: 160,
            useNativeDriver: true,
          }).start(() => dismiss(item.id));
          return;
        }
        Animated.spring(dx, {toValue: 0, useNativeDriver: true, bounciness: 0}).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(dx, {toValue: 0, useNativeDriver: true, bounciness: 0}).start();
      },
    }),
  ).current;

  return (
    <Animated.View
      {...pan.panHandlers}
      style={[
        styles.toast,
        {
          // Fades as it travels, so the card does not simply vanish at the threshold.
          opacity: Animated.multiply(
            enter,
            dx.interpolate({inputRange: [-SWIPE_OUT, 0, SWIPE_OUT], outputRange: [0, 1, 0]}),
          ),
          transform: [
            {translateX: dx},
            // Down from behind the header, which is where it comes from.
            {translateY: enter.interpolate({inputRange: [0, 1], outputRange: [-16, 0]})},
            {scale: 1 - index * 0.02},
          ],
        },
      ]}>
      <Pressable
        style={styles.body}
        // The transaction, which is what a reader wants from a toast that names one. Nothing to
        // open while it is still being signed, so the card is inert until the hash arrives.
        onPress={link ? () => openLink(link, item.explorer?.name ?? (tronTx ? 'Tronscan' : 'Etherscan')) : undefined}
        onLongPress={() => item.hash && Clipboard.setString(item.hash)}
        accessibilityRole={link ? 'link' : 'text'}
        accessibilityLabel={[item.title, detail, short].filter(Boolean).join(' · ')}>
        <View style={styles.icon}>
          {item.kind === 'pending' ? (
            <ActivityIndicator size="small" color={c.subtext} />
          ) : (
            <Svg width={18} height={18} viewBox="0 0 24 24">
              {item.kind === 'success' ? (
                <Path d="M20 6L9 17l-5-5" stroke={c.success} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <Path d="M18 6L6 18M6 6l12 12" stroke={c.danger} strokeWidth={2.4} fill="none" strokeLinecap="round" />
              )}
            </Svg>
          )}
        </View>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={[styles.detail, {color: tint}]} numberOfLines={2}>
            {detail}
            {/* The hash in the accent colour, which is how everything else in the app says "this
                opens something". It replaced a "View ↗" at the end of the row: the arrow was a
                second control for the same destination the whole card already goes to, and it was
                the hash people were reaching for anyway. */}
            {!item.detail && short ? <Text style={styles.hash}> {short}</Text> : null}
          </Text>
        </View>
      </Pressable>
      {/* In the corner rather than in the row: it is chrome, not one of the things the toast says,
          and out of the row it cannot be mistaken for the arrow that opens the transaction. */}
      <Pressable
        style={styles.close}
        hitSlop={10}
        onPress={() => dismiss(item.id)}
        accessibilityRole="button"
        accessibilityLabel={t('vault.close')}>
        <Svg width={13} height={13} viewBox="0 0 24 24">
          <Path d="M18 6L6 18M6 6l12 12" stroke={c.subtext} strokeWidth={2.6} fill="none" strokeLinecap="round" />
        </Svg>
      </Pressable>
    </Animated.View>
  );
}

/**
 * Mounted once at the app root, above every screen, under the header.
 *
 * At the TOP, which it was not. Every write in this app starts from a control at the bottom of the
 * screen — a Confirm button, the Buy/Sell bar — so a toast anchored there appeared directly on top
 * of the thing the user had just pressed, and on the Trade page it covered the bar outright. It
 * also now stands where the Confirming badge used to, which is where anyone who has used the app
 * already looks to find out whether something went through.
 *
 * The newest sits highest, nearest the header: it is the one being read, and the older one slides
 * down and back rather than being covered.
 */
export function ToastHost() {
  const items = useToasts((s) => s.items);
  const insets = useSafeAreaInsets();
  const styles = useStyles(makeStyles);
  if (items.length === 0) return null;
  return (
    // The status bar plus a nav bar's height. Taken as a constant rather than from
    // `useHeaderHeight`, which is only available inside a navigator — and this hangs above all of
    // them, including the screens that have no header at all.
    <View pointerEvents="box-none" style={[styles.host, {paddingTop: insets.top + 50}]}>
      {[...items].reverse().map((it, i) => (
        <Row key={it.id} item={it} index={i} />
      ))}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    /**
     * Inset further on the LEFT than the right, so the card starts clear of the back button.
     *
     * The host hangs under the header, and on a pushed screen the header's left corner holds a
     * chevron the toast was laying a full-width card straight across. Narrower and shifted right,
     * the button stays reachable and the toast still reads as belonging to the screen rather than
     * floating in the middle of it.
     */
    host: {position: 'absolute', left: 0, right: 0, top: 0, paddingLeft: 56, paddingRight: 16, gap: 8},
    toast: {
      // Opaque. Tried at 92% and the page showing through a card this size read as a rendering
      // fault rather than as depth — with no native blur available there is nothing to separate
      // "translucent" from "not finished drawing".
      backgroundColor: c.elevated,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 6},
      shadowOpacity: 0.22,
      shadowRadius: 16,
      elevation: 8,
    },
    body: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14},
    icon: {width: 20, alignItems: 'center'},
    text: {flex: 1},
    hash: {color: c.accent, fontWeight: '600'},
    // Tucked into the corner's radius. `position: absolute` so it does not take a column from
    // the row and shorten the title.
    close: {position: 'absolute', top: 5, right: 6, padding: 3},
    /**
     * Only the TITLE keeps clear of the ✕, not the whole card.
     *
     * The close control is absolutely positioned in the top corner, so it takes no column of its
     * own — the row has to leave the space by hand. Reserving it on the body cost the status line
     * the same 12 points, and that line carries the hash, which is the thing worth the width. The
     * ✕ sits beside the title and well above the line below it, so only the title has to yield.
     */
    title: {color: c.text, fontSize: 15, fontWeight: '600', paddingRight: 14},
    detail: {fontSize: 12, marginTop: 1},
  });

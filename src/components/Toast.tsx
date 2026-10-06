import React, {useEffect, useRef} from 'react';
import {ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View} from 'react-native';
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
};

type State = {
  items: Toast[];
  show: (t: Omit<Toast, 'id'>) => number;
  update: (id: number, patch: Partial<Omit<Toast, 'id'>>) => void;
  dismiss: (id: number) => void;
};

let nextId = 1;

/** The toast queue. Two at most are on screen; the newest sits lowest. */
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
 * A submitted transaction.
 *
 * Nothing is shown while it is in flight: the header's Confirming badge counts it, which is where a
 * user looks for "did that go through", and a toast on every action was noise on top of it. A
 * FAILURE still speaks up, because a signature the user cancelled or a relay that refused leaves no
 * other trace — the badge never moves and the action would otherwise look like nothing happened.
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
     * posted to the order book, so there is no broadcast to announce and no hash to wait for. The
     * header would otherwise have said "Broadcasting…" over a signature, and gone on saying it,
     * since a path with no hash never reaches `success`.
     */
    broadcast?: boolean;
  },
) {
  /**
   * Opening this is what puts the spinner in the header.
   *
   * It belongs here and not at each call site because every write in the app already starts with
   * this line — so the one place that knows a write has begun is the one place that announces it,
   * and a new action gets the indicator without being asked to.
   */
  const submitId = opts?.broadcast === false ? null : usePending.getState().beginSubmit(network);
  const close = () => {
    if (submitId != null) usePending.getState().endSubmit(submitId);
  };
  return {
    success: (hash?: string) => {
      // The hash is recorded BEFORE the spinner is closed, so the badge is already counting when it
      // goes: the two swap over on one frame instead of leaving an empty corner between them.
      if (hash) trackTx(hash, network, title);
      close();
    },
    error: (detail?: string) => {
      close();
      useToasts.getState().show({kind: 'error', title, detail, network});
    },
    /**
     * Nothing was submitted after all — a precondition the handler only discovers once it is under
     * way. No toast, no row; just take the spinner down, which is the one thing a bare `return`
     * from such a path would otherwise leave standing.
     */
    done: close,
  };
}

/** A toast for something that finished without a transaction (a local change, a failed precondition). */
export function showToast(kind: ToastKind, title: string, detail?: string) {
  useToasts.getState().show({kind, title, detail});
}

const AUTO_MS: Record<ToastKind, number> = {pending: 0, success: 4000, error: 7000};

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
    const ms = AUTO_MS[item.kind];
    if (!ms) return;
    const timer = setTimeout(() => dismiss(item.id), ms);
    return () => clearTimeout(timer);
  }, [item.kind, item.id, dismiss]);

  const explorer = item.network ? EXPLORER_TX[item.network] : null;
  const detail = item.detail ?? t(item.kind === 'pending' ? 'vault.submitting' : item.kind === 'success' ? 'vault.confirmed' : 'vault.failed');
  const tint = item.kind === 'success' ? c.success : item.kind === 'error' ? c.danger : c.subtext;

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          opacity: enter,
          transform: [{translateY: enter.interpolate({inputRange: [0, 1], outputRange: [16, 0]})}, {scale: 1 - index * 0.02}],
        },
      ]}>
      <Pressable
        style={styles.body}
        onPress={() => dismiss(item.id)}
        onLongPress={() => item.hash && Clipboard.setString(item.hash)}
        accessibilityRole="button"
        accessibilityLabel={`${item.title} · ${detail}`}>
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
          </Text>
        </View>
        {item.hash && explorer ? (
          <Pressable hitSlop={8} onPress={() => openLink(explorer + item.hash, 'Etherscan')}>
            <Text style={styles.view}>{t('vault.view')} ↗</Text>
          </Pressable>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

/** Mounted once at the app root, above every screen. */
export function ToastHost() {
  const items = useToasts((s) => s.items);
  const insets = useSafeAreaInsets();
  const styles = useStyles(makeStyles);
  if (items.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={[styles.host, {paddingBottom: insets.bottom + 64}]}>
      {items.map((it, i) => (
        <Row key={it.id} item={it} index={items.length - 1 - i} />
      ))}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    host: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, gap: 8},
    toast: {
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
    title: {color: c.text, fontSize: 15, fontWeight: '600'},
    detail: {fontSize: 12, marginTop: 1},
    view: {color: c.accent, fontSize: 13, fontWeight: '700'},
  });

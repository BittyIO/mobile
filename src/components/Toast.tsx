import React, {useEffect, useRef} from 'react';
import {ActivityIndicator, Animated, Easing, Linking, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {Path} from 'react-native-svg';
import Clipboard from '@react-native-clipboard/clipboard';
import {create} from 'zustand';
import {EXPLORER_TX, type Network} from '@/core/chain';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

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
 * A transaction's toast: opens as "Submitting…" and is flipped to Confirmed (with a View link to the
 * explorer) or Failed by the caller.
 *
 *   const tx = showTx('Deposit 100 USDC', network);
 *   try { tx.success(await deposit(...)); } catch (e) { tx.error(String(e)); }
 */
export function showTx(title: string, network: Network) {
  const {show, update} = useToasts.getState();
  const id = show({kind: 'pending', title, network});
  return {
    id,
    success: (hash?: string) => update(id, {kind: 'success', hash}),
    error: (detail?: string) => update(id, {kind: 'error', detail}),
    dismiss: () => useToasts.getState().dismiss(id),
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
          <Pressable hitSlop={8} onPress={() => Linking.openURL(explorer + item.hash)}>
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

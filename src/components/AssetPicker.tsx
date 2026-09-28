import React from 'react';
import {Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSlideUp} from '@/components/useSlideUp';
import Svg, {Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {displaySymbol} from '@/core/format';
import {useColors, useStyles, type Colors} from '@/theme';

export type PickerAsset = {symbol: string; name?: string; company?: string};
export type PickerItem = {key: string; label: string; sub?: string; icon?: React.ReactNode};

/**
 * A bottom sheet listing assets with their icons, replacing the plain-text iOS action sheet. Tapping
 * a row selects it and closes; the backdrop or the ✕ dismisses. `selected` gets a check mark.
 */
export function AssetPicker({
  visible,
  title,
  assets,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  assets: PickerAsset[];
  selected?: string;
  onSelect: (symbol: string) => void;
  onClose: () => void;
}) {
  return (
    <PickerSheet
      visible={visible}
      title={title}
      items={assets.map((a) => ({key: a.symbol, label: displaySymbol(a.symbol), sub: a.name ?? a.company, icon: <TokenIcon symbol={a.symbol} size={30} />}))}
      selected={selected}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}

/** The sheet itself: any list of icon + label rows with one checked. The network switcher shares it. */
export function PickerSheet({
  visible,
  title,
  items,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  items: PickerItem[];
  selected?: string;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const slide = useSlideUp(visible);
  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Animated.View style={[styles.slide, slide]}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.head}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} style={styles.listWrap} bounces={false}>
            <View style={styles.list}>
              {items.map((it, i) => {
                const on = it.key === selected;
                return (
                  <Pressable
                    key={it.key}
                    onPress={() => {
                      onSelect(it.key);
                      onClose();
                    }}
                    style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, i === items.length - 1 && styles.rowLast, pressed && styles.rowPressed]}>
                    {it.icon ?? null}
                    <View style={styles.rowText}>
                      <Text style={styles.sym}>{it.label}</Text>
                      {it.sub ? <Text style={styles.name}>{it.sub}</Text> : null}
                    </View>
                    {on ? (
                      <Svg width={18} height={18} viewBox="0 0 24 24">
                        <Path d="M20 6L9 17l-5-5" stroke={c.accent} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </Svg>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    backdrop: {flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end'},
    slide: {maxHeight: '70%'},
    sheet: {backgroundColor: c.elevated, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 34, gap: 12, flexShrink: 1},
    head: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
    title: {color: c.text, fontSize: 18, fontWeight: '700'},
    close: {color: c.subtext, fontSize: 18},
    listWrap: {flexGrow: 0, flexShrink: 1},
    list: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    rowFirst: {borderTopWidth: 0, paddingTop: 16},
    rowLast: {paddingBottom: 16},
    rowPressed: {opacity: 0.6},
    rowText: {flex: 1},
    sym: {color: c.text, fontSize: 16, fontWeight: '600'},
    name: {color: c.subtext, fontSize: 12, marginTop: 1},
  });

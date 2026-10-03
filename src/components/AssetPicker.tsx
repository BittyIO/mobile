import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Sheet} from '@/components/Sheet';
import Svg, {Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {displaySymbol} from '@/core/format';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

export type PickerAsset = {symbol: string; name?: string; company?: string};
export type PickerItem = {
  key: string;
  label: string;
  sub?: string;
  icon?: React.ReactNode;
  /** A figure for the right-hand end of the row — what the vault holds of it, where that is known. */
  value?: string;
};

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
  const {company} = useT();
  return (
    <PickerSheet
      visible={visible}
      title={title}
      items={assets.map((a) => ({key: a.symbol, label: displaySymbol(a.symbol), sub: a.name ?? company(a.symbol, a.company), icon: <TokenIcon symbol={a.symbol} size={30} />}))}
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
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
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
                {it.value ? <Text style={styles.val}>{it.value}</Text> : null}
                {on ? (
                  <Svg width={18} height={18} viewBox="0 0 24 24">
                    <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </Svg>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </Sheet>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    // The sheet is a fixed height now, so the list takes whatever is left under the title.
    listWrap: {flex: 1},
    list: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    rowFirst: {borderTopWidth: 0, paddingTop: 16},
    rowLast: {paddingBottom: 16},
    rowPressed: {opacity: 0.6},
    rowText: {flex: 1},
    sym: {color: c.text, fontSize: 16, fontWeight: '600'},
    name: {color: c.subtext, fontSize: 12, marginTop: 1},
    // Tabular, so a column of balances lines up on the decimal point.
    val: {color: c.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums']},
  });

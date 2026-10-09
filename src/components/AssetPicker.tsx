import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Sheet} from '@/components/Sheet';
import Svg, {Path} from 'react-native-svg';
import {TokenIcon} from '@/components/TokenIcon';
import {displaySymbol} from '@/core/format';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

export type PickerAsset = {symbol: string; name?: string; tokenName?: string};
export type PickerItem = {
  key: string;
  label: string;
  sub?: string;
  icon?: React.ReactNode;
  /** A figure for the right-hand end of the row — what the vault holds of it, where that is known. */
  value?: string;
  /**
   * A row that is there to be READ, not chosen.
   *
   * Some lists have to account for a balance the user cannot spend here — the float held back for
   * network fees, say. Leaving it out made the amounts in the sheet disagree with the one the form
   * would accept; making it selectable offered a source that funds nothing.
   */
  disabled?: boolean;
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
      items={assets.map((a) => ({key: a.symbol, label: displaySymbol(a.symbol), sub: a.name ?? company(a.symbol, a.tokenName), icon: <TokenIcon symbol={a.symbol} size={30} />}))}
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
  const styles = useStyles(makeStyles);
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <ScrollView showsVerticalScrollIndicator={false} style={styles.listWrap} bounces={false}>
        <PickerList
          items={items}
          selected={selected}
          onSelect={(key) => {
            onSelect(key);
            onClose();
          }}
        />
      </ScrollView>
    </Sheet>
  );
}

/**
 * The rows on their own, without a sheet around them.
 *
 * A sheet that asks ONE question is a PickerSheet and closes on the answer. A sheet that asks two
 * — a filter, say — is two of these stacked under their own headings, staying open until the user
 * says they are done. Both draw the same card, the same 56pt rows and the same accent tick,
 * because the second kind was otherwise going to be a second copy of them.
 */
export function PickerList({
  items,
  selected,
  onSelect,
}: {
  items: PickerItem[];
  selected?: string;
  onSelect: (key: string) => void;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.list}>
      {items.map((it, i) => {
        const on = it.key === selected && !it.disabled;
        return (
          <Pressable
            key={it.key}
            disabled={it.disabled}
            onPress={() => onSelect(it.key)}
            style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, i === items.length - 1 && styles.rowLast, pressed && styles.rowPressed]}>
            {/* Dimmed as a whole, icon included: it is the one row here that is not an answer. */}
            <View style={it.disabled ? styles.inert : undefined}>{it.icon ?? null}</View>
            <View style={styles.rowText}>
              <Text style={[styles.sym, it.disabled && styles.inertText]}>{it.label}</Text>
              {it.sub ? <Text style={styles.name}>{it.sub}</Text> : null}
            </View>
            {it.value ? <Text style={[styles.val, it.disabled && styles.inertText]}>{it.value}</Text> : null}
            {on ? (
              <Svg width={18} height={18} viewBox="0 0 24 24">
                <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </Svg>
            ) : null}
          </Pressable>
        );
      })}
    </View>
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
    inert: {opacity: 0.45},
    inertText: {color: c.subtext},
    rowText: {flex: 1},
    sym: {color: c.text, fontSize: 16, fontWeight: '600'},
    name: {color: c.subtext, fontSize: 12, marginTop: 1},
    // Tabular, so a column of balances lines up on the decimal point.
    val: {color: c.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums']},
  });

import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Svg, {Circle, Path} from 'react-native-svg';
import type {RootStackParamList} from '@/App';
import {Sheet} from '@/components/Sheet';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {useNetwork, NETWORKS, networkLabel} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/** Three dots, the system's own mark for "more of this screen's actions". */
function MoreIcon({color}: {color: string}) {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24">
      <Circle cx={5} cy={12} r={1.9} fill={color} />
      <Circle cx={12} cy={12} r={1.9} fill={color} />
      <Circle cx={19} cy={12} r={1.9} fill={color} />
    </Svg>
  );
}

/**
 * One drawing language for the three rows: a 22pt stroke glyph in the muted grey, no tinted
 * tile. The settings rows wear tiles because they are a long list that has to be scanned; three
 * rows do not, and a tile here would make the menu louder than the page it sits over.
 */
const glyph = (color: string) => ({
  stroke: color,
  strokeWidth: 1.9,
  fill: 'none' as const,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/** What the asset IS — the ⓘ that used to sit beside the pair. */
function InfoIcon({color}: {color: string}) {
  const c = glyph(color);
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9.5} {...c} />
      <Path d="M12 11v5.5" {...c} strokeWidth={2} />
      <Circle cx={12} cy={7.9} r={1.15} fill={color} stroke="none" />
    </Svg>
  );
}

/** Where it all happens — the linked nodes the Settings network row uses. */
function NodesIcon({color}: {color: string}) {
  const c = glyph(color);
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Circle cx={12} cy={5} r={2.2} {...c} />
      <Circle cx={5} cy={18} r={2.2} {...c} />
      <Circle cx={19} cy={18} r={2.2} {...c} />
      <Path d="M12 7.2v5M12 12.2l-5.6 4M12 12.2l5.6 4" {...c} />
    </Svg>
  );
}

/** The same accent tick the asset picker marks its current row with. */
function Tick({color}: {color: string}) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path d="M20 6 9 17l-5-5" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/**
 * The Trade screen's header-right: one ⋯ that holds everything the page can do to itself.
 *
 * Three controls used to be scattered across the screen — the chain's logo in the bar, an ⓘ
 * beside the pair, a clock in the orders row — none of them labelled, each in a different corner,
 * and together they made the top of the page read as four competing marks. The menu names them,
 * in the order someone reaches for them: what this asset IS, what it has DONE, and the chain it
 * all happens on.
 *
 * Three rows drawn exactly alike. The chains sit under the third one, always open: four rows is
 * not a list worth hiding behind a disclosure, and the tap that would reveal them is the tap
 * that should be choosing one. The current chain is stated once, by the tick — a value on the
 * right as well would be the same answer twice.
 *
 * Its own list rather than a {PickerSheet}: a picker is a flat list of equals and cannot nest.
 * Opening a SECOND sheet is not the alternative — the sheet is a Modal, and iOS drops a present
 * that arrives while another is still dismissing, which is why the chain picker did nothing at
 * all when it lived behind this row.
 *
 * Module scope, and rendered as `<TradeMenu />` rather than built inline inside `setOptions`: the
 * element's TYPE has to be stable across renders or react-navigation remounts the header's right
 * side on every options update, which would close the sheet the moment anything on the page
 * changed under it.
 *
 * `symbol` is null on the market directory, where there is no one asset to show details for; the
 * row is dropped rather than disabled, because a menu with one dead row reads as broken.
 *
 * `stack` says the header is the NATIVE one, which anchors a custom bar button by its bottom edge
 * rather than centring it — see {styles}. The tab header is drawn in JS and does not.
 */
export function TradeMenu({symbol, stack}: {symbol: string | null; stack?: boolean}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const setNetwork = useNetwork((s) => s.setNetwork);
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);
  const go = (run: () => void) => {
    close();
    run();
  };

  /** The third row has no action of its own: the chains under it are the action. */
  const rows: {key: string; label: string; icon: React.ReactNode; onPress?: () => void}[] = [
    ...(symbol
      ? [
          {
            key: 'detail',
            label: t('mobile.trade.asset_details'),
            icon: <InfoIcon color={c.subtext} />,
            onPress: () => go(() => nav.navigate('AssetDetail', {symbol})),
          },
        ]
      : []),
    /**
     * The chains, and nothing else beside them.
     *
     * Two rows have left this sheet. Order history went because the panel's own Finished tab is the
     * same record for the pair in front. The window that replaced it went too, and for the better
     * reason: it belongs ON the tab it governs — a setting two taps away in a menu, for a list in
     * plain view, is a setting nobody finds. Tapping Finished again opens it. See {windowPicker}.
     */
    {key: 'network', label: t('mobile.settings.choose_network'), icon: <NodesIcon color={c.subtext} />},
  ];

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={stack ? styles.btnStack : styles.btn}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.trade.more')}>
        <MoreIcon color={c.text} />
      </Pressable>

      <Sheet visible={open} title={t('mobile.app.trade')} onClose={close}>
        <ScrollView showsVerticalScrollIndicator={false} style={styles.scroll} bounces={false}>
          <View style={styles.card}>
            {rows.map((r, i) => (
              <React.Fragment key={r.key}>
                {r.onPress ? (
                  <Pressable
                    style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, pressed && styles.pressed]}
                    onPress={r.onPress}>
                    {r.icon}
                    <Text style={styles.label}>{r.label}</Text>
                  </Pressable>
                ) : (
                  // Not pressable: the choices under it ARE this row. Same icon, same label, same
                  // metrics as an action row, so the set still reads as one list.
                  <View style={[styles.row, i === 0 && styles.rowFirst]}>
                    {r.icon}
                    <Text style={styles.label}>{r.label}</Text>
                  </View>
                )}

                {/* A header's own choices, indented under it. Inside the same map so a row and the
                    things it governs cannot drift apart in the order they are listed. */}
                {r.key === 'network'
                  ? NETWORKS.map((n, j) => (
                      <Pressable
                        key={n}
                        style={({pressed}) => [styles.row, styles.chainRow, j === NETWORKS.length - 1 && styles.rowLast, pressed && styles.pressed]}
                        onPress={() => go(() => setNetwork(n as Network))}>
                        <NetworkIcon network={n} size={24} />
                        <Text style={styles.label}>{networkLabel(n, t)}</Text>
                        {n === network ? <Tick color={c.accent} /> : null}
                      </Pressable>
                    ))
                  : null}
              </React.Fragment>
            ))}
          </View>
        </ScrollView>
      </Sheet>
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    // Tab header: the same 16pt inset the network switcher held, so the bar's right edge does not move.
    btn: {marginRight: 16},
    /**
     * Pushed header: sized to the bar's full 44, not to the glyph.
     *
     * react-native-screens hands `headerRight` to a native bar-button custom view and anchors it
     * by its BOTTOM edge, so a 21pt mark in a 21pt box hangs low in a 44pt bar — the same thing
     * the watch list's bin hit, and the 6pt is that screen's measured correction.
     */
    btnStack: {width: 44, height: 44, paddingBottom: 6, alignItems: 'center', justifyContent: 'center'},

    scroll: {flexGrow: 0},
    // The same card and row metrics the asset picker uses, so a sheet is a sheet.
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 56,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    rowFirst: {borderTopWidth: 0, paddingTop: 16},
    rowLast: {paddingBottom: 16},
    pressed: {opacity: 0.6},
    label: {color: c.text, fontSize: 16, fontWeight: '600', flex: 1},
    // Indented to the parent row's label, so the chains read as belonging to it rather than as
    // three more things the menu does.
    chainRow: {paddingLeft: 34, minHeight: 50},
  });

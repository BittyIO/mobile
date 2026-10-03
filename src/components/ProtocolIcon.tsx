import React, {useEffect, useRef, useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View, type ImageSourcePropType} from 'react-native';
import {useStyles, type Colors} from '@/theme';

/**
 * Protocol logos, the same files the web serves from /assets. Keyed by the adapter's display name.
 *
 * Bundled, so this map can only describe the protocols that existed when the client was built —
 * and an adapter is registered on the guard without a release. `uri` is the way out: pass the URL
 * the catalog holds and it renders straight from the server, exactly as a token icon does. These
 * stay as the offline fallback, behind which an unknown protocol still has the lettered disc.
 *
 * One file each, no light/dark pair: each is drawn to hold on both cards, and a mark arriving from
 * the server gets no per-theme treatment either, so the catalog should serve ones that do.
 */
const LOGOS: Record<string, ImageSourcePropType> = {
  Sky: require('@/assets/protocols/sky.png'),
  Lido: require('@/assets/protocols/lido.png'),
  'Aave V3': require('@/assets/protocols/aave.png'),
  'Uniswap V3': require('@/assets/protocols/uniswap.png'),
  'Uniswap V4': require('@/assets/protocols/uniswap.png'),
  'CoW Swap': require('@/assets/protocols/cow.png'),
};

export function ProtocolIcon({name, size = 18, uri}: {name: string; size?: number; uri?: string}) {
  const styles = useStyles(makeStyles);
  // The catalog's own URL wins when there is one; the bundled logo is the fallback, then a letter.
  if (uri) return <Image source={{uri}} style={{width: size, height: size, borderRadius: size / 2}} />;
  const src = LOGOS[name];
  if (!src) {
    return (
      <View style={[styles.fallback, {width: size, height: size, borderRadius: size / 2}]}>
        <Text style={[styles.fallbackText, {fontSize: size * 0.55}]}>{name.slice(0, 1)}</Text>
      </View>
    );
  }
  return <Image source={src} style={{width: size, height: size, borderRadius: size / 2}} />;
}

/**
 * A row of the protocols behind a section, for the right side of a section header: each logo followed
 * by its name, in the header's muted type.
 */
export function ProtocolBadges({names, size = 18, uris}: {names: string[]; size?: number; uris?: Record<string, string>}) {
  const styles = useStyles(makeStyles);
  if (names.length === 0) return null;
  return (
    <View style={styles.badges}>
      {names.map((n) => (
        <View key={n} style={styles.badge}>
          <ProtocolIcon name={n} size={size} uri={uris?.[n]} />
          <Text style={styles.badgeText}>{n}</Text>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    fallback: {backgroundColor: c.neutralSoft, alignItems: 'center', justifyContent: 'center'},
    fallbackText: {color: c.subtext, fontWeight: '700'},
    badges: {flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1},
    // The chip is as tall closed as open (icon + 2pt either side), so opening it never moves the row.
    chip: {flexDirection: 'row', alignItems: 'center', borderRadius: 999, paddingHorizontal: 2, overflow: 'hidden'},
    chipOpen: {backgroundColor: c.neutralSoft},
    slot: {paddingLeft: 5, paddingRight: 6},
    chipText: {color: c.subtext, fontSize: 13, fontWeight: '600'},
    badge: {flexDirection: 'row', alignItems: 'center', gap: 6},
    badgeText: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  });

/** The name a chip shows for an adapter; the catalog name otherwise. */
const DISPLAY_NAME: Record<string, string> = {
  Lido: 'Lido V2',
};
export const protocolDisplayName = (name: string) => DISPLAY_NAME[name] ?? name;

// One chip open at a time: opening one tells the others to close.
const openListeners = new Set<(owner: symbol) => void>();
const OPEN_MS = 3000;

/**
 * A protocol logo that reveals its name in place when tapped: the logo stays put and the name slides
 * in beside it as a caption, in the muted header type. It closes on a second tap, when another chip
 * opens, or on its own after a few seconds, so a row never stays cluttered.
 */
export function ProtocolChip({name, size = 14, uri}: {name: string; size?: number; uri?: string}) {
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const me = useRef(Symbol(name)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The name simply appears and disappears; the chip's height is fixed so the row never moves.
  const close = () => setOpen(false);
  useEffect(() => {
    const onOther = (owner: symbol) => {
      if (owner !== me) close();
    };
    openListeners.add(onOther);
    return () => {
      openListeners.delete(onOther);
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const toggle = () => {
    if (timer.current) clearTimeout(timer.current);
    if (open) {
      close();
      return;
    }
    openListeners.forEach((l) => l(me));
    setOpen(true);
    timer.current = setTimeout(close, OPEN_MS);
  };

  const label = protocolDisplayName(name);
  return (
    <Pressable onPress={toggle} hitSlop={8} accessibilityRole="button" accessibilityLabel={label} style={[styles.chip, {height: size + 4}, open && styles.chipOpen]}>
      <ProtocolIcon name={name} size={size} uri={uri} />
      {open ? (
        <View style={styles.slot}>
          <Text style={styles.chipText} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

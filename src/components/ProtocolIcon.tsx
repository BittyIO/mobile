import React, {useEffect, useRef, useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View, type ImageSourcePropType} from 'react-native';
import {useStyles, type Colors} from '@/theme';
// Re-exported so the existing callers keep their import; the rule itself lives with the names.
import {protocolDisplayName} from '@/core/protocols';

export {protocolDisplayName};

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
  // "Uniswap Universal" is the Universal Router adapter — the market-TRADE half of the AMM split,
  // and the single combined adapter on Robinhood Chain. "Uniswap V3" is the market-MAKER half,
  // which is concentrated liquidity and v3 only, and the pre-split combined adapter on the chains
  // where that one really was v3. One mark serves all of them.
  //
  // The flat "Uniswap" stays: it is what the service catalog called the Universal adapter until
  // the name was spelled out, and a deployed server older than this build still serves it.
  Uniswap: require('@/assets/protocols/uniswap.png'),
  'Uniswap Universal': require('@/assets/protocols/uniswap.png'),
  'Uniswap V3': require('@/assets/protocols/uniswap.png'),
  'Uniswap V4': require('@/assets/protocols/uniswap.png'),
  'CoW Swap': require('@/assets/protocols/cow.png'),
};

/**
 * The bundled mark for a name, tolerating a version suffix.
 *
 * The catalog names adapters by release — "CoW Swap V1", "Sky V1" — and the bundled map is keyed
 * by brand, so an exact lookup missed and the chip fell back to a lettered "C" disc. Tried whole
 * first, because "Uniswap V3" and "Uniswap V4" are deliberately separate keys from "Uniswap";
 * only when that misses is a trailing " V<n>" dropped.
 *
 * Which is why "Uniswap Universal" has a key of its own: the suffix is a WORD, not a version, so
 * nothing here would have stripped it and the market-trade chip would have gone back to a disc
 * reading "U" the moment its remote mark failed to load.
 */
function bundledLogo(name: string): ImageSourcePropType | undefined {
  return LOGOS[name] ?? LOGOS[name.replace(/\s+V\d+$/i, '')];
}

export function ProtocolIcon({name, size = 18, uri}: {name: string; size?: number; uri?: string}) {
  const styles = useStyles(makeStyles);
  const dim = {width: size, height: size, borderRadius: size / 2};
  /**
   * A remote mark that does not load falls back to the bundled one.
   *
   * The uri branch used to return early, so anything that stopped the image arriving — an
   * offline device, a cold cache on a slow link, a path the host does not serve — left a blank
   * the size of the icon and nothing else, with a perfectly good bundled logo sitting unused.
   * `onError` is the only signal RN gives for that, so it is what switches back.
   *
   * A relative path is rejected before it is tried: `iconUri` absolutises the catalog's, and
   * anything else here would load as nothing at all.
   */
  const [remoteFailed, setRemoteFailed] = useState(false);
  const remote = !remoteFailed && uri && /^https?:\/\//.test(uri) ? uri : null;
  if (remote) {
    return <Image source={{uri: remote}} style={dim} onError={() => setRemoteFailed(true)} />;
  }
  const src = bundledLogo(name);
  if (!src) {
    return (
      <View style={[styles.fallback, dim]}>
        <Text style={[styles.fallbackText, {fontSize: size * 0.55}]}>{name.slice(0, 1)}</Text>
      </View>
    );
  }
  return <Image source={src} style={dim} />;
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
          <Text style={styles.badgeText}>{protocolDisplayName(n)}</Text>
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

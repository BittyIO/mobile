import React, {useLayoutEffect, useRef, useState} from 'react';
import {ActivityIndicator, Linking, Pressable, StyleSheet, View} from 'react-native';
import {WebView} from 'react-native-webview';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Svg, {Path} from 'react-native-svg';
import type {RootStackParamList} from '@/App';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * A web page, inside the app.
 *
 * Nearly every link the app offers is something to GLANCE at — a transaction on Etherscan, a
 * token's own site, the terms — and handing those to Safari ends the session: the user comes back
 * to a cold app, the sheet they were in closed, the list they had scrolled back at the top. The
 * page they wanted was five seconds of reading.
 *
 * A pushed screen rather than a modal, so it behaves like every other detour in the app: a back
 * button in the usual corner, a swipe from the left edge, and the screen underneath still there.
 */
export function BrowserScreen() {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const {url, title} = useRoute<RouteProp<RootStackParamList, 'Browser'>>().params;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [loading, setLoading] = useState(true);
  /**
   * The page's own title, once it has one.
   *
   * The caller usually knows what it is sending the user to ("Etherscan"), but not always — a
   * token's website is whatever the catalog had — so the document's title fills in. Held in a ref
   * as well as in state because the header is set from an effect that must not re-run on every
   * navigation event the WebView emits.
   */
  const [heading, setHeading] = useState(title ?? host(url));
  const shown = useRef(heading);
  shown.current = heading;

  useLayoutEffect(() => {
    // A module-scope component, not an inline arrow: `setOptions` compares element TYPES, and a
    // type created inside the render is a different one every time, which remounts the header.
    nav.setOptions({title: heading, headerRight: () => <OpenOutside url={url} />});
  }, [nav, heading, url]);

  return (
    <View style={styles.container}>
      <WebView
        source={{uri: url}}
        style={styles.web}
        // The page's own background shows through before it paints; without this the gap is white
        // on a dark theme, which reads as a flash.
        containerStyle={styles.web}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onNavigationStateChange={(s) => {
          if (s.title && s.title !== shown.current) setHeading(s.title);
        }}
        allowsBackForwardNavigationGestures
        // Links that are not web pages — a wallet deep link, a mail address — are the system's
        // business, and a WebView asked to load one simply fails.
        onShouldStartLoadWithRequest={(r) => {
          if (/^https?:/i.test(r.url)) return true;
          void Linking.openURL(r.url).catch(() => {});
          return false;
        }}
      />
      {loading ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator color={c.accent} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The way out to a real browser: a page that needs a wallet, a download or a login the WebView
 * cannot carry is one tap from where it is meant to happen.
 *
 * The 44pt square with six points of bottom padding is not decoration. `react-native-screens`
 * anchors a native bar button by its BOTTOM edge, so a bare icon hangs below the title's line;
 * the box gives it a tap target and centres the mark inside it, and the padding lifts it back on
 * to the line. Every other header button in the app is built this way.
 */
function OpenOutside({url}: {url: string}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={() => void Linking.openURL(url).catch(() => {})} hitSlop={10} style={styles.action}>
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
        <Path
          d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"
          stroke={c.accent}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </Pressable>
  );
}

/** `etherscan.io` from a URL — a readable stand-in for a title the page has not given yet. */
function host(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, '') : url;
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    web: {flex: 1, backgroundColor: c.bg},
    action: {width: 44, height: 44, paddingBottom: 6, alignItems: 'center', justifyContent: 'center'},
    // Over the page, not in place of it: a reload keeps what is already drawn.
    loading: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
  });

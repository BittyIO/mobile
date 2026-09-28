import React from 'react';
import {Image, StyleSheet, View} from 'react-native';
import Svg, {Circle, Line, Path, Rect} from 'react-native-svg';

export type SettingsIconName =
  | 'language'
  | 'network'
  | 'appearance'
  | 'assets'
  | 'protocols'
  | 'services'
  | 'security'
  | 'recovery'
  | 'lock'
  | 'autoYield'
  | 'delegation'
  | 'gasless'
  | 'dailyLimit'
  | 'perTx'
  | 'payout'
  | 'version'
  | 'allowlist';

// iOS Settings row icons: a white glyph on a small rounded square, one tint per row. Glyphs follow
// the lucide set the web uses (Globe, Coins, Wrench, Shield, Key, Lock, Zap, Users, Fuel, CalendarClock, Receipt), drawn on a
// 24×24 grid.
const TINT: Record<SettingsIconName, string> = {
  language: '#0E85FF',
  network: '#5856D6',
  appearance: '#5E5CE6',
  assets: '#F5A623',
  protocols: '#5AC8FA',
  services: '#8E8E93',
  security: '#34C759',
  recovery: '#FF9500',
  lock: '#FF3B30',
  autoYield: '#34C759',
  delegation: '#0E85FF',
  gasless: '#AF52DE',
  dailyLimit: '#FF9500',
  perTx: '#5856D6',
  payout: '#34C759',
  version: '#0E85FF',
  allowlist: '#30B0C7',
};

export function SettingsIcon({name, size = 29}: {name: SettingsIconName; size?: number}) {
  // The vault's version row wears the app's own logo, like an app's row in iOS Settings.
  if (name === 'version') {
    return <Image source={require('@/assets/logo.png')} style={{width: size, height: size, borderRadius: size * 0.24}} resizeMode="cover" />;
  }
  const c = {stroke: '#fff', strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  const g = size * 0.62;
  return (
    <View style={[styles.box, {width: size, height: size, borderRadius: size * 0.24, backgroundColor: TINT[name]}]}>
      <Svg width={g} height={g} viewBox="0 0 24 24">
        {name === 'language' ? (
          <>
            <Circle cx={12} cy={12} r={9} {...c} />
            <Path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" {...c} />
          </>
        ) : name === 'network' ? (
          <>
            <Circle cx={12} cy={5} r={2.2} {...c} />
            <Circle cx={5} cy={18} r={2.2} {...c} />
            <Circle cx={19} cy={18} r={2.2} {...c} />
            <Path d="M12 7.2v5M12 12.2l-5.6 4M12 12.2l5.6 4" {...c} />
          </>
        ) : name === 'appearance' ? (
          <>
            <Circle cx={12} cy={12} r={9} {...c} />
            <Path d="M12 3a9 9 0 0 1 0 18z" fill="#fff" stroke="none" />
          </>
        ) : name === 'assets' ? (
          <>
            <Circle cx={8} cy={8} r={6} {...c} />
            <Path d="M18.1 8.5a6 6 0 1 1-8.6 8.6M7 6h1v4M16.7 13.1l.7.7-2.8 2.8" {...c} />
          </>
        ) : name === 'protocols' ? (
          <>
            <Path d="M12 3l9 4.5-9 4.5-9-4.5z" {...c} />
            <Path d="M3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" {...c} />
          </>
        ) : name === 'services' ? (
          <Path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" {...c} />
        ) : name === 'security' ? (
          <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...c} />
        ) : name === 'recovery' ? (
          <>
            <Circle cx={7.5} cy={15.5} r={5.5} {...c} />
            <Path d="M21 2l-9.6 9.6M15.5 7.5l3 3M18.5 4.5l3 3" {...c} />
          </>
        ) : name === 'lock' ? (
          <>
            <Rect x={3} y={11} width={18} height={11} rx={2} {...c} />
            <Path d="M7 11V7a5 5 0 0 1 10 0v4" {...c} />
          </>
        ) : name === 'autoYield' ? (
          <Path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" {...c} />
        ) : name === 'dailyLimit' ? (
          <>
            {/* A calendar page: a day's budget. */}
            <Rect x={3} y={5} width={18} height={16} rx={2} {...c} />
            <Path d="M3 10h18M8 3v4M16 3v4" {...c} />
            <Path d="M12 13v3l2 1.2" {...c} />
          </>
        ) : name === 'perTx' ? (
          <>
            {/* A receipt: one transaction's fee. */}
            <Path d="M5 3h14v18l-2.3-1.6L14.4 21l-2.4-1.6L9.6 21l-2.3-1.6L5 21z" {...c} />
            <Path d="M9 8h6M9 12h6M9 16h4" {...c} />
          </>
        ) : name === 'payout' ? (
          <>
            <Rect x={2} y={6} width={20} height={12} rx={2} {...c} />
            <Circle cx={12} cy={12} r={2.5} {...c} />
            <Path d="M6 12h.01M18 12h.01" {...c} />
          </>
        ) : name === 'allowlist' ? (
          <>
            {/* A checklist (lucide ListChecks): items ticked as allowed. */}
            <Path d="M10 6h11M10 12h11M10 18h11" {...c} />
            <Path d="M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17" {...c} />
          </>
        ) : name === 'delegation' ? (
          <>
            <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" {...c} />
            <Circle cx={9} cy={7} r={4} {...c} />
            <Path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" {...c} />
          </>
        ) : (
          <>
            <Line x1={3} y1={22} x2={15} y2={22} {...c} />
            <Line x1={4} y1={9} x2={14} y2={9} {...c} />
            <Path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18" {...c} />
            <Path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5" {...c} />
          </>
        )}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {alignItems: 'center', justifyContent: 'center'},
});

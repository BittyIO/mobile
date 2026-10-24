import React from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {Circle, Line, Path, Rect} from 'react-native-svg';

export type SettingsIconName =
  | 'vault'
  | 'language'
  | 'currency'
  | 'network'
  | 'appearance'
  | 'assets'
  | 'protocols'
  | 'services'
  | 'security'
  | 'recovery'
  | 'lock'
  | 'lockOpen'
  | 'lockTemp'
  | 'lockForever'
  | 'eth'
  | 'timelock'
  | 'autoYield'
  | 'delegation'
  | 'ownership'
  | 'stableCoinAsGas'
  | 'dailyLimit'
  | 'perTx'
  | 'settings'
  | 'allowlist'
  | 'whitelist'
  | 'follow'
  | 'terms'
  | 'privacy';

// iOS Settings row icons: a white glyph on a small rounded square, one tint per row. Glyphs follow
// the lucide set the web uses (Globe, Coins, Wrench, Shield, Key, Lock, Zap, Users, Fuel, CalendarClock, Receipt), drawn on a
// 24×24 grid.
const TINT: Record<SettingsIconName, string> = {
  // The app's own accent: this is the row that decides what every row below it means.
  vault: '#0E85FF',
  language: '#0E85FF',
  currency: '#34C759',
  network: '#5856D6',
  appearance: '#5E5CE6',
  assets: '#F5A623',
  protocols: '#5AC8FA',
  services: '#8E8E93',
  security: '#34C759',
  recovery: '#FF9500',
  lock: '#FF3B30',
  // The three lock states, in the colours the status chip uses for them: open and normal, locked
  // for now, locked for good.
  lockOpen: '#34C759',
  lockTemp: '#FF9500',
  lockForever: '#FF3B30',
  eth: '#627EEA',
  timelock: '#5856D6',
  autoYield: '#34C759',
  delegation: '#0E85FF',
  // Handing the vault to another key: its own colour, so it never reads as the asset manager.
  ownership: '#FF2D55',
  stableCoinAsGas: '#AF52DE',
  dailyLimit: '#FF9500',
  perTx: '#5856D6',
  settings: '#8E8E93',
  allowlist: '#30B0C7',
  whitelist: '#34C759',
  follow: '#0E85FF',
  terms: '#8E8E93',
  privacy: '#5856D6',
};

export function SettingsIcon({name, size = 29}: {name: SettingsIconName; size?: number}) {
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
        ) : name === 'currency' ? (
          <>
            {/* lucide CircleDollarSign — a denomination in a coin. */}
            <Circle cx={12} cy={12} r={9} {...c} />
            <Path d="M15.4 8.7h-4.5a1.9 1.9 0 1 0 0 3.8h2.2a1.9 1.9 0 1 1 0 3.8H8.6M12 6.5v11" {...c} />
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
        ) : name === 'lockOpen' ? (
          // lucide LockOpen: the shackle lifted off one side.
          <>
            <Rect x={3} y={11} width={18} height={11} rx={2} {...c} />
            <Path d="M7 11V7a5 5 0 0 1 9.9-1" {...c} />
          </>
        ) : name === 'lockTemp' ? (
          // A closed lock: locked, for now — this key can open it again.
          <>
            <Rect x={3} y={11} width={18} height={11} rx={2} {...c} />
            <Path d="M7 11V7a5 5 0 0 1 10 0v4" {...c} />
          </>
        ) : name === 'lockForever' ? (
          // lucide Infinity: no lock at all, because there is no key that opens it — forever.
          <Path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z" {...c} />
        ) : name === 'whitelist' ? (
          // lucide BookUser: the address book.
          <>
            <Path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" {...c} />
            <Circle cx={12} cy={8} r={2} {...c} />
            <Path d="M15 13a3 3 0 1 0-6 0" {...c} />
          </>
        ) : name === 'ownership' ? (
          // lucide ArrowRightLeft: one owner out, another in.
          <Path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" {...c} />
        ) : name === 'eth' ? (
          // Ether's diamond: the native coin the Legacy ETH row wraps.
          <>
            <Path d="M12 2L5 12.5 12 16.5 19 12.5z" {...c} />
            <Path d="M5 14l7 8 7-8-7 4z" {...c} />
          </>
        ) : name === 'timelock' ? (
          // A clock: the vault's change delay, the waiting period a loosening has to sit out.
          <>
            <Circle cx={12} cy={12} r={9} {...c} />
            <Path d="M12 7v5l3.5 2" {...c} />
          </>
        ) : name === 'autoYield' ? (
          <Path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" {...c} />
        ) : name === 'follow' ? (
          <>
            {/* X's own mark, drawn rather than fetched.
            
                FILLED, where every other glyph in this file is a 2pt white stroke. It had to be:
                the logo's two diagonals are different weights and its ends are mitred, which no
                uniform stroke produces — two crossing lines at an even thickness is a
                multiplication sign, which is what this row used to show. */}
            <Path
              fill="#fff"
              stroke="none"
              d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
            />
          </>
        ) : name === 'terms' ? (
          <>
            {/* A page with ruled lines. */}
            <Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" {...c} />
            <Path d="M14 3v5h5M9 13h6M9 17h4" {...c} />
          </>
        ) : name === 'privacy' ? (
          <>
            {/* A shield with a keyhole: the same guard as Security, but about what is kept. */}
            <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...c} />
            <Circle cx={12} cy={10.5} r={1.8} {...c} />
            <Path d="M12 12.3v3" {...c} />
          </>
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
        ) : name === 'allowlist' ? (
          <>
            {/* A guard's shield with a tick inside (lucide ShieldCheck). The list it opens is not
                a list of preferences — it is what the guard will let the vault touch at all, so
                the row wears the thing doing the refusing rather than the paperwork. */}
            <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...c} />
            <Path d="M9 12l2 2 4-4" {...c} />
          </>
        ) : name === 'delegation' ? (
          <>
            <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" {...c} />
            <Circle cx={9} cy={7} r={4} {...c} />
            <Path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" {...c} />
          </>
        ) : name === 'settings' ? (
          <>
            {/* lucide Settings — the cog. This row used to wear the app's own logo, the way an
                app's row looks in iOS Settings, which said "Bitty" where the row is about the
                VAULT's contract version and the upgrade behind it. */}
            <Path
              d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
              {...c}
              strokeWidth={1.6}
            />
            <Circle cx={12} cy={12} r={3} {...c} />
          </>
        ) : name === 'vault' ? (
          <>
            {/* A safe: the door, its dial, and the handle beside it. The row used to wear a single
                figure, which said "account" — the thing being chosen is not a person but which
                strongbox every row below it is about. */}
            <Rect x={3} y={3} width={18} height={18} rx={2.5} {...c} />
            <Circle cx={10.5} cy={12} r={3} {...c} />
            <Path d="M10.5 8.2v-.9M10.5 15.8v.9M6.7 12h-.9M14.3 12h.9" {...c} />
            <Path d="M17.2 10.2v3.6" {...c} />
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

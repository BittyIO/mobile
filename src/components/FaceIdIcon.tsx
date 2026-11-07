import React from 'react';
import {Platform} from 'react-native';
import Svg, {Path} from 'react-native-svg';

/** Apple's Face ID mark: corner brackets around eyes, nose and smile. */
export function FaceIdIcon({size = 20, color = '#fff'}: {size?: number; color?: string}) {
  const s = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  if (Platform.OS === 'android') {
    // Android has no Face ID; a fingerprint is the platform's biometric mark (lucide Fingerprint).
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" {...s} />
        <Path d="M14 13.12c0 2.38 0 6.38-1 8.88" {...s} />
        <Path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" {...s} />
        <Path d="M2 12a10 10 0 0 1 18-6" {...s} />
        <Path d="M2 16h.01" {...s} />
        <Path d="M21.8 16c.2-2 .131-5.354 0-6" {...s} />
        <Path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" {...s} />
        <Path d="M8.65 22c.21-.66.45-1.32.57-2" {...s} />
        <Path d="M9 6.8a6 6 0 0 1 9 5.2v2" {...s} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2" {...s} />
      <Path d="M8 9v2M16 9v2M12 9v4.5h-1.3" {...s} />
      <Path d="M8.6 15.5a4.5 4.5 0 0 0 6.8 0" {...s} />
    </Svg>
  );
}

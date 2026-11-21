import React, {useEffect, useRef, useState} from 'react';
import {Pressable} from 'react-native';
import Svg, {Path, Rect} from 'react-native-svg';
import Clipboard from '@react-native-clipboard/clipboard';
import {asShown} from '@/core/format';
import {useT} from '@/i18n';
import {useColors} from '@/theme';

/**
 * A copy icon on its own, for the end of an address that is shown in full elsewhere in a row the
 * row's own tap is for something else (choosing a vault). Tapped, it copies `address` and turns into
 * a check for a moment, as {CopyAddress} does: the button says it, not a toast over the page.
 */
export function CopyButton({address, size = 14}: {address: string; size?: number}) {
  const {t} = useT();
  const c = useColors();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    Clipboard.setString(asShown(address));
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  const stroke = {stroke: copied ? c.success : c.subtext, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Pressable onPress={copy} hitSlop={10} accessibilityRole="button" accessibilityLabel={copied ? t('common.copied') : t('common.copy')}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {copied ? (
          <Path d="M20 6 9 17l-5-5" {...stroke} strokeWidth={2.5} />
        ) : (
          <>
            <Rect x={9} y={9} width={11} height={11} rx={2} {...stroke} />
            <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" {...stroke} />
          </>
        )}
      </Svg>
    </Pressable>
  );
}

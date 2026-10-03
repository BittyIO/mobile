import React, {useState} from 'react';
import {Image, Pressable, StyleSheet} from 'react-native';
import {PickerSheet} from '@/components/AssetPicker';
import {useT} from '@/i18n';
import {useNetwork, NETWORKS, networkLabel} from '@/core/network-store';
import Svg, {Circle, G, Path, Rect} from 'react-native-svg';
import {useIsDark} from '@/theme';
import type {Network} from '@/core/chain';

// Static requires (Metro can't resolve dynamic paths). Icons vendored from the web repo (public/icons).
const ICONS: Record<Exclude<Network, 'base' | 'robinhood'>, number> = {
  mainnet: require('@/assets/networks/ethereum.png'),
  sepolia: require('@/assets/networks/sepolia.png'),
};

const BASE_BLUE = '#0052FF';

// Base's mark is a blue square on a white disc. On the light theme the white disc vanishes into the
// header and the square floats alone, so there the disc goes Base blue and the square white: the same
// shape, inverted, and it reads in both themes.
function BaseIcon({size}: {size: number}) {
  const dark = useIsDark();
  const disc = dark ? '#FFFFFF' : BASE_BLUE;
  const square = dark ? BASE_BLUE : '#FFFFFF';
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256">
      <Circle cx={128} cy={128} r={128} fill={disc} />
      <Rect x={64} y={64} width={128} height={128} rx={10} fill={square} />
    </Svg>
  );
}

// Robinhood's feather on its brand green, the same mark the web switcher uses. Brand colours, so it
// is the same in both themes.
function RobinhoodIcon({size}: {size: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Circle cx={16} cy={16} r={16} fill="#CCFF00" />
      <G transform="translate(8 5.5) scale(0.5)">
        <Path
          d="M0.237711 42H1.14916C1.31483 42 1.48056 41.9157 1.53587 41.7753C8.41284 23.9672 15.8974 15.1474 20.5926 9.86673C20.786 9.64201 20.7031 9.47355 20.4269 9.47355H12.0309C11.727 9.47355 11.4702 9.59707 11.2576 9.86673L5.23667 17.4507C4.3529 18.5742 4.13199 19.6134 4.13199 21.1021V28.8546C2.17104 34.4442 0.92819 38.2362 0.0168015 41.663C-0.038442 41.882 0.0444232 42 0.237711 42ZM30.5353 1.13119C29.2372 -0.273195 23.3821 -0.329391 20.6754 0.738011C20.1121 0.959852 19.5707 1.33622 19.3221 1.5525C16.8364 3.71537 15.1794 5.4288 13.6051 7.11409C13.4117 7.31068 13.4947 7.50727 13.7709 7.50727H23.0783C23.9345 7.50727 24.4316 8.01291 24.4316 8.88359V19.5573C24.4316 19.8382 24.6525 19.9225 24.8183 19.6696L30.4248 12.2261C31.3362 11.0183 31.6124 10.6532 31.8609 8.96792C32.1924 6.49613 31.999 2.70423 30.5353 1.13119ZM18.5212 29.4445L22.3601 23.0121C22.4431 22.8437 22.4706 22.647 22.4706 22.5066V11.7767C22.4706 11.4958 22.2773 11.3836 22.0841 11.6082C16.3118 18.1529 11.8099 25.0346 7.6395 33.3207C7.53455 33.5285 7.66712 33.7139 7.91572 33.6297L16.5327 30.9332C17.5048 30.6298 18.0517 30.231 18.5212 29.4445Z"
          fill="#000"
        />
      </G>
    </Svg>
  );
}

function NetworkIcon({network, size}: {network: Network; size: number}) {
  if (network === 'base') return <BaseIcon size={size} />;
  if (network === 'robinhood') return <RobinhoodIcon size={size} />;
  return <Image source={ICONS[network]} style={{width: size, height: size}} resizeMode="contain" />;
}

/** Network selector for the nav header — the current chain's icon, opening the same picker sheet as the asset selectors. */
export function NetworkSwitcher() {
  const {t} = useT();
  const network = useNetwork((s) => s.network);
  const setNetwork = useNetwork((s) => s.setNetwork);
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* 22, not 26. It sits opposite a 17pt vault name, and at 26 the chain's logo was taller
          than the text's cap height — the loudest thing in a bar whose job is to be quiet. The
          hit area is unchanged: hitSlop carries it past 44. */}
      <Pressable onPress={() => setOpen(true)} style={styles.pill} hitSlop={12}>
        <NetworkIcon network={network} size={22} />
      </Pressable>
      <PickerSheet
        visible={open}
        title={t('mobile.settings.choose_network')}
        items={NETWORKS.map((n) => ({key: n, label: networkLabel(n, t), icon: <NetworkIcon network={n} size={30} />}))}
        selected={network}
        onSelect={(n) => setNetwork(n as Network)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  pill: {marginRight: 16},
});

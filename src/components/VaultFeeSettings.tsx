import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {makeSettingsStyles} from '@/components/SettingsRow';
import {StableCoinAsGasCoins} from '@/components/StableCoinAsGasCoins';
import {PickerSheet} from '@/components/AssetPicker';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useNetwork} from '@/core/network-store';
import {gasReserveAmount, setGasReserveAmount} from '@/core/prefs';
import {useWallet} from '@/wallet/store';
import {useSyncFeeReserve} from '@/vault/stableCoinAsGas';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * What the reserve may be set to, per chain.
 *
 * A fixed set rather than a free field: these are the only answers worth giving, and a typed
 * figure invites a stray zero that locks the whole stablecoin balance behind a reserve nobody
 * meant to set — with Max then offering nothing and no clue why.
 *
 * Mainnet starts at ten because a relay there costs the better part of a dollar and the vault's
 * own per-operation ceiling is ten; everywhere else a relay costs cents, so one is a real choice
 * and a thousand would be absurd.
 */
const CHOICES: Record<string, number[]> = {
  mainnet: [5, 10, 100, 1000],
};
const CHOICES_DEFAULT = [1, 5, 10, 100];

/**
 * How the VAULT pays network fees: which coins the relayer may bill, in the owner's order of
 * preference (long-press and drag; the first is asked for first and holds the reserve), the reserve
 * kept to pay them, and — a page further — the caps on what may be billed.
 *
 * Shown whoever is paying right now. Every change here is itself a vault write, paid the way the
 * vault is currently set to pay — so with the owner wallet paying, these are still reachable and the
 * owner's ETH settles them. That is the case this is laid out for: a vault whose only fee coin is
 * one it holds none of cannot pay to change its own fee coins, and the owner can.
 *
 * The reserve is deliberately plain. Its value lives in the preferences file that is already open
 * at launch, read once into component state and written on change; there is no store, no
 * subscription and nothing initialised while this renders. The version that had all three crashed
 * the page every time it opened, and none of it was buying anything the row needs.
 */
export function VaultFeeSettings({onDragging}: {onDragging: (active: boolean) => void}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const choices = CHOICES[network] ?? CHOICES_DEFAULT;
  // The reserve belongs to THIS vault on THIS chain. Predicted locally from the owner, as everywhere
  // else — no RPC, so the right setting is on screen from the first frame rather than after a read.
  const owner = useWallet((s) => s.address);
  const vault = useActiveVaultAddress(network);
  const key = `${network}:${vault ?? ''}`;

  const [amount, setAmount] = useState(() => gasReserveAmount(network, vault));
  const [picking, setPicking] = useState(false);

  // Switching vault or chain while the page is open changes which setting it is editing.
  useEffect(() => {
    setAmount(gasReserveAmount(network, vault));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const catalog = useAssetCatalog(network);
  const bal = useVaultBalances(network);
  // Reported as it is edited — a new amount, or a new first coin after a drag — so the next
  // auto-yield sweep already leaves the new float.
  useSyncFeeReserve(network, vault, bal.balances, catalog);

  const choose = (v: string) => {
    setGasReserveAmount(network, vault, v);
    setAmount(v);
  };

  return (
    <>
      {/* The reserve is local, not on chain, so its row stays editable before activation; it is
          held in the first fee coin above that can (see resolveFeeReserve), so it sits with them. */}
      <View>
        <StableCoinAsGasCoins
          onDragging={onDragging}
          trailing={{
            title: t('mobile.settings.gas_reserve_amount'),
            value: Number(amount) > 0 ? `$${amount}` : t('vault.none'),
            onPress: () => setPicking(true),
          }}
        />
      </View>

      {/* The two ceilings on what the relayer may bill, on a page of their own with Save. */}
      <View style={[styles.group, styles.second]}>
        <Pressable style={styles.row} onPress={() => nav.navigate('NetworkFeeLimits')}>
          <Text style={styles.rowTitle}>{t('mobile.fees.advanced')}</Text>
          <Text style={styles.chev}>›</Text>
        </Pressable>
      </View>

      <PickerSheet
        visible={picking}
        title={t('mobile.settings.gas_reserve_amount')}
        // "None" turns the reserve off: nothing is held back from Max, and the keeper sweeps it all.
        items={[{key: '0', label: t('vault.none')}, ...choices.map((n) => ({key: String(n), label: `$${n}`}))]}
        selected={amount}
        onSelect={choose}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    second: {marginTop: 20},
  });

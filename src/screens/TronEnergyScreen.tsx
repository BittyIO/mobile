import React, {useCallback, useState} from 'react';
import {RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useBottomTabBarHeight} from '@react-navigation/bottom-tabs';
import {erc20Abi, formatUnits, zeroAddress, type Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {NATIVE, publicClientFor} from '@/core/chain';
import {ASSETS} from '@/core/assets';
import {useNetwork} from '@/core/network-store';
import {useActiveAccount} from '@/core/account-mode';
import {fmtNum} from '@/core/format';
import {accountEnergy, accountStake, type TronEnergy, type TronStake} from '@/tron/client';
import {evmToTron} from '@/tron/address';
import type {TronChain} from '@/tron/config';
import {fetchTronStakePosition, getTronUnstake, TRON_STAKE, tronStakeAdapter} from '@/vault/tron-stake';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {EarnRow, EarnTable} from './EarnScreen';

/**
 * Tron's Earn tab, named Energy: on Tron, staking TRX earns energy, not yield, so the tab is that.
 *
 * The current state only, kept simple: Earn's row for TRX (energy per TRX a day where an APY would
 * be, what is free, what is staked, and what is unstaking or ready to claim under it), then the
 * key's energy — a day, used, left. Stake, Unstake and Claim are on the row's own page, Earn's TRON
 * Stake detail, which acts for whichever account is active: the general wallet for itself, the smart
 * wallet (a vault) through its TRON Stake adapter, its energy delegated to the key.
 */
const ZERO = BigInt(0);

export function TronEnergyScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const tabBarHeight = useBottomTabBarHeight();
  const headerHeight = useTransparentHeaderInset();
  const network = useNetwork((s) => s.network);
  const active = useActiveAccount(network);
  const owner = active.wallet;
  const vaultOn = active.kind === 'vault';
  const holder = vaultOn ? active.vault : owner;
  const native = NATIVE[network];
  const wtrx = ASSETS[network].find((a) => a.symbol === native.wrapped);
  const adapter = tronStakeAdapter(network);

  const [trx, setTrx] = useState<bigint | null>(null);
  const [stake, setStake] = useState<TronStake | null>(null);
  const [energy, setEnergy] = useState<TronEnergy | null>(null);
  // A pull's own spinner: on from the pull until every read is back, as Guard's (onPull).
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!holder || !owner) return;
    const net = network as TronChain;
    // Each on its own: one read failing (TronGrid's rate limit) must not leave the others unknown,
    // which once left Stake doing nothing at all.
    if (vaultOn) {
      // The vault's: TRX and WTRX free to stake, the adapter clone's stake and unstake queue.
      const client = publicClientFor(network);
      const protocol = tronStakeAdapter(network);
      const [b, w, p, q, e] = await Promise.allSettled([
        client.getBalance({address: holder}),
        wtrx ? client.readContract({address: wtrx.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [holder]}) : Promise.resolve(ZERO),
        fetchTronStakePosition(holder, network),
        protocol ? getTronUnstake(holder, protocol, network) : Promise.resolve(null),
        // The stake's energy is delegated to the key, so it is the key's that is shown.
        accountEnergy(net, evmToTron(owner)),
      ]);
      if (b.status === 'fulfilled' && w.status === 'fulfilled') setTrx(b.value + (w.value as bigint));
      if (p.status === 'fulfilled' && q.status === 'fulfilled') {
        const now = Date.now();
        const unfreezing = q.value
          ? [
              ...(q.value.claimable > ZERO ? [{amountSun: q.value.claimable, unlockMs: 0}] : []),
              ...(q.value.unstaking > ZERO ? [{amountSun: q.value.unstaking, unlockMs: q.value.eta ? q.value.eta.end * 1000 : now + 1}] : []),
            ]
          : [];
        setStake({energySun: p.value?.raw ?? ZERO, delegatedSun: ZERO, unfreezing});
      }
      if (e.status === 'fulfilled') setEnergy(e.value);
      return;
    }
    const [b, s, e] = await Promise.allSettled([
      publicClientFor(network).getBalance({address: holder}),
      accountStake(net, evmToTron(holder)),
      // The energy is spent by the key, so it is the key's that is shown.
      accountEnergy(net, evmToTron(owner)),
    ]);
    if (b.status === 'fulfilled') setTrx(b.value);
    if (s.status === 'fulfilled') setStake(s.value);
    if (e.status === 'fulfilled') setEnergy(e.value);
  }, [network, holder, owner, vaultOn, wtrx]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );


  if (!holder || !owner || !wtrx) return null;
  const units = (sun: bigint) => formatUnits(sun, native.decimals);
  const staked = stake ? stake.energySun + stake.delegatedSun : null;
  const now = Date.now();
  const claimable = (stake?.unfreezing ?? []).filter((u) => u.unlockMs <= now).reduce((n, u) => n + u.amountSun, BigInt(0));
  const unstaking = (stake?.unfreezing ?? []).filter((u) => u.unlockMs > now).reduce((n, u) => n + u.amountSun, BigInt(0));
  const left = energy ? Math.max(0, energy.limit - energy.used) : null;

  // The row opens Earn's TRON Stake page, where Stake, Unstake and Claim are.
  const openDetail = () =>
    adapter && nav.navigate('EarnDetail', {protocol: adapter, asset: wtrx.address, symbol: wtrx.symbol, name: TRON_STAKE, lend: false});

  // Earn's row, fed this account's TRX: the staked amount where a position's is.
  const row = {
    route: {protocol: (adapter ?? zeroAddress) as Address, name: TRON_STAKE, asset: wtrx, kind: 'staking' as const},
    pos:
      staked !== null
        ? {protocol: (adapter ?? zeroAddress) as Address, protocolName: TRON_STAKE, category: 'staking' as never, asset: wtrx.address as Address, symbol: wtrx.symbol, decimals: wtrx.decimals, kind: 'staked' as const, raw: staked, formatted: units(staked)}
        : null,
  };

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        contentContainerStyle={[styles.content, {paddingTop: 8, paddingBottom: tabBarHeight + 16}]}
        contentInset={{top: headerHeight}}
        contentOffset={{x: 0, y: -headerHeight}}
        scrollIndicatorInsets={{top: headerHeight}}
        automaticallyAdjustContentInsets={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
            tintColor={c.text}
            colors={[c.accent]}
          />
        }>
        <EarnTable title={t('mobile.tron.energy_stake_title')}>
          <EarnRow
            first
            last
            row={row}
            free={trx !== null ? units(trx) : null}
            amountKnown={staked !== null}
            earned={null}
            dust={false}
            queue={stake ? {unstaking: units(unstaking), claimable: units(claimable)} : null}
            apy={null}
            energyRate={energy?.perTrxPerDay ?? null}
            onOpen={openDetail}
          />
        </EarnTable>

        <EarnTable title={t('mobile.tron.energy_key_title')}>
          <Stat first label={t('mobile.tron.energy_a_day')} value={energy ? fmtNum(energy.limit) : '—'} />
          <Stat label={t('mobile.tron.energy_used')} value={energy ? fmtNum(energy.used) : '—'} />
          <Stat label={t('mobile.tron.energy_left')} value={left !== null ? fmtNum(left) : '—'} strong last />
        </EarnTable>


      </ScrollView>
    </View>
  );
}

/** One line of the energy card: Earn's hairline rows, a label and its figure. */
function Stat({label, value, first, last, strong}: {label: string; value: string; first?: boolean; last?: boolean; strong?: boolean}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.stat, first && styles.statFirst, last && styles.statLast]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, strong && styles.statStrong]}>{value}</Text>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    content: {flexGrow: 1, padding: 16, gap: 20},
    stat: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingVertical: 12},
    statFirst: {borderTopWidth: 0},
    statLast: {paddingBottom: 0},
    statLabel: {color: c.text, fontSize: 15},
    statValue: {color: c.subtext, fontSize: 15, fontVariant: ['tabular-nums']},
    statStrong: {color: c.success, fontWeight: '600'},
  });

import React, {useEffect, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {formatUnits} from 'viem';
import type {RootStackParamList} from '@/App';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {fmtNum} from '@/core/format';
import {protocolDisplayName} from '@/core/protocols';
import {useTransparentHeaderInset} from '@/components/header-inset';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {ProgressRing, leftUnit} from '@/components/ProgressRing';
import {useToasts} from '@/components/Toast';
import {TRON_STAKE} from '@/vault/tron-stake';
import {UnlockCancelled} from '@/tron/send';
import {TRON_EXPLORER_TX} from '@/tron/config';
import {runStakeAction} from '@/tron/stake';
import {useTronStake} from '@/tron/useTronStake';

/**
 * TRON Stake on the Tron wallet: the vault's TRON Stake page (EarnDetailScreen) card for card —
 * the energy staking buys, the position, the unstake queue with its ring and Claim, and Withdraw /
 * Deposit — read from and signed by the wallet itself.
 */
export function TronStakeDetailScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const headerHeight = useTransparentHeaderInset();
  const {net, from, state, loading, load} = useTronStake();
  const [pulled, setPulled] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const fmt = (sun: bigint) => fmtNum(Number(formatUnits(sun, 6)));
  const held = state ? Number(formatUnits(state.stakedSun, 6)) : 0;
  const energy = state?.energy;
  const days = state?.unstakeDays ?? 0;
  const unstakeWait = days === 1 ? t('mobile.earn.unstake_wait_one') : t('mobile.earn.unstake_wait', {n: days});

  // The queue, as the vault reads Tron's: what is still unstaking, and the ring from the first
  // request to the last one's unlock.
  const [now, setNow] = useState(() => Date.now() / 1000);
  const waiting = (state?.unstaking ?? []).filter((u) => u.unlockAt / 1000 > now).sort((a, b) => a.unlockAt - b.unlockAt);
  const unstaking = waiting.reduce((n, u) => n + u.amountSun, 0n);
  const claimable = state?.claimableSun ?? 0n;
  const eta = waiting.length && days ? {start: waiting[0].unlockAt / 1000 - days * 86_400, end: waiting[waiting.length - 1].unlockAt / 1000} : null;
  useEffect(() => {
    if (!eta) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(id);
  }, [eta]);

  const claim = async () => {
    if (!from || claimable === 0n) return;
    setClaiming(true);
    const toasts = useToasts.getState();
    const id = toasts.show({kind: 'pending', title: `${t('vault.claim')} · ${fmt(claimable)} TRX`});
    try {
      const txID = await runStakeAction(net, from, {kind: 'claim'});
      toasts.update(id, {kind: 'success', hash: txID, explorer: {url: TRON_EXPLORER_TX[net], name: 'Tronscan'}});
      await load();
    } catch (e) {
      if (e instanceof UnlockCancelled) toasts.dismiss(id);
      else toasts.update(id, {kind: 'error', detail: (e as Error).message});
    } finally {
      setClaiming(false);
    }
  };

  const canDeposit = !!state && state.balanceSun > 0n;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.body, {paddingTop: 8}]}
      contentInset={{top: headerHeight}}
      contentOffset={{x: 0, y: -headerHeight}}
      scrollIndicatorInsets={{top: headerHeight}}
      automaticallyAdjustContentInsets={false}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={pulled && loading}
          onRefresh={() => {
            setPulled(true);
            void load().finally(() => setPulled(false));
          }}
          tintColor={c.text}
          colors={[c.accent]}
        />
      }>
      <View style={styles.head}>
        <TokenIcon symbol="TRX" size={40} />
        <View style={styles.headText}>
          <Text style={styles.sym}>TRX</Text>
          <Text style={styles.sub}>{protocolDisplayName(TRON_STAKE)}</Text>
        </View>
        {energy && energy.perTrxPerDay > 0 ? (
          <View style={styles.apyPill}>
            <Text style={styles.apyText}>{t('mobile.earn.energy_rate', {rate: energy.perTrxPerDay.toFixed(1)})}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Row label={t('mobile.earn.energy_yours')} value={energy ? `${fmtNum(Math.max(0, energy.limit - energy.used))} / ${fmtNum(energy.limit)}` : '—'} />
        <Row label={t('mobile.earn.energy_from_stake')} value={energy ? `≈ ${fmtNum(Math.floor(held * energy.perTrxPerDay))}` : '—'} />
        <Text style={styles.explain}>{t('mobile.earn.energy_what')}</Text>
      </View>

      <View style={styles.card}>
        <Row label={t('mobile.earn.detail_position')} value={state ? `${fmtNum(held)} TRX` : '—'} />
        <Row label={t('vault.balance')} value={state ? `${fmt(state.balanceSun)} TRX` : '—'} />
        <Row label={t('mobile.trade.bitty_fee')} value="0%" />
      </View>

      <View style={styles.card}>
        <Row label={t('mobile.earn.unstake_wait_label')} value={state ? unstakeWait : '—'} />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t('vault.unstaking')}</Text>
          <View style={styles.claimRight}>
            {unstaking > 0n && eta ? (
              <View style={styles.etaRow}>
                <ProgressRing size={16} calm done={Math.min(1, Math.max(0, (now - eta.start) / (eta.end - eta.start)))} left={eta.end - now} />
                <Text style={styles.eta}>~{leftUnit(eta.end - now, t).join(' ')}</Text>
              </View>
            ) : null}
            <Text style={styles.rowValue}>
              <Amount v={`${fmt(unstaking)} TRX`} size={15} />
            </Text>
          </View>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{t('vault.claimable')}</Text>
          <View style={styles.claimRight}>
            <Text style={[styles.rowValue, claimable > 0n && styles.rowValueGood]}>
              <Amount v={`${fmt(claimable)} TRX`} size={15} color={claimable > 0n ? c.success : undefined} />
            </Text>
            <Pressable
              style={({pressed}) => [styles.claimBtn, (claiming || claimable === 0n) && styles.btnFaded, pressed && styles.pressed]}
              disabled={claiming || claimable === 0n}
              hitSlop={6}
              onPress={() => void claim()}>
              <Text style={styles.claimText}>{t('vault.claim')}</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.wdBtn]} disabled={held <= 0} onPress={() => nav.navigate('TronStakeAction', {mode: 'withdraw'})}>
          <Text style={[styles.secText, held <= 0 && styles.secTextOff]} numberOfLines={1}>
            {t('vault.withdraw')}
          </Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.depBtn, !canDeposit && styles.btnFaded]} disabled={!canDeposit} onPress={() => nav.navigate('TronStakeAction', {mode: 'deposit'})}>
          <Text style={styles.priText} numberOfLines={1}>{t('vault.deposit')}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Row({label, value}: {label: string; value: string}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>
        <Amount v={value} size={15} />
      </Text>
    </View>
  );
}

// EarnDetailScreen's styles, for the parts this page draws.
const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, paddingBottom: 32, gap: 12},
    head: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 4},
    headText: {flex: 1},
    sym: {color: c.text, fontSize: 20, fontWeight: '700'},
    sub: {color: c.subtext, fontSize: 13, marginTop: 2},
    apyPill: {backgroundColor: c.successSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4},
    apyText: {color: c.success, fontSize: 13, fontWeight: '700'},
    card: {backgroundColor: c.card, borderRadius: 20, borderCurve: 'continuous', padding: 16, gap: 10},
    row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
    rowLabel: {color: c.subtext, fontSize: 14, flexShrink: 1},
    rowValue: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
    rowValueGood: {color: c.success},
    explain: {color: c.subtext, fontSize: 13, lineHeight: 19},
    actions: {flexDirection: 'row', gap: 12, marginTop: 8},
    btn: {flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12},
    depBtn: {backgroundColor: c.accent},
    btnFaded: {opacity: 0.5},
    wdBtn: {backgroundColor: c.buttonSecondary},
    secTextOff: {color: c.subtext},
    priText: {color: c.onAccent, fontSize: 17, fontWeight: '700'},
    secText: {color: c.textMuted, fontSize: 17, fontWeight: '700'},
    claimRight: {flexDirection: 'row', alignItems: 'center', gap: 10},
    etaRow: {flexDirection: 'row', alignItems: 'center', gap: 4},
    eta: {color: c.subtext, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums']},
    claimBtn: {backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6},
    claimText: {color: c.onAccent, fontSize: 14, fontWeight: '700'},
    pressed: {opacity: 0.7},
  });

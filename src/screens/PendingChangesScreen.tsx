import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import Svg, {Path, Rect} from 'react-native-svg';
import {ProgressRing, waitDone} from '@/components/ProgressRing';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getPendingChanges, getRiskConfig, type PendingChange} from '@/vault/risk';
import {SettingsGroup} from '@/components/SettingsRow';
import {SettingsIcon, type SettingsIconName} from '@/components/SettingsIcon';
import {RISK_TITLE, fmtRiskValue} from '@/components/riskFormat';
import {fmtPerms} from '@/components/useAssetManagerRow';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

type T = ReturnType<typeof useT>['t'];

const ICON: Record<PendingChange['kind'], SettingsIconName> = {
  timelock: 'timelock',
  sendDailyAllowance: 'dailyLimit',
  marketTradeDailyLossAllowance: 'dailyLimit',
  gasBudgetDaily: 'stableCoinAsGas',
  maxFeePerOp: 'stableCoinAsGas',
  newOwner: 'security',
  newAssetManager: 'delegation',
  whitelistAdd: 'allowlist',
  whitelistRemove: 'allowlist',
};

function title(p: PendingChange, t: T): string {
  switch (p.kind) {
    case 'timelock':
    case 'sendDailyAllowance':
    case 'marketTradeDailyLossAllowance':
      return t(RISK_TITLE[p.kind]);
    case 'gasBudgetDaily':
      return t('mobile.vault.pending_gas_budget');
    case 'maxFeePerOp':
      return t('mobile.vault.pending_max_fee');
    case 'newOwner':
      return t('mobile.vault.pending_new_owner');
    case 'newAssetManager':
      return t('mobile.vault.pending_new_asset_manager');
    case 'whitelistAdd':
      return t('mobile.vault.pending_whitelist_add');
    case 'whitelistRemove':
      return t('mobile.vault.pending_whitelist_remove');
  }
}

function value(p: PendingChange, t: T): string {
  switch (p.kind) {
    case 'timelock':
    case 'sendDailyAllowance':
    case 'marketTradeDailyLossAllowance':
      return fmtRiskValue(p.kind, p.value, null, undefined, t);
    case 'gasBudgetDaily':
    case 'maxFeePerOp':
      // Whole dollars, as the contract stores them.
      return `$${Number(p.value).toLocaleString()}`;
    default:
      return p.address;
  }
}

/**
 * The way to the lock, in the header: the one thing to do about a change the owner did not ask for,
 * reachable without scrolling past the list.
 */
function LockButton({onPress, label}: {onPress: () => void; label: string}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={onPress} hitSlop={10} style={styles.lockBtn} accessibilityRole="button" accessibilityLabel={label}>
      <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
        <Rect x={3} y={11} width={18} height={11} rx={2} stroke={c.danger} strokeWidth={2} />
        <Path d="M7 11V7a5 5 0 0 1 10 0v4" stroke={c.danger} strokeWidth={2} strokeLinecap="round" />
      </Svg>
    </Pressable>
  );
}

/**
 * Overview › Pending — everything the vault has been told to do and has not done yet: a loosened
 * risk number, a handover, an asset-manager grant, an address-book entry maturing or leaving. Each
 * counts down to the second to when it takes effect, because that is the owner's window to lock the
 * vault if they did not ask for it — which the lock in the header goes straight to.
 *
 * One clock for the page, ticking only while it is in view. When an item comes due the list is read
 * again, so a change that has taken effect leaves it; at most every few seconds, since the chain's
 * clock can trail the phone's and the item may still read as pending for a block or two.
 */
export function PendingChangesScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const [items, setItems] = useState<PendingChange[] | null>(null);
  const [timelock, setTimelock] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const lastRead = useRef(0);

  const load = useCallback(() => {
    if (!vault) return;
    lastRead.current = Date.now();
    getPendingChanges(vault, network).then(setItems);
    getRiskConfig(vault, network).then((r) => setTimelock(Number(r.timelock)));
  }, [vault, network]);

  useFocusEffect(
    useCallback(() => {
      load();
      setNow(Math.floor(Date.now() / 1000));
      const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
      return () => clearInterval(id);
    }, [load]),
  );

  // Something came due: read again so it drops out once the chain agrees.
  const anyDue = items?.some((p) => Number(p.at) <= now) ?? false;
  useEffect(() => {
    if (anyDue && Date.now() - lastRead.current > 5_000) load();
  }, [anyDue, now, load]);

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => <LockButton label={t('mobile.vault.vault_lock')} onPress={() => nav.navigate('VaultLock')} />,
    });
  }, [nav, t]);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      {items === null ? (
        <ActivityIndicator />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>{t('mobile.vault.pending_none')}</Text>
      ) : (
        <SettingsGroup footer={t('mobile.vault.pending_lock_hint')}>
          {items.map((p, i) => {
            const at = Number(p.at);
            // ponytail: the chain keeps only when an item lands, not when it was queued, so the start
            // is `at` less today's timelock; exact if the timelock hasn't changed since, else read the
            // queuing event's block time.
            const done = waitDone(at, now, timelock);
            const perms = p.kind === 'newAssetManager' ? ` · ${fmtPerms(p.perms, t)}` : '';
            return (
              <View key={`${p.kind}:${'address' in p ? p.address : ''}:${p.at}`} style={[styles.item, i < items.length - 1 && styles.divider]}>
                <SettingsIcon name={ICON[p.kind]} />
                <View style={styles.itemText}>
                  <Text style={styles.title} numberOfLines={1}>{title(p, t)}</Text>
                  <Text style={styles.value}>{value(p, t)}{perms}</Text>
                </View>
                <ProgressRing done={done} left={at - now} />
              </View>
            );
          })}
        </SettingsGroup>
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    empty: {color: c.subtext, fontSize: 15, textAlign: 'center', marginTop: 24},
    // Sized to the bar's 44 like the trade menu's: the native bar anchors a custom view by its bottom.
    lockBtn: {width: 44, height: 44, paddingBottom: 12, alignItems: 'center', justifyContent: 'center'},
    item: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: c.card},
    divider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    itemText: {flex: 1, gap: 3},
    title: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    value: {color: c.subtext, fontSize: 13},
  });

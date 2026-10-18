import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text} from 'react-native';
import Svg, {Path, Rect} from 'react-native-svg';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getPendingChanges, type PendingChange} from '@/vault/risk';
import {SettingsRow, SettingsGroup} from '@/components/SettingsRow';
import type {SettingsIconName} from '@/components/SettingsIcon';
import {RISK_TITLE, fmtRiskValue} from '@/components/riskFormat';
import {fmtPerms} from '@/components/useAssetManagerRow';
import {shortAddress} from '@/core/format';
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
      return shortAddress(p.address);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What is left until `at`, to the second: "2 days 03:12:45", or "03:12:45" inside the last day.
 * Null once it is due.
 */
function countdown(at: bigint, nowSec: number, t: T): string | null {
  const left = Number(at) - nowSec;
  if (left <= 0) return null;
  const days = Math.floor(left / 86_400);
  const clock = `${pad(Math.floor((left % 86_400) / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`;
  return days > 0 ? `${t('mobile.vault.duration_days', {n: days})} ${clock}` : clock;
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
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const lastRead = useRef(0);

  const load = useCallback(() => {
    if (!vault) return;
    lastRead.current = Date.now();
    getPendingChanges(vault, network).then(setItems);
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
            const left = countdown(p.at, now, t);
            const date = new Date(Number(p.at) * 1000).toLocaleString();
            const perms = p.kind === 'newAssetManager' ? ` · ${fmtPerms(p.perms, t)}` : '';
            return (
              <SettingsRow
                key={`${p.kind}:${'address' in p ? p.address : ''}:${p.at}`}
                icon={ICON[p.kind]}
                title={title(p, t)}
                value={value(p, t)}
                sub={`${left ? t('mobile.vault.pending_countdown', {time: left}) : t('mobile.vault.pending_due')}\n${date}${perms}`}
                chevron={false}
                last={i === items.length - 1}
              />
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
    lockBtn: {paddingHorizontal: 4, paddingVertical: 2},
  });

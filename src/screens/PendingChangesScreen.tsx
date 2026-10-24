import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text} from 'react-native';
import {PendingRow} from '@/components/PendingRow';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {getPendingChanges, getRiskConfig, type PendingChange} from '@/vault/risk';
import {removeWhitelisted} from '@/vault/payments';
import {cancelPendingAssetManager, getAssetManager} from '@/vault/delegate';
import {useVaultWrite} from '@/components/useVaultWrite';
import {OptionRow, SettingsGroup} from '@/components/SettingsRow';
import {RISK_TITLE, fmtRiskValue} from '@/components/riskFormat';
import {PERM_ROWS} from '@/components/useAssetManagerRow';
import {Sheet} from '@/components/Sheet';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {recipientName, useRecipientNames} from '@/core/recipient-names';
import type {Network} from '@/core/chain';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

type T = ReturnType<typeof useT>['t'];

export function pendingTitle(p: PendingChange, t: T): string {
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

/** The name an address-book entry goes by on this device, as the book shows it. */
export function useEntryLabel(network: Network) {
  const names = useRecipientNames((s) => s.names);
  return (address: string) => recipientName(names, network, address);
}

/**
 * A pending item's value. An address-book entry is shown as the book shows it — the name given on
 * this device, or its place in the book — over its address, so a new entry can be recognised
 * before it can be paid.
 */
export function pendingValue(p: PendingChange, t: T, nameOf?: (address: string) => string | undefined): string {
  switch (p.kind) {
    case 'timelock':
    case 'sendDailyAllowance':
    case 'marketTradeDailyLossAllowance':
      return fmtRiskValue(p.kind, p.value, t);
    case 'gasBudgetDaily':
    case 'maxFeePerOp':
      // Whole dollars, as the contract stores them.
      return `$${Number(p.value).toLocaleString()}`;
    case 'whitelistAdd':
    case 'whitelistRemove':
      return `${nameOf?.(p.address) ?? t('mobile.payments.recipient_n', {n: p.id})}\n${p.address}`;
    default:
      return p.address;
  }
}

/**
 * Overview › Pending — everything the vault has been told to do and has not done yet: a loosened
 * risk number, a handover, an asset-manager grant, an address-book entry maturing or leaving. Each
 * counts down to the second to when it takes effect, because that is the owner's window to lock the
 * vault if they did not ask for it — which "No, it wasn't me" under the list goes straight to.
 *
 * One clock for the page, ticking only while it is in view. When an item comes due the list is read
 * again, so a change that has taken effect leaves it; at most every few seconds, since the chain's
 * clock can trail the phone's and the item may still read as pending for a block or two.
 */
export function PendingChangesScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const nameOf = useEntryLabel(network);
  const [items, setItems] = useState<PendingChange[] | null>(null);
  const [timelock, setTimelock] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const lastRead = useRef(0);
  const {busy, ready, run, sheet} = useVaultWrite(() => load());

  const load = useCallback(() => {
    if (!vault) return;
    lastRead.current = Date.now();
    return Promise.all([
      getPendingChanges(vault, network).then(setItems),
      getRiskConfig(vault, network).then((r) => setTimelock(Number(r.timelock))),
    ]);
  }, [vault, network]);

  /** What calls an item off, for the kinds that can be: a new whitelist entry, a new asset manager. */
  const cancelFor = (p: PendingChange) => {
    if (!vault) return null;
    if (p.kind === 'whitelistAdd')
      return () => run(`cancel-${p.kind}`, t('mobile.vault.cancel_whitelist_add'), (b) => removeWhitelisted({...b, id: p.id}), p.address);
    if (p.kind === 'newAssetManager')
      return () =>
        run(
          `cancel-${p.kind}`,
          t('mobile.vault.cancel_pending_manager'),
          async (b) => cancelPendingAssetManager({...b, current: await getAssetManager(vault, network)}),
          p.address,
        );
    return null;
  };

  const [permsOf, setPermsOf] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const onPull = () => {
    setRefreshing(true);
    Promise.resolve(load()).finally(() => setRefreshing(false));
  };

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

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}>
      {items === null ? (
        <ActivityIndicator />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>{t('mobile.vault.pending_none')}</Text>
      ) : (
        <>
        <SettingsGroup>
          {items.map((p, i) => {
            const cancel = cancelFor(p);
            return (
              <PendingRow
                key={`${p.kind}:${'address' in p ? p.address : ''}:${p.at}`}
                at={Number(p.at)}
                now={now}
                timelock={timelock}
                title={pendingTitle(p, t)}
                value={pendingValue(p, t, nameOf)}
                // A new asset manager's permissions are a list, so they open in a sheet rather than crowd the row.
                onPress={p.kind === 'newAssetManager' ? () => setPermsOf(p.perms) : undefined}
                onCancel={cancel ?? undefined}
                cancelling={busy === `cancel-${p.kind}`}
                cancelDisabled={!ready || busy !== null}
                last={i === items.length - 1}
              />
            );
          })}
        </SettingsGroup>
        {/* The one thing to do about a change the owner did not ask for: lock before it lands. */}
        <SettingsGroup>
          <Pressable style={({pressed}) => [styles.notMe, pressed && styles.pressed]} onPress={() => nav.navigate('VaultLock')}>
            <Text style={styles.notMeText}>{t('mobile.vault.pending_not_me')}</Text>
          </Pressable>
        </SettingsGroup>
        </>
      )}
      <Sheet visible={permsOf !== null} title={t('mobile.vault.permissions')} onClose={() => setPermsOf(null)}>
        <SettingsGroup>
          {PERM_ROWS.map((r, i) => (
            <OptionRow key={r.bit} title={t(r.key)} checked={((permsOf ?? 0) & r.bit) !== 0} last={i === PERM_ROWS.length - 1} />
          ))}
        </SettingsGroup>
      </Sheet>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    empty: {color: c.subtext, fontSize: 15, textAlign: 'center', marginTop: 24},
    // Sized to the bar's 44 like the trade menu's: the native bar anchors a custom view by its bottom.
    notMe: {minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
    notMeText: {color: c.danger, fontSize: 16, fontWeight: '600'},
    pressed: {opacity: 0.6},
  });

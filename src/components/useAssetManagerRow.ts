import {useCallback, useEffect, useState} from 'react';
import {ActionSheetIOS, Alert} from 'react-native';
import {isAddress, type Address} from 'viem';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {ASSETS} from '@/core/assets';
import {getAssetManager, setAssetManager, revokeAssetManager, type AssetManagerSettings} from '@/vault/delegate';
import {shortAddress} from '@/core/format';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';

const isSet = (a?: string) => !!a && !/^0x0+$/.test(a);

/** Expiry choices for an appointment, in days; 0 = never. */
const EXPIRIES: {label: string; days: number}[] = [
  {label: '30d', days: 30},
  {label: '90d', days: 90},
  {label: '1y', days: 365},
  {label: 'Never', days: 0},
];

/**
 * The Asset manager settings row, driven by dialogs instead of a page: the row shows the current
 * manager and its expiry; tapping it prompts for an address (or, with one set, offers Change / Revoke),
 * then an expiry, then signs. Appointments land in a pending slot until the change timelock passes.
 */
export function useAssetManagerRow(): {value?: string; sub?: string; onPress: () => void} {
  const {t} = useT();
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = ASSETS[network].find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [am, setAm] = useState<AssetManagerSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (vault) getAssetManager(vault, network).then(setAm).catch(() => setAm(null));
  }, [vault, network]);
  useEffect(load, [load]);

  const fmtExpiry = (expiresAt: bigint, mode: 'until' | 'on' = 'until'): string => {
    if (expiresAt === 0n) return t('mobile.vault.no_expiry');
    const d = new Date(Number(expiresAt) * 1000);
    if (d < new Date()) return t('mobile.vault.expired');
    return t(mode === 'on' ? 'mobile.vault.on_date' : 'mobile.vault.until_date', {date: d.toLocaleDateString()});
  };

  const run = async (title: string, fn: (acct: Awaited<ReturnType<typeof getSigner>>) => Promise<string>) => {
    if (!vault || !stable) return;
    setBusy(true);
    const tx = showTx(title, network);
    try {
      const acct = await getSigner();
      tx.success(await fn(acct));
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // Step 2: the expiry, then sign.
  const pickExpiry = (manager: Address) => {
    const labels = EXPIRIES.map((e) => (e.days === 0 ? t('mobile.vault.never_expires') : e.label));
    ActionSheetIOS.showActionSheetWithOptions(
      {title: t('vault.expires'), options: [...labels, t('common.cancel')], cancelButtonIndex: labels.length},
      (i) => {
        if (i >= EXPIRIES.length) return;
        const days = EXPIRIES[i].days;
        const expiresAt = days === 0 ? 0n : BigInt(Math.floor(Date.now() / 1000) + days * 86400);
        run(t('mobile.vault.appoint'), (acct) => setAssetManager({account: acct, vault: vault!, network, manager, expiresAt, stableCoin: stable!.address}));
      },
    );
  };

  // Step 1: the address, in the native prompt.
  const promptAddress = () => {
    Alert.prompt(
      t('vault.asset_manager'),
      t('mobile.vault.enter_manager_address'),
      (value) => {
        const addr = (value ?? '').trim();
        if (!isAddress(addr)) {
          if (addr) Alert.alert(t('vault.failed'), t('mobile.vault.enter_manager_address'));
          return;
        }
        pickExpiry(addr as Address);
      },
      'plain-text',
      am && isSet(am.manager) ? am.manager : '',
    );
  };

  const onPress = () => {
    if (busy || !vault) return;
    if (am && isSet(am.manager)) {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: `${t('vault.asset_manager')}: ${shortAddress(am.manager)}`,
          options: [t('vault.edit'), t('vault.revoke'), t('common.cancel')],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
        },
        (i) => {
          if (i === 0) promptAddress();
          if (i === 1) {
            Alert.alert(t('mobile.vault.revoke_manager_title'), t('mobile.vault.revoke_manager_msg'), [
              {text: t('common.cancel'), style: 'cancel'},
              {text: t('vault.revoke'), style: 'destructive', onPress: () => run(t('vault.revoke'), (acct) => revokeAssetManager({account: acct, vault: vault!, network, stableCoin: stable!.address}))},
            ]);
          }
        },
      );
      return;
    }
    promptAddress();
  };

  if (busy) return {value: '…', onPress};
  if (!am) return {onPress};
  const value = isSet(am.manager) ? shortAddress(am.manager) : undefined;
  const parts: string[] = [];
  if (isSet(am.manager)) parts.push(fmtExpiry(am.expiresAt));
  if (isSet(am.pendingManager)) parts.push(`${t('mobile.vault.pending_timelock')}: ${shortAddress(am.pendingManager)} · ${t('mobile.vault.applies', {when: fmtExpiry(am.pendingAt, 'on')})}`);
  return {value, sub: parts.length ? parts.join(' · ') : undefined, onPress};
}

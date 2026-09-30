import React, {useCallback, useEffect, useState} from 'react';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {ASSETS} from '@/core/assets';
import {checkVaultUpgrade, upgradeVault, type VaultUpgrade} from '@/vault/manage';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';

/**
 * The Version row of Settings › Vault, as on the web's Security tab: the running release, an arrow to
 * the offered one when the guard has a newer build, and a status line. Tapping an offered upgrade
 * confirms, then signs the UUPS upgrade (relayed, gasless).
 */
export function useVaultVersionRow(): {
  value?: string;
  sub?: string;
  upgradeable: boolean;
  onPress: () => void;
  /** Mount this in the settings page: it is the confirmation the upgrade goes through. */
  sheet: React.ReactNode;
} {
  const {t} = useT();
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = ASSETS[network].find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [up, setUp] = useState<VaultUpgrade | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (vault) checkVaultUpgrade(vault, network).then(setUp);
  }, [vault, network]);
  useEffect(load, [load]);

  const {ask, sheet} = useConfirmAction();

  const doUpgrade = async () => {
    if (!vault || !stable || !up?.latest) return;
    setBusy(true);
    const tx = showTx(`${t('vault.upgrade_action')} · ${up.latestVersion ?? ''}`.trim(), network);
    try {
      const acct = await getSigner();
      tx.success(await upgradeVault({account: acct, vault, network, newImpl: up.latest, stableCoin: stable.address}));
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const upgradeable = !!up?.available && !busy;
  // The app's own confirmation rather than a system alert, so an upgrade is agreed to the same way
  // every other on-chain action is: a Face ID button with the fee it will cost beside it.
  const onPress = () => {
    if (!upgradeable || !up) return;
    ask({
      title: t('vault.upgrade_available'),
      message: `${up.currentVersion ?? '?'} → ${up.latestVersion ?? '?'}`,
      gas: relayGasFor({setup: true}),
      run: doUpgrade,
    });
  };

  if (busy) return {value: '…', upgradeable: false, onPress, sheet};
  if (!up) return {upgradeable: false, onPress, sheet};
  // Before activation the vault will be born on the guard's latest build, so that is its version.
  const shown = up.currentVersion ?? (!up.current ? up.latestVersion : null);
  const value = up.available && up.latestVersion ? `${shown ?? '?'} → ${up.latestVersion}` : shown ?? t('vault.upgrade_version_unknown');
  // Only states that need saying: an offered update, or a vault that is not deployed yet.
  const sub = up.available ? t('vault.upgrade_available') : !up.current ? t('vault.upgrade_not_deployed') : undefined;
  return {value, sub, upgradeable, onPress, sheet};
}

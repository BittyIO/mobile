import {useCallback, useEffect, useState} from 'react';
import {Alert} from 'react-native';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {ASSETS} from '@/core/assets';
import {checkVaultUpgrade, upgradeVault, type VaultUpgrade} from '@/vault/manage';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';

/**
 * The Version row of Settings › Vault, as on the web's Security tab: the running release, an arrow to
 * the offered one when the guard has a newer build, and a status line. Tapping an offered upgrade
 * confirms, then signs the UUPS upgrade (relayed, gasless).
 */
export function useVaultVersionRow(): {value?: string; sub?: string; upgradeable: boolean; onPress: () => void} {
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
  const onPress = () => {
    if (!upgradeable || !up) return;
    Alert.alert(t('vault.upgrade_available'), `${up.currentVersion ?? '?'} → ${up.latestVersion ?? '?'}`, [
      {text: t('common.cancel'), style: 'cancel'},
      {text: t('vault.upgrade_action'), onPress: doUpgrade},
    ]);
  };

  if (busy) return {value: '…', upgradeable: false, onPress};
  if (!up) return {upgradeable: false, onPress};
  // Before activation the vault will be born on the guard's latest build, so that is its version.
  const shown = up.currentVersion ?? (!up.current ? up.latestVersion : null);
  const value = up.available && up.latestVersion ? `${shown ?? '?'} → ${up.latestVersion}` : shown ?? t('vault.upgrade_version_unknown');
  // Only states that need saying: an offered update, or a vault that is not deployed yet.
  const sub = up.available ? t('vault.upgrade_available') : !up.current ? t('vault.upgrade_not_deployed') : undefined;
  return {value, sub, upgradeable, onPress};
}

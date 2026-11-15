import {useEffect} from 'react';
import {Alert, Linking} from 'react-native';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {vaultNeedsNewerApp} from '@/core/app-version';
import {fetchUpdateInfo} from '@/core/app-update';
import {runningVaultVersion} from './vault-abi';

type T = (key: string, params?: Record<string, string | number>) => string;

/** The vaults already asked about this launch, with their release: the prompt is not raised twice. */
const asked = new Set<string>();

/**
 * The vault in front runs a release this app cannot drive (see vaultNeedsNewerApp: app 1.0.10
 * against vault 1.1.0): ask for the app update first, with a button to the store.
 *
 * Every write is refused anyway (vault/vault-abi `assertCanWrite`), and nothing is offered as an
 * upgrade; this says so up front instead of after a tap. Before activation the release read is the
 * one the vault would be born on, which this app could not drive either.
 */
export function useVaultAppCheck(t: T): void {
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  useEffect(() => {
    if (!vault) return;
    let live = true;
    void runningVaultVersion(vault, network)
      .then(async (version) => {
        if (!live || !version || !vaultNeedsNewerApp(version)) return;
        const key = `${network}:${vault.toLowerCase()}:${version}`;
        if (asked.has(key)) return;
        asked.add(key);
        const info = await fetchUpdateInfo();
        if (!live) return;
        const title = t('mobile.settings.vault_app_update_title');
        const body = t('mobile.settings.vault_app_update_body', {version});
        if (!info) {
          Alert.alert(title, body);
          return;
        }
        Alert.alert(title, body, [
          {text: t('mobile.settings.update_later'), style: 'cancel'},
          {text: t('mobile.settings.update_now'), onPress: () => void Linking.openURL(info.url).catch(() => {})},
        ]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vault, network, t]);
}

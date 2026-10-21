import React, {useCallback, useEffect, useState} from 'react';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useVaultGeneration} from '@/core/vault-generation';
import {ownerVaultAddress} from '@/vault/read';
import {checkAdapterUpgrades, formatVersion, upgradeAdapter, type AdapterUpgrade} from '@/vault/upgrade-adapter';
import {protocolDisplayName} from '@/core/protocols';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {usePending} from '@/vault/pending';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {useAssetCatalog} from '@/core/asset-catalog';

export type ProtocolUpgradeRow = {
  key: string;
  title: string;
  value: string;
  confirming: boolean;
  onPress: () => void;
};

/**
 * One Settings › Vault row per adapter clone that is behind, as on the web's Security tab: "Upgrade
 * Sky V1 · 1.0.0 → 1.0.1". Tapping confirms, then relays the in-place upgrade (see {upgradeAdapter}).
 * Empty — no rows at all — when every clone is current, which is the usual case.
 */
export function useProtocolUpgradeRows(): {rows: ProtocolUpgradeRow[]; sheet: React.ReactNode} {
  const {t} = useT();
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const generation = useVaultGeneration((s) => s.generation);
  const stable = useAssetCatalog(network).find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [ups, setUps] = useState<AdapterUpgrade[]>([]);
  const load = useCallback(() => {
    if (!vault) return setUps([]);
    checkAdapterUpgrades(vault, network)
      .then(setUps)
      .catch(() => setUps([]));
    // `generation` changes the guard (and the vault) the read goes to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, network, generation]);
  useEffect(load, [load]);

  // As on the version row: the relayer accepting is not the upgrade landing, so a row stays
  // "Confirming" until the pending store sees the receipt, then the clones are read again.
  const [submitted, setSubmitted] = useState<{hash: string; key: string} | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = usePending((s) => s.txs);
  const inFlight = submitted != null && pending.some((x) => x.hash === submitted.hash && x.status === 'pending');
  useEffect(() => {
    if (submitted && !inFlight) {
      setSubmitted(null);
      load();
    }
  }, [submitted, inFlight, load]);
  const working = busy ?? (inFlight ? submitted?.key : null);

  const {ask, sheet} = useConfirmAction();

  const rows = ups.map((u): ProtocolUpgradeRow => {
    const key = u.oldProtocol;
    const name = protocolDisplayName(u.name);
    const title = t('vault.action_upgrade_protocol', {name});
    const versions = `${formatVersion(u.currentVersion)} → ${formatVersion(u.latestVersion)}`;
    const run = async () => {
      if (!vault || !stable) return;
      setBusy(key);
      const tx = showTx(`${title} · ${formatVersion(u.latestVersion)}`, network);
      try {
        const acct = await getSigner();
        const hash = await upgradeAdapter({
          account: acct,
          vault,
          network,
          oldProtocol: u.oldProtocol,
          newImpl: u.newImpl,
          stableCoin: stable.address,
        });
        tx.success(hash);
        setSubmitted({hash, key});
      } catch (e) {
        tx.error(String((e as Error)?.message ?? e));
      } finally {
        setBusy(null);
      }
    };
    return {
      key,
      title,
      value: working === key ? t('vault.confirming') : versions,
      confirming: working === key,
      onPress: () => {
        if (working) return;
        ask({title, message: versions, gas: relayGasFor({setup: true}), run});
      },
    };
  });
  return {rows, sheet};
}

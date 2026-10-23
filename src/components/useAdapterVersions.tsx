import React, {useCallback, useEffect, useState} from 'react';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {adapterStatuses, formatVersion, upgradeAdapter, type AdapterStatus} from '@/vault/upgrade-adapter';
import {protocolDisplayName} from '@/core/protocols';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {usePending} from '@/vault/pending';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {useAssetCatalog} from '@/core/asset-catalog';

export type AdapterUpgradeRow = {
  key: string;
  /** "CoW Swap V1": the row names the protocol; the section header says what is on offer. */
  name: string;
  /** Every address of the adapter's lineage, so the row can find its protocol's icon. */
  addresses: string[];
  /** "1.0.0 → 1.0.1", or "Confirming" while the upgrade is being mined. */
  value: string;
  confirming: boolean;
  onPress: () => void;
};

/**
 * For Allow list › Protocols: the version each protocol row runs, and one upgrade row per adapter
 * clone that is behind, as on the web's Security tab. Tapping an upgrade confirms, then relays the
 * in-place upgrade (see {upgradeAdapter}).
 */
export function useAdapterVersions(): {
  versionFor: (address: string) => string | null;
  upgrades: AdapterUpgradeRow[];
  sheet: React.ReactNode;
} {
  const {t} = useT();
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = useAssetCatalog(network).find((a) => a.kind === 'stable');
  const vault = useActiveVaultAddress(network);

  const [statuses, setStatuses] = useState<AdapterStatus[]>([]);
  // Cleared first and guarded, as on the version row: a switch never shows the last network's
  // versions, nor lets its late answer land on the new one.
  const load = useCallback(() => {
    setStatuses([]);
    if (!vault) return;
    let live = true;
    adapterStatuses(vault, network)
      .then((s) => live && setStatuses(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vault, network]);
  useEffect(load, [load]);

  // As on the version row: the relayer accepting is not the upgrade landing, so a row stays
  // "Confirming" until the pending store sees the receipt, then the clones are read again.
  // Keyed by network too: after a switch, another network's in-flight upgrade is not this one's.
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
  // One upgrade at a time per network; another network's does not hold this one's rows.
  const busyHere = !!working?.startsWith(`${network}:`);

  const {ask, sheet} = useConfirmAction();

  /** What the vault runs for the adapter a row names, e.g. "1.0.0"; null when the guard has never heard of it. */
  const versionFor = (address: string): string | null => {
    const s = statuses.find((x) => x.addresses.includes(address.toLowerCase()));
    return s ? formatVersion(s.version) : null;
  };

  const upgrades = statuses.flatMap(({upgrade: u, addresses}): AdapterUpgradeRow[] => {
    if (!u) return [];
    const key = `${network}:${u.oldProtocol}`;
    const name = protocolDisplayName(u.name);
    const title = t('vault.action_upgrade_protocol', {name});
    const versions = `${formatVersion(u.currentVersion)} → ${formatVersion(u.latestVersion)}`;
    const run = async () => {
      if (!vault || !stable) return;
      setBusy(key);
      const tx = showTx(`${title} · ${formatVersion(u.latestVersion)}`, network);
      try {
        const acct = await getSigner();
        const hash = await upgradeAdapter({account: acct, vault, network, oldProtocol: u.oldProtocol, newImpl: u.newImpl, stableCoin: stable.address});
        tx.success(hash);
        setSubmitted({hash, key});
      } catch (e) {
        tx.error(String((e as Error)?.message ?? e));
      } finally {
        setBusy(null);
      }
    };
    return [
      {
        key,
        name,
        addresses,
        value: working === key ? t('vault.confirming') : versions,
        confirming: working === key,
        onPress: () => {
          if (!busyHere) ask({title, message: versions, gas: relayGasFor({setup: true}), run});
        },
      },
    ];
  });
  return {versionFor, upgrades, sheet};
}

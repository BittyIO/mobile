import React, {useCallback, useEffect, useState} from 'react';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {useActiveVaultAddress} from '@/core/active-vault';

import {checkVaultUpgrade, upgradeVault, type VaultUpgrade} from '@/vault/manage';
import {
  fetchVaultVersions,
  upgradeNoteFor,
  VAULT_NOTE_CATEGORY,
  type VaultVersionsCatalog,
} from '@/vault/versions';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {usePending} from '@/vault/pending';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {useAssetCatalog} from '@/core/asset-catalog';

/**
 * The Version row of Settings › Vault, as on the web's Security tab: the running release, an arrow to
 * the offered one when the guard has a newer build, and a status line. Tapping an offered upgrade
 * confirms, then signs the UUPS upgrade (relayed, gasless).
 */
export function useVaultVersionRow(): {
  value?: string;
  sub?: string;
  upgradeable: boolean;
  /** A submitted upgrade is still being mined: the row shows it and refuses a second tap. */
  confirming: boolean;
  onPress: () => void;
  /**
   * Re-read the vault's implementation from the chain.
   *
   * The upgrade itself calls this the moment `upgradeVault` resolves, which is when the RELAYER
   * accepted the transaction, not when it was mined — so that read still sees the old
   * implementation and the row goes on showing the version it just left. Pull to refresh on the
   * Me tab is what actually settles it.
   */
  reload: () => void;
  /** Mount this in the settings page: it is the confirmation the upgrade goes through. */
  sheet: React.ReactNode;
} {
  const {t} = useT();
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = useAssetCatalog(network).find((a) => a.kind === 'stable');
  const vault = useActiveVaultAddress(network);

  const [up, setUp] = useState<VaultUpgrade | null>(null);
  // The network the upgrade was started on: a switch mid-await must not spin the other network's row.
  const [busy, setBusy] = useState<Network | null>(null);
  // The server version catalog, for the upgrade target's release note ("What's new").
  const [catalog, setCatalog] = useState<VaultVersionsCatalog | null>(null);
  useEffect(() => {
    fetchVaultVersions(network).then(setCatalog);
  }, [network]);

  // Cleared first and guarded, so a switch never shows the last network's version — or lets its
  // late answer land on the new one.
  const load = useCallback(() => {
    setUp(null);
    if (!vault) return;
    let live = true;
    checkVaultUpgrade(vault, network).then((u) => live && setUp(u));
    return () => {
      live = false;
    };
  }, [vault, network]);
  useEffect(load, [load]);

  /**
   * The upgrade this screen submitted, while it is still in flight.
   *
   * `busy` only covers the await — and that await ends when the RELAYER accepts, not when the
   * transaction is mined. For the minute after, the implementation on chain is still the old one,
   * so the row re-read it, offered the upgrade again, and a second tap would have paid to submit
   * the same upgrade twice. The pending store already follows every relayed transaction to its
   * receipt, so the row follows that instead of guessing.
   */
  // With its network: the row of every OTHER network has nothing in flight, and showed this one's
  // spinner after a switch until the upgrade was mined.
  const [submitted, setSubmitted] = useState<{hash: string; network: Network} | null>(null);
  const pending = usePending((s) => s.txs);
  const inFlight = submitted != null && pending.some((x) => x.hash === submitted.hash && x.status === 'pending');
  // Once it lands, read the implementation again — the row has been showing the old one.
  useEffect(() => {
    if (submitted && !inFlight) {
      setSubmitted(null);
      load();
    }
  }, [submitted, inFlight, load]);
  const working = busy === network || (inFlight && submitted?.network === network);

  const {ask, sheet} = useConfirmAction();

  const doUpgrade = async () => {
    if (!vault || !stable || !up?.latest) return;
    setBusy(network);
    const tx = showTx(`${t('vault.upgrade_action')} · ${up.latestVersion ?? ''}`.trim(), network);
    try {
      const acct = await getSigner();
      const hash = await upgradeVault({account: acct, vault, network, newImpl: up.latest, stableCoin: stable.address});
      tx.success(hash);
      // Remembered so the row can stay in its confirming state: `upgradeVault` resolves when the
      // RELAYER accepted the transaction, which is before it is mined.
      setSubmitted({hash, network});
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const upgradeable = !!up?.available && !working;
  // The app's own confirmation rather than a system alert, so an upgrade is agreed to the same way
  // every other on-chain action is: a Face ID button with the fee it will cost beside it.
  const onPress = () => {
    if (!upgradeable || !up) return;
    // The release note for the build being upgraded TO (the vault implementation is note-category 0),
    // resolved through the app's own translations from the catalog's i18n stems. Absent note → the
    // prompt is just the version jump, as before.
    const note = upgradeNoteFor(catalog, VAULT_NOTE_CATEGORY, up.latestVersion);
    const whatsNew = note
      ? [t(`vault.${note.titleKey}`), ...note.bulletKeys.map((k) => `• ${t(`vault.${k}`)}`)].join('\n')
      : '';
    ask({
      title: t('vault.upgrade_available'),
      message:
        `${up.currentVersion ?? '?'} → ${up.latestVersion ?? '?'}` +
        (whatsNew ? `\n\n${whatsNew}` : ''),
      gas: relayGasFor({setup: true}),
      run: doUpgrade,
    });
  };

  // Confirming: the row says so and does nothing. Tapping it again would submit a second
  // upgrade to the same implementation.
  if (working) return {value: t('vault.confirming'), upgradeable: false, confirming: true, onPress, reload: load, sheet};
  if (!up) return {upgradeable: false, confirming: false, onPress, reload: load, sheet};
  // Before activation the vault will be born on the guard's latest build, so that is its version.
  const shown = up.currentVersion ?? (!up.current ? up.latestVersion : null);
  const value = up.available && up.latestVersion ? `${shown ?? '?'} → ${up.latestVersion}` : shown ?? t('vault.upgrade_version_unknown');
  /**
   * The only state worth a second line: an update is offered.
   *
   * It also said "not deployed yet" before activation, and that is the app's business rather
   * than the user's. A vault is created by its first action and the version shown is the one it
   * will be born on, so the row is already telling the truth; announcing that nothing exists on
   * chain yet invites a question — do I have to do something? — whose answer is no.
   */
  const sub = up.available ? t('vault.upgrade_available') : undefined;
  return {value, sub, upgradeable, confirming: false, onPress, reload: load, sheet};
}

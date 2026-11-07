import {useState} from 'react';
import type {Address} from 'viem';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useAssetCatalog} from '@/core/asset-catalog';
import {showTx} from '@/components/Toast';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import type {relayVaultWrite} from '@/vault/relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

/** What every relayed vault write takes besides its own arguments. */
export type VaultWriteBase = {account: Acct; vault: Address; network: Network; stableCoin: Address};

/**
 * One owner write on the Security pages: a Face ID step and an estimated fee in front of it (the
 * confirm sheet), a toast that follows it, and `onDone` once it lands so the page re-reads what
 * it changed. `busy` is the key of the write in flight, so a page can show which button is working
 * and hold the rest.
 */
export function useVaultWrite(onDone?: () => void) {
  const getSigner = useWallet((s) => s.signer);
  const unlocked = useWallet((s) => s.unlocked);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = useAssetCatalog(network).find((a) => a.kind === 'stable');
  const vault = useActiveVaultAddress(network);
  const [busy, setBusy] = useState<string | null>(null);
  const {ask, sheet} = useConfirmAction();

  const runNow = async (key: string, title: string, fn: (b: VaultWriteBase) => Promise<string>) => {
    if (!vault || !stable) return;
    setBusy(key);
    const tx = showTx(title, network);
    try {
      const account = await getSigner();
      tx.success(await fn({account, vault, network, stableCoin: stable.address}));
      onDone?.();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  /** `message` is a line of warning on the confirm sheet, for a write that takes something away. */
  const run = (key: string, title: string, fn: (b: VaultWriteBase) => Promise<string>, message?: string) =>
    ask({title, message, gas: relayGasFor({}), run: () => runNow(key, title, fn)});

  /** A write can be offered: the wallet is unlocked, the vault and its fee coin known, nothing in flight. */
  const ready = unlocked && !!vault && !!stable && busy === null;

  /**
   * For a page whose own sheet already carries the fee and the Face ID button (ConfirmButton): the
   * write with no second confirm in front of it. Face ID is still asked, by the signer.
   */
  const runConfirmed = (key: string, title: string, fn: (b: VaultWriteBase) => Promise<string>) => void runNow(key, title, fn);

  return {vault, network, stable, busy, ready, run, runConfirmed, sheet};
}

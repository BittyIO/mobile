/**
 * Which vaults this device's keys own — for the vault list.
 *
 * A key owns the vault the factory put at its own address, and any vault whose ownership has been
 * transferred to it: that one keeps the address its first owner's key derived, so nothing on this
 * phone could know about it. The server keeps track of ownership transfers (web
 * /api/ethereum/vaults/owned-by) and answers which vaults an address owns now.
 *
 * The other direction is read from the chain: a vault on the list that has since been transferred
 * AWAY no longer answers to this device's key, and the list greys it out.
 */
import {useEffect, useState} from 'react';
import {getAddress, parseAbi, type Address} from 'viem';
import {apiFetch, apiUrl, publicClientFor, type Network} from '@/core/chain';
import type {VaultRef} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';

const OWNER_ABI = parseAbi(['function owner() view returns (address)']);

/**
 * On `network`, the vaults `owner` owns, and those handed to it that it has yet to accept (the
 * two-step handover of the vaults deployed today), as the server knows them. Empty when it cannot say.
 */
export async function fetchOwnedVaults(network: Network, owner: Address): Promise<{owned: Address[]; pending: Address[]}> {
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/owned-by/${owner}`, network));
    if (!res.ok) return {owned: [], pending: []};
    const json = (await res.json()) as {vaults?: string[]; pending?: string[]};
    return {owned: (json.vaults ?? []).map((v) => getAddress(v)), pending: (json.pending ?? []).map((v) => getAddress(v))};
  } catch {
    return {owned: [], pending: []};
  }
}

/** A vault's current owner, or null for one not deployed yet (it has no owner but its creator). */
export async function vaultOwnerOf(network: Network, vault: Address): Promise<Address | null> {
  try {
    const client = publicClientFor(network);
    const code = await client.getCode({address: vault});
    if (!code || code === '0x') return null;
    return await client.readContract({address: vault, abi: OWNER_ABI, functionName: 'owner'});
  } catch {
    return null;
  }
}

/** One of this device's keys: its BIP-44 index and address. */
export type DeviceKey = {index: number; address: Address};

/** Every key the list knows of — each created vault's owner, and each Safe or received vault's signer. */
export function deviceKeys(vaults: VaultRef[]): DeviceKey[] {
  const out = new Map<string, DeviceKey>();
  for (const v of vaults) {
    if (!v.safe && !v.vault && v.owner) out.set(v.owner.toLowerCase(), {index: v.index, address: v.owner});
    if ((v.safe || v.vault) && v.signer && v.signerIndex !== undefined) out.set(v.signer.toLowerCase(), {index: v.signerIndex, address: v.signer});
  }
  return [...out.values()];
}

/** A vault for one of this device's keys that is not on the list: owned, or waiting to be accepted. */
export type FoundVault = {vault: Address; key: DeviceKey; pending: boolean};

/**
 * On `network`: the vaults this device's keys own that are not on the list yet, and the list's
 * vaults that no longer answer to this device. Re-read when the list or the chain changes, and on
 * `refreshKey` (a pull).
 */
export function useVaultDirectory(
  network: Network,
  vaults: VaultRef[],
  refreshKey?: unknown,
): {found: FoundVault[]; notYours: Set<number>; transferredTo: Map<number, Address>} {
  const [found, setFound] = useState<FoundVault[]>([]);
  // Each listed vault that no longer answers to this device, with whom it answers to now.
  const [transferredTo, setTransferredTo] = useState<Map<number, Address>>(() => new Map());
  const sig = vaults.map((v) => `${v.index}:${v.owner}:${v.vault ?? ''}:${v.network ?? ''}`).join('|');

  useEffect(() => {
    let live = true;
    (async () => {
      const keys = deviceKeys(vaults);
      const listed = new Set(vaults.map((v) => vaultAddressOf(v, network)?.toLowerCase()).filter(Boolean) as string[]);
      const lists = await Promise.all(keys.map((k) => fetchOwnedVaults(network, k.address)));
      const add: FoundVault[] = [];
      keys.forEach((k, i) => {
        for (const [vaults_, pending] of [[lists[i].owned, false], [lists[i].pending, true]] as const) {
          for (const vault of vaults_) {
            if (listed.has(vault.toLowerCase()) || add.some((f) => f.vault.toLowerCase() === vault.toLowerCase())) continue;
            add.push({vault, key: k, pending});
          }
        }
      });
      // Whose each listed vault is now. A Safe vault answers to the Safe, every other to its key.
      const gone = new Map<number, Address>();
      await Promise.all(
        vaults.map(async (v) => {
          const vault = vaultAddressOf(v, network);
          const expected = v.safe ?? v.owner;
          if (!vault || !expected) return;
          const now = await vaultOwnerOf(network, vault);
          if (now && now.toLowerCase() !== expected.toLowerCase()) gone.set(v.index, now);
        }),
      );
      if (!live) return;
      setFound(add);
      setTransferredTo(gone);
    })();
    return () => {
      live = false;
    };
    // `sig` stands for `vaults`: the same entries are the same work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, sig, refreshKey]);

  return {found, notYours: new Set(transferredTo.keys()), transferredTo};
}

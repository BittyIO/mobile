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

/** The vaults `owner` owns on `network`, as the server knows them. Empty when it cannot say. */
export async function fetchOwnedVaults(network: Network, owner: Address): Promise<Address[]> {
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/owned-by/${owner}`, network));
    if (!res.ok) return [];
    const json = (await res.json()) as {vaults?: string[]};
    return (json.vaults ?? []).map((v) => getAddress(v));
  } catch {
    return [];
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

export type FoundVault = {vault: Address; key: DeviceKey};

/**
 * On `network`: the vaults this device's keys own that are not on the list yet, and the list's
 * vaults that no longer answer to this device. Re-read when the list or the chain changes, and on
 * `refreshKey` (a pull).
 */
export function useVaultDirectory(network: Network, vaults: VaultRef[], refreshKey?: unknown): {found: FoundVault[]; notYours: Set<number>} {
  const [found, setFound] = useState<FoundVault[]>([]);
  const [notYours, setNotYours] = useState<Set<number>>(() => new Set());
  const sig = vaults.map((v) => `${v.index}:${v.owner}:${v.vault ?? ''}:${v.network ?? ''}`).join('|');

  useEffect(() => {
    let live = true;
    (async () => {
      const keys = deviceKeys(vaults);
      const listed = new Set(vaults.map((v) => vaultAddressOf(v, network)?.toLowerCase()).filter(Boolean) as string[]);
      const lists = await Promise.all(keys.map((k) => fetchOwnedVaults(network, k.address)));
      const add: FoundVault[] = [];
      keys.forEach((k, i) => {
        for (const vault of lists[i]) {
          if (listed.has(vault.toLowerCase()) || add.some((f) => f.vault.toLowerCase() === vault.toLowerCase())) continue;
          add.push({vault, key: k});
        }
      });
      // Whose each listed vault is now. A Safe vault answers to the Safe, every other to its key.
      const gone = new Set<number>();
      await Promise.all(
        vaults.map(async (v) => {
          const vault = vaultAddressOf(v, network);
          const expected = v.safe ?? v.owner;
          if (!vault || !expected) return;
          const now = await vaultOwnerOf(network, vault);
          if (now && now.toLowerCase() !== expected.toLowerCase()) gone.add(v.index);
        }),
      );
      if (!live) return;
      setFound(add);
      setNotYours(gone);
    })();
    return () => {
      live = false;
    };
    // `sig` stands for `vaults`: the same entries are the same work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, sig, refreshKey]);

  return {found, notYours};
}

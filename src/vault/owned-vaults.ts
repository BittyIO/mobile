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
import {getAddress, parseAbi, type Address, type Hex} from 'viem';
import {apiFetch, apiUrl, publicClientFor, type Network} from '@/core/chain';
import {keyIndexOf, type VaultRef} from '@/core/vault-store';
import {keyPathOf} from '@/wallet/rotation-store';
import {vaultAddressOf} from '@/core/active-vault';
import {vaultGuard} from '@/core/vault-contracts';
import {VAULT_RISK_ABI} from '@/core/abi';
import {vaultProxyRuntimeCode} from '@/core/predict-vault';

const OWNER_ABI = parseAbi(['function owner() view returns (address)']);
const GUARD_REGISTRY_ABI = parseAbi(['function isImplementationRegisteredFor(address implementation, uint8 category) view returns (bool)']);
/** ERC-1967's implementation slot. */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const VAULT_CATEGORY = 1;

/**
 * Whether `vault` is a real Bitty vault that answers to `key` — checked on chain, because the list
 * it came from is the server's. A tampered list could otherwise slip in a contract that only looks
 * like a vault (or someone else's vault) for the user to fund. Real means: the factory's proxy code,
 * pointing at an implementation the guard registers, and owned by `key` — or, for a handover still
 * waiting, queued to `key`.
 */
export async function isGenuineVaultFor(network: Network, vault: Address, key: Address, pending: boolean): Promise<boolean> {
  try {
    const client = publicClientFor(network);
    const [code, slot] = await Promise.all([client.getCode({address: vault}), client.getStorageAt({address: vault, slot: IMPL_SLOT})]);
    if (!code || code.toLowerCase() !== vaultProxyRuntimeCode(network).toLowerCase() || !slot) return false;
    const impl = getAddress(`0x${slot.slice(-40)}` as Hex);
    const registered = await client.readContract({
      address: vaultGuard(network),
      abi: GUARD_REGISTRY_ABI,
      functionName: 'isImplementationRegisteredFor',
      args: [impl, VAULT_CATEGORY],
    });
    if (!registered) return false;
    if (!pending) {
      const owner = await client.readContract({address: vault, abi: OWNER_ABI, functionName: 'owner'});
      return owner.toLowerCase() === key.toLowerCase();
    }
    const p = await client.readContract({address: vault, abi: VAULT_RISK_ABI, functionName: 'pendingChanges'});
    return p.newOwnerReadyAt > 0n && p.newOwner.toLowerCase() === key.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * On `network`, the vaults `owner` owns, those handed to it that it has yet to accept (older
 * vaults' two-step handover), and those transferred to it that are still waiting out the vault's
 * timelock (`queued`, with when they become its), as the server knows them. Empty when it cannot say.
 *
 * `queued` was not read at all, so a vault transferred to this phone was missing from the list for
 * the whole timelock — days — and appeared only once `owner()` had switched.
 */
export async function fetchOwnedVaults(
  network: Network,
  owner: Address,
): Promise<{owned: Address[]; pending: Address[]; queued: {vault: Address; readyAt: number}[]}> {
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/owned-by/${owner}`, network));
    if (!res.ok) return {owned: [], pending: [], queued: []};
    const json = (await res.json()) as {vaults?: string[]; pending?: string[]; queued?: {vault: string; readyAt: number}[]};
    return {
      owned: (json.vaults ?? []).map((v) => getAddress(v)),
      pending: (json.pending ?? []).map((v) => getAddress(v)),
      queued: (json.queued ?? []).map((q) => ({vault: getAddress(q.vault), readyAt: Number(q.readyAt)})),
    };
  } catch {
    return {owned: [], pending: [], queued: []};
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
export type FoundVault = {vault: Address; key: DeviceKey; pending: boolean; /** Transferred, and this key's from then (unix seconds). */ readyAt?: number};

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
        // A transfer still in its timelock is checked the way a handover waiting to be accepted is:
        // queued to this key in the vault's pendingChanges.
        const queued = lists[i].queued.map((q) => q.vault);
        for (const [vaults_, pending] of [[lists[i].owned, false], [lists[i].pending, true], [queued, true]] as const) {
          for (const vault of vaults_) {
            if (listed.has(vault.toLowerCase()) || add.some((f) => f.vault.toLowerCase() === vault.toLowerCase())) continue;
            add.push({vault, key: k, pending});
          }
        }
      });
      // Only what the chain confirms is shown: the server only suggested these.
      const ok = await Promise.all(add.map((f) => isGenuineVaultFor(network, f.vault, f.key.address, f.pending)));
      const confirmed = add.filter((_, i) => ok[i]);
      // Whose each listed vault is now. A Safe vault answers to the Safe, every other to its key.
      const gone = new Map<number, Address>();
      await Promise.all(
        vaults.map(async (v) => {
          const vault = vaultAddressOf(v, network);
          const expected = v.safe ?? v.owner;
          if (!vault || !expected) return;
          const now = await vaultOwnerOf(network, vault);
          // Handed to one of its own key's one-time keys (quantum-safe keys): still this phone's.
          const ownKey = !v.safe && !!now && keyPathOf(now)?.index === keyIndexOf(v);
          if (now && now.toLowerCase() !== expected.toLowerCase() && !ownKey) gone.set(v.index, now);
        }),
      );
      if (!live) return;
      setFound(confirmed);
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

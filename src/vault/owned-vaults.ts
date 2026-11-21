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
import {apiFetch, apiUrl, isTronNetwork, publicClientFor, type Network} from '@/core/chain';
import {IMPORTED_SECTION, keyIndexOf, phraseOf, type VaultRef} from '@/core/vault-store';
import {isKeyOf, keyPathOf, useRotationStore} from '@/wallet/rotation-store';
import {vaultAddressOf} from '@/core/active-vault';
import {vaultGuard} from '@/core/vault-contracts';
import {VAULT_RISK_ABI} from '@/core/abi';
import {predictVaultAddressOn, vaultProxyRuntimeCode} from '@/core/predict-vault';

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

const BALANCE_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
const MULTICALL3_ABI = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)']);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

/** One scan per network, account and set of keys and coins, shared while it runs and for a minute after. */
const ONE_TIME_TTL_MS = 60_000;
const oneTimeCache = new Map<string, {at: number; result: Promise<{vault: Address; key: Address}[]>}>();

/**
 * On `network`, the vaults of account `index`'s one-time keys (quantum-safe keys): each key's own
 * vault, the one the factory derives from it, when it is deployed and still owned by that key, or
 * not deployed yet but already holding one of `tokens`.
 *
 * The second kind is where a bridge out of a quantum-safe vault lands. The bridge pays out to the
 * vault of the vault's CURRENT owner on the destination chain, which is a one-time key; that key's
 * vault there has usually never been created, so the server has never heard of it and nothing
 * lists it. Nothing here is the server's: the address is computed on the phone from a key of this
 * phrase, and its owner and balances are read from the chain.
 *
 * Only the one-time keys this phone has derived are checked (wallet/rotation `learnKeys` derives the
 * first few after an unlock, and every key that has signed is among them). `phrase` is the
 * vault-store phrase id, 'main' for the main phrase. `tokens` should be what a bridge can pay out
 * (the stablecoins and the wrapped native coin), not the whole catalog.
 *
 * All of it is ONE multicall (a few eth_calls at most): each key's vault `owner()`, its native
 * balance and its balance of every token. It used to be a getCode, a getBalance and a balanceOf per
 * token for every key, all at once — thousands of requests for a phone with a few accounts, which
 * froze the JS thread and got the public nodes rate-limiting every other screen's reads too. An
 * `owner()` that fails is a vault with no code yet. Tron, which has no bridge, is not scanned.
 * `force` skips the minute's cache (a pull to refresh).
 */
export function fetchOneTimeKeyVaults(
  network: Network,
  index: number,
  phrase: string,
  tokens: Address[],
  force = false,
): Promise<{vault: Address; key: Address}[]> {
  if (isTronNetwork(network)) return Promise.resolve([]);
  const keys = Object.entries(useRotationStore.getState().keys)
    .filter(([, p]) => isKeyOf(p, index, phrase))
    .map(([address]) => getAddress(address));
  if (keys.length === 0) return Promise.resolve([]);
  const id = `${network}|${index}|${phrase}|${keys.join(',')}|${tokens.join(',')}`;
  const hit = oneTimeCache.get(id);
  if (hit && !force && Date.now() - hit.at < ONE_TIME_TTL_MS) return hit.result;
  const result = scanOneTimeKeys(network, keys, tokens).catch(() => {
    // A failed scan is not kept: the next open asks again.
    if (oneTimeCache.get(id)?.result === result) oneTimeCache.delete(id);
    return [] as {vault: Address; key: Address}[];
  });
  oneTimeCache.set(id, {at: Date.now(), result});
  return result;
}

async function scanOneTimeKeys(network: Network, keys: Address[], tokens: Address[]): Promise<{vault: Address; key: Address}[]> {
  const vaults = keys.map((key) => predictVaultAddressOn(network, key));
  const per = 2 + tokens.length;
  const contracts = vaults.flatMap((vault) => [
    {address: vault, abi: OWNER_ABI, functionName: 'owner'} as const,
    // Across pays WETH routes out as the native coin, so that is looked at too.
    {address: MULTICALL3, abi: MULTICALL3_ABI, functionName: 'getEthBalance', args: [vault]} as const,
    ...tokens.map((token) => ({address: token, abi: BALANCE_ABI, functionName: 'balanceOf', args: [vault]}) as const),
  ]);
  // Big chunks, so the whole scan is one or two requests rather than viem's default of many small ones.
  const res = await publicClientFor(network).multicall({contracts, allowFailure: true, batchSize: 16_384});
  const found: {vault: Address; key: Address}[] = [];
  keys.forEach((key, i) => {
    const at = res.slice(i * per, (i + 1) * per);
    const owner = at[0];
    if (owner?.status === 'success') {
      // Deployed: listed only while this key still owns it.
      if (String(owner.result).toLowerCase() === key.toLowerCase()) found.push({vault: vaults[i], key});
      return;
    }
    if (at.slice(1).some((r) => r.status === 'success' && typeof r.result === 'bigint' && r.result > 0n)) found.push({vault: vaults[i], key});
  });
  return found;
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

/** One of this device's keys: its BIP-44 index on its recovery phrase (`phrase` 'imported' for an imported private key, index 0), and address. */
export type DeviceKey = {index: number; address: Address; phrase: string};

/** Every key the list knows of — each created vault's owner, and each Safe or received vault's signer. */
export function deviceKeys(vaults: VaultRef[]): DeviceKey[] {
  const out = new Map<string, DeviceKey>();
  for (const v of vaults) {
    // An imported private key: no phrase and no index; it signs by its address alone.
    if (v.imported && !v.safe) {
      const key = v.signer ?? v.owner;
      if (key) out.set(key.toLowerCase(), {index: 0, address: key, phrase: IMPORTED_SECTION});
      continue;
    }
    if (!v.safe && !v.vault && v.owner) out.set(v.owner.toLowerCase(), {index: keyIndexOf(v), address: v.owner, phrase: phraseOf(v)});
    if ((v.safe || v.vault) && v.signer && v.signerIndex !== undefined) out.set(v.signer.toLowerCase(), {index: v.signerIndex, address: v.signer, phrase: phraseOf(v)});
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
          const ownKey = !v.safe && !!now && isKeyOf(keyPathOf(now), keyIndexOf(v), phraseOf(v));
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

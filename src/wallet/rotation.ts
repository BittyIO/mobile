/**
 * Quantum-safe keys: a vault that hands itself to a fresh key every time its key signs.
 *
 * An address is a hash of a public key, and a hash is all a quantum computer would get from an
 * address that has never signed. The moment a key signs — a relayed vault write, an order, any
 * signature that is published — its public key can be read back from the signature, and a large
 * enough quantum computer could work the private key out from that. So a key that has signed is
 * retired: the same transaction that carries the operation queues `transferOwnership` to the next
 * one-time key of the same phrase (see keyring `oneTimeKeys`), one that has never signed anything.
 *
 * App-only. The vault's own handover is timelocked like every other loosening, so the key that
 * signed stays in charge until the wait has run, and only then does `owner()` answer with the new
 * one; the next operation is signed by the new key, and hands over again. One handover per key: while
 * one is waiting nothing is queued on top of it, because queueing again restarts the wait — and a
 * vault in daily use would never finish one.
 *
 * Nothing here is trusted to the phone alone. Before a key is handed the vault, the chain is asked
 * whether it has ever been used: a transaction sent from it on any network, code at it, a relayed
 * request signed by it for this vault, a vault already owned by or queued to it. What no chain can
 * show is a signature made off chain somewhere else, which is why the page that turns this on says
 * the phrase must not be used in any other wallet.
 */
import type {Address, LocalAccount} from 'viem';
import type {HDKey} from 'viem/accounts';
import {publicClientFor, type Network} from '@/core/chain';
import {NETWORKS} from '@/core/network-store';
import {FORWARDER_ABI, VAULT_FWD_ABI} from '@/core/abi';
import type {Signer} from './signer';
import {accountAt, oneTimeKeys} from './keyring';
import {
  bumpNextKey,
  keyPathOf,
  markUsed,
  nextKeyOf,
  rememberKeys,
  rotationOn,
  wasUsed,
} from './rotation-store';
import {fetchOwnedVaults, vaultOwnerOf} from '@/vault/owned-vaults';
import {getLockLevel, getPendingChanges} from '@/vault/risk';
import {fetchRecentOrders, isOrderOpen} from '@/vault/limit';
import {fetchTwapSchedules} from '@/vault/twap';
import {fetchUniswapXOrders} from '@/vault/uniswapx';

/** How far past the last key handed out a scan for the vault's owner looks, after a restore. */
const SCAN = 24;
/** Keys tried in a row before giving up on finding a fresh one; each one rejected is skipped for good. */
const TRIES = 6;

/**
 * Why a write that should have handed the vault on does not.
 *
 * - `pending`: a handover is already waiting out the timelock (ours, or one the owner started).
 * - `locked`: a locked vault refuses `transferOwnership`, and would refuse the operation with it.
 * - `orders`: an open limit or recurring order. The vault checks such an order's signature against
 *   its owner when it fills, so handing over would quietly stop it filling.
 * - `no-fresh`: every key tried had been used somewhere.
 * - `unreachable`: the chain could not be asked, and a key that was not checked is not handed the vault.
 */
export type RotationHold = 'pending' | 'locked' | 'orders' | 'no-fresh' | 'unreachable';
export type RotationPlan = {to: Address} | {held: RotationHold};

/**
 * Anything this key signs marks it used, whatever asked for the signature: the record the Security
 * page reads, and one more reason never to hand the vault to it again.
 */
function tracked(a: LocalAccount): Signer & LocalAccount {
  return {
    ...a,
    signTypedData: ((p: Parameters<LocalAccount['signTypedData']>[0]) => {
      markUsed(a.address);
      return a.signTypedData(p);
    }) as LocalAccount['signTypedData'],
    signTransaction: ((tx: Parameters<LocalAccount['signTransaction']>[0], o?: Parameters<LocalAccount['signTransaction']>[1]) => {
      markUsed(a.address);
      return a.signTransaction(tx, o);
    }) as LocalAccount['signTransaction'],
    signMessage: ((p: Parameters<LocalAccount['signMessage']>[0]) => {
      markUsed(a.address);
      return a.signMessage(p);
    }) as LocalAccount['signMessage'],
  };
}

/**
 * The one-time key of account `index` that is `owner`, if it is one.
 *
 * Known keys are looked up; otherwise the keys are walked from the first, which is how a phone that
 * was restored from the phrase — and has no record of which key the vault was last handed — finds it.
 */
function findOwnerKey(root: HDKey, index: number, owner: Address): LocalAccount | null {
  const key = oneTimeKeys(root, index);
  const known = keyPathOf(owner);
  if (known && known.index === index) return key(known.k);
  const seen: {address: string; index: number; k: number}[] = [];
  let found: LocalAccount | null = null;
  for (let k = 0; k < nextKeyOf(index) + SCAN && !found; k++) {
    const a = key(k);
    seen.push({address: a.address, index, k});
    if (a.address.toLowerCase() === owner.toLowerCase()) {
      found = a;
      bumpNextKey(index, k + 1);
    }
  }
  rememberKeys(seen);
  return found;
}

/**
 * Whether `address` has never been seen to sign anything, on any chain this app knows.
 *
 * On the vault's own network every check must answer, or it throws: a key is not handed the vault
 * on a guess. Elsewhere an unreachable chain is not held against it — that is a network this vault
 * does not live on, and the key's branch of the phrase is one no other wallet uses.
 */
async function isFresh(address: Address, network: Network, vault: Address): Promise<boolean> {
  if (wasUsed(address)) return false;
  const here = publicClientFor(network);
  const forwarder = await here.readContract({address: vault, abi: VAULT_FWD_ABI, functionName: 'trustedForwarder'});
  const [sent, code, lane, owned] = await Promise.all([
    here.getTransactionCount({address}),
    here.getCode({address}),
    here.readContract({address: forwarder, abi: FORWARDER_ABI, functionName: 'nonceFor', args: [address, vault]}),
    fetchOwnedVaults(network, address),
  ]);
  if (sent > 0 || (code && code !== '0x') || lane > 0n || owned.owned.length > 0 || owned.pending.length > 0) return false;
  const elsewhere = await Promise.all(
    NETWORKS.filter((n) => n !== network).map((n) =>
      publicClientFor(n)
        .getTransactionCount({address})
        .catch(() => 0),
    ),
  );
  return elsewhere.every((n) => n === 0);
}

/** An open limit order, or a recurring order still running. */
export async function hasOpenOrders(vault: Address, network: Network): Promise<boolean> {
  const [orders, ux, twaps] = await Promise.all([
    fetchRecentOrders(vault, network).catch(() => []),
    fetchUniswapXOrders(vault, network).catch(() => []),
    fetchTwapSchedules(vault, network),
  ]);
  return orders.some(isOrderOpen) || ux.some(isOrderOpen) || twaps.some((s) => s.status === 'active');
}

/** The next fresh one-time key of account `index`, or null when none of the next few is. */
async function pickFresh(root: HDKey, index: number, network: Network, vault: Address): Promise<Address | null> {
  const key = oneTimeKeys(root, index);
  for (let i = 0; i < TRIES; i++) {
    const k = nextKeyOf(index);
    const a = key(k);
    // Handed out now, whatever happens next: the key is never offered to anything again.
    bumpNextKey(index, k + 1);
    rememberKeys([{address: a.address, index, k}]);
    if (await isFresh(a.address, network, vault)) return a.address;
  }
  return null;
}

/** Whether this write should hand the vault on, and to whom. */
async function plan(root: HDKey, index: number, network: Network, vault: Address): Promise<RotationPlan> {
  try {
    const [pending, lock, orders] = await Promise.all([
      getPendingChanges(vault, network),
      getLockLevel(vault, network),
      hasOpenOrders(vault, network),
    ]);
    if (pending.some((p) => p.kind === 'newOwner')) return {held: 'pending'};
    if (lock !== 0) return {held: 'locked'};
    if (orders) return {held: 'orders'};
    const to = await pickFresh(root, index, network, vault);
    return to ? {to} : {held: 'no-fresh'};
  } catch {
    return {held: 'unreachable'};
  }
}

/**
 * The key that signs for `vault` on `network`: whichever key of account `index` owns it now — the
 * account's own key, or the one-time key it was last handed — with the handover to plan for this
 * write when the vault uses quantum-safe keys.
 *
 * The owner is read from the chain every time, not remembered: the handover finishes on its own
 * when the timelock runs, with nothing on this phone to tell it so.
 */
export async function vaultSigner(o: {root: HDKey; index: number; network: Network; vault: Address}): Promise<Signer> {
  const base = accountAt(o.root, o.index);
  const owner = await vaultOwnerOf(o.network, o.vault);
  let key: LocalAccount = base;
  if (owner && owner.toLowerCase() !== base.address.toLowerCase()) {
    const found = findOwnerKey(o.root, o.index, owner);
    // Owned by one of this phrase's one-time keys — an earlier handover, or a phone restored from
    // the phrase. That key signs; the SETTING is left as the owner set it. It used to be switched on
    // here, which turned quantum-safe on for a vault and network nobody had chosen it for: it is off
    // until the owner turns it on, per network and vault (see {useRotationOn}).
    if (found) key = found;
  }
  const signer = tracked(key);
  // Not deployed yet: the first write activates it, which is signed by the account's own key.
  if (!owner || !rotationOn(o.network, o.vault)) return signer;
  return {...signer, rotation: await plan(o.root, o.index, o.network, o.vault)};
}

/** Whether `address` is the account's own key or one of its one-time keys, as far as this phone knows. */
export function isOwnKey(address: string | null | undefined, base: string | null | undefined): boolean {
  if (!address) return false;
  return address.toLowerCase() === base?.toLowerCase() || keyPathOf(address) != null;
}

/**
 * Derive the first one-time keys of each account, so they are recognised without the phrase.
 *
 * Run in the background after an unlock. A restored phone has no record of them, and the vault list
 * would otherwise show a vault owned by one as handed to a stranger until its first write.
 */
export function learnKeys(root: HDKey, indexes: number[]): void {
  const queue = [...new Set(indexes)];
  const step = () => {
    const index = queue.shift();
    if (index === undefined) return;
    const key = oneTimeKeys(root, index);
    const upTo = nextKeyOf(index) + 8;
    const out = [];
    for (let k = 0; k < upTo; k++) out.push({address: key(k).address, index, k});
    rememberKeys(out);
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

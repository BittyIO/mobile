import {useEffect} from 'react';
import {AppState} from 'react-native';
import {decodeFunctionData, encodeFunctionData, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_MANAGE_ABI, VAULT_MULTICALL_ABI, VAULT_UPGRADE_ABI} from '@/core/abi';
import {autoUpgradeProtocol, autoUpgradeVault} from '@/core/auto-upgrade-store';
import {checkVaultUpgrade} from './manage';
import {adapterStatuses, type AdapterStatus} from './upgrade-adapter';
import {canRunVault, forgetVaultVersion, vaultFunctionName} from './vault-abi';
import {useActiveVaultAddress} from '@/core/active-vault';

/**
 * The upgrades an operation carries in front of itself, when Auto upgrade is on (see
 * core/auto-upgrade-store).
 *
 * The vault first: `upgrade(newImpl)` swaps the implementation, and because `multicall` runs each
 * call through the vault's own address, every call after it in the same batch already runs on the
 * new code. Then each protocol the operation USES — an adapter whose address appears in its calls —
 * (or that the caller names in `uses`, for a write that prepares an off-chain order on it)
 * that has a newer build of its lineage: `upgradeProtocol` moves the clone, `updateProtocols` swaps
 * the allow-list entry, exactly as the manual upgrade does (see {upgradeAdapter}). Then the
 * operation itself.
 *
 * Left off, and the operation sent as it is, when:
 *   - the vault is locked — an upgrade reverts under any lock, and would take the operation with it;
 *   - the newer vault build is one this app cannot run — upgrading would lock the owner out of
 *     their own vault until the app was updated;
 *   - the operation is itself an upgrade;
 *   - the batch does not simulate. A call built against the old release can disagree with the new
 *     one, and the operation is what the user asked for: the upgrade rides on a later one.
 */

/**
 * Read when the app opens, comes back to the foreground, or switches vault or network — never on a
 * write. Reading here on every write was three chain reads in a row in front of each transaction's
 * signature. An upgrade released while the app is open rides on the first write after its next
 * opening instead.
 */
type Plan = {vault: {latest: Address} | null; protocols: AdapterStatus[]};
const plans = new Map<string, Plan>();
const planKey = (network: Network, vault: Address) => `${network}:${vault.toLowerCase()}`;

/**
 * An operation has just carried upgrades: nothing is due again until the chain has caught up.
 *
 * Without this the next write, a few seconds later and before the first is mined, would read the
 * vault as still behind and send the same upgrade a second time — which reverts as not newer, and
 * takes the operation with it into the fallback. The plan reads afresh after its TTL, by when the
 * upgrade has landed, and the running version is dropped then too, so the ABI follows the new
 * release.
 */
export function upgradeSent(vault: Address, network: Network): void {
  plans.set(planKey(network, vault), {vault: null, protocols: []});
  // By when the upgrade has landed: the ABI follows the new release from then on.
  setTimeout(() => forgetVaultVersion(vault, network), 60_000);
}

/** Read the vault's due upgrades now, for the writes that follow. Never throws. */
export async function refreshUpgradePlan(vault: Address, network: Network): Promise<void> {
  const [up, statuses] = await Promise.all([
    checkVaultUpgrade(vault, network).catch(() => null),
    adapterStatuses(vault, network).catch(() => [] as AdapterStatus[]),
  ]);
  const runnable = up?.available && up.latest && up.latestVersion ? await canRunVault(up.latestVersion, network) : false;
  plans.set(planKey(network, vault), {
    vault: runnable && up?.latest ? {latest: up.latest} : null,
    protocols: statuses.filter((s) => s.upgrade),
  });
}

/** Keeps the vault in front's upgrade plan read: on open, on returning to the app, on a switch. */
export function useAutoUpgradePlan(network: Network): void {
  const vault = useActiveVaultAddress(network);
  useEffect(() => {
    if (!vault) return;
    void refreshUpgradePlan(vault, network).catch(() => {});
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refreshUpgradePlan(vault, network).catch(() => {});
    });
    return () => sub.remove();
  }, [vault, network]);
}

/** The calls inside `data`: a multicall's own list, or the one call it is. */
function callsOf(data: Hex): readonly Hex[] {
  try {
    const d = decodeFunctionData({abi: VAULT_MULTICALL_ABI, data});
    if (d.functionName === 'multicall') return d.args[0];
  } catch {
    // Not a multicall.
  }
  return [data];
}

const UPGRADE_FUNCTIONS = new Set(['upgrade', 'upgradeProtocol']);

/** Does any call name `address` as an argument (a 32-byte word holding it)? */
const mentions = (calls: readonly Hex[], address: string) => {
  const word = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return calls.some((c) => c.toLowerCase().includes(word));
};

/**
 * `data` with the due upgrades in front, as one multicall — or `data` unchanged when there are
 * none, or they cannot ride. `lockLevel` is the one the write path has just read.
 */
export async function withAutoUpgrades(o: {
  vault: Address;
  network: Network;
  from: Address;
  data: Hex;
  lockLevel: number | null;
  /** Adapters the operation runs on without a call naming them: a CoW order's setup. */
  uses?: readonly Address[];
}): Promise<{data: Hex; upgraded: boolean}> {
  const {vault, network} = o;
  const unchanged = {data: o.data, upgraded: false};
  if (o.lockLevel !== 0) return unchanged;
  const calls = callsOf(o.data);
  const named = new Set((o.uses ?? []).map((a) => a.toLowerCase()));
  const uses = (address: string) => named.has(address.toLowerCase()) || mentions(calls, address);
  if (calls.some((c) => UPGRADE_FUNCTIONS.has(vaultFunctionName(c) ?? ''))) return unchanged;

  const vaultOn = autoUpgradeVault(network, vault);
  // Only what was read at opening; nothing is asked of the chain here. Not read yet, no upgrades.
  const plan = plans.get(planKey(network, vault));
  if (!plan) return unchanged;

  const front: Hex[] = [];
  if (vaultOn && plan.vault) {
    front.push(encodeFunctionData({abi: VAULT_MANAGE_ABI, functionName: 'upgrade', args: [plan.vault.latest]}));
  }
  for (const s of plan.protocols) {
    const u = s.upgrade!;
    if (!autoUpgradeProtocol(network, vault, s.lineage)) continue;
    if (!s.addresses.some(uses)) continue;
    front.push(encodeFunctionData({abi: VAULT_UPGRADE_ABI, functionName: 'upgradeProtocol', args: [u.oldProtocol, u.newImpl]}));
    // The old entry is dropped from the allow list only when this operation does not call it by
    // that address — on a restricted vault, dropping it first would refuse the very call behind it.
    const same = u.oldProtocol.toLowerCase() === u.newImpl.toLowerCase();
    const drop = !same && !uses(u.oldProtocol) ? [u.oldProtocol] : [];
    front.push(encodeFunctionData({abi: VAULT_UPGRADE_ABI, functionName: 'updateProtocols', args: [[u.newImpl], drop]}));
  }
  if (front.length === 0) return unchanged;

  const data = encodeFunctionData({abi: VAULT_MULTICALL_ABI, functionName: 'multicall', args: [[...front, ...calls]]});
  const ok = await publicClientFor(network)
    .estimateGas({account: o.from, to: vault, data})
    .then(() => true, () => false);
  return ok ? {data, upgraded: true} : unchanged;
}

/**
 * Register a protocol adapter on the vault before an operation routes through it — the mobile equivalent
 * of the web's `ensureAmmProtocol` / `ensureIntentProtocol`.
 *
 * Why it matters:
 *  - A market swap's guard requires the AMM adapter to be a listed protocol, or `marketSell`/`marketBuy`
 *    reverts.
 *  - Registering an INTENT adapter is what makes the vault CLONE it. The clone is the contract CoW calls
 *    `isValidSignature` on, so without it a limit/TWAP order can't validate and CoW rejects it — and
 *    `approveIntentRelayer` reverts too.
 *
 * The registration is relayed gaslessly like every other write. On an un-activated vault it rides on
 * activation (relayVaultWrite runs it as the activation `calls`). Idempotent: a no-op when already listed.
 */
import {type Address} from 'viem';
import type {Signer} from '@/wallet/signer';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_REGISTRY_ABI, VAULT_MANAGE_ABI} from '@/core/abi';
import {isActivated} from './activate';
import {relayVaultWrite} from './relay';

export async function ensureProtocolRegistered(o: {
  account: Signer;
  vault: Address;
  network: Network;
  adapter: Address;
  stableCoin: Address;
}): Promise<void> {
  // Only an already-deployed vault can be read; a fresh one has no code yet, so skip straight to the
  // relay (which activates the vault and runs the registration as its `calls`).
  if (await isActivated(o.vault, o.network)) {
    // Asked per address: the current vault keeps no readable protocol list (the legacy `getProtocols`
    // reverts on it, which used to make every call here register the adapter again).
    try {
      const registered = (await publicClientFor(o.network).readContract({
        address: o.vault,
        abi: VAULT_MANAGE_ABI,
        functionName: 'isProtocolAllowed',
        args: [o.adapter],
      })) as boolean;
      if (registered) return; // already registered
    } catch {
      // Couldn't read (lagging node) — register anyway; the add is idempotent.
    }
  }

  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_REGISTRY_ABI,
    functionName: 'updateProtocols',
    args: [[o.adapter], []],
    stableCoin: o.stableCoin,
  });
  // Wait for the registration to be mined — the swap/approve that follows would otherwise race it and
  // revert ("protocol not registered" / missing intent clone). Relaying an activated vault returns as
  // soon as the relayer submits, so the wait is on us.
  await publicClientFor(o.network).waitForTransactionReceipt({hash});
}

/**
 * On-chain setup a trade needs when the vault's RESTRICTED ALLOWLIST is on: the sell/buy assets and the
 * routing adapter must be listed on the vault, or the operation reverts (`NotRegistered` for an unlisted
 * asset, `InvalidAMMProtocol` for an unregistered adapter). Ported from the web's `setupCallsFor`.
 *
 * Returns the `updateAssets` / `updateProtocols` calls for whatever's missing — assets FIRST, because the
 * operation that follows validates its asset and multicall preserves order. The caller bundles these ahead
 * of the trade in one `vault.multicall` (one signature). Empty when nothing's needed: `isAssetAllowed`
 * answers `true` when the allowlist is off, and a protocol already in `getProtocols` is skipped — so an
 * unrestricted vault pays nothing here.
 */
import {type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_REGISTRY_ABI, VAULT_MANAGE_ABI} from '@/core/abi';
import type {VaultCall} from './relay';

export async function buildSetupCalls(o: {
  network: Network;
  vault: Address;
  adapter: Address;
  tokens: Address[];
}): Promise<VaultCall[]> {
  const client = publicClientFor(o.network);
  // Dedupe the tokens (sell/buy can repeat across calls).
  const seen = new Set<string>();
  const tokens = o.tokens.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const [allowed, registered] = await Promise.all([
    Promise.all(
      tokens.map((t) =>
        client
          .readContract({address: o.vault, abi: VAULT_MANAGE_ABI, functionName: 'isAssetAllowed', args: [t]})
          .then((v) => v as boolean)
          .catch(() => true), // read failed → assume allowed (don't add a possibly-duplicate asset)
      ),
    ),
    // The current vault has no protocol list to read; it answers per address. (Reading the legacy
    // `getProtocols` here reverted on every 1.0 vault, the catch answered "none registered", and
    // every trade re-registered the adapter — one "Enable Uniswap V3" per trade in the history.)
    client
      .readContract({address: o.vault, abi: VAULT_MANAGE_ABI, functionName: 'isProtocolAllowed', args: [o.adapter]})
      .then((v) => v as boolean)
      .catch(() => true), // read failed → assume registered, as with the assets above
  ]);

  const calls: VaultCall[] = [];
  const missingAssets = tokens.filter((_, i) => allowed[i] === false);
  if (missingAssets.length) calls.push({abi: VAULT_MANAGE_ABI, functionName: 'updateAssets', args: [missingAssets, []]});

  if (!registered) calls.push({abi: VAULT_REGISTRY_ABI, functionName: 'updateProtocols', args: [[o.adapter], []]});

  return calls;
}

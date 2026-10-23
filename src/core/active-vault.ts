import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {useVaults, type VaultRef} from '@/core/vault-store';
import {ownerVaultAddress} from '@/vault/read';

/**
 * The address of a listed vault on `network`.
 *
 * Almost always the one the factory derives from its owner — the same on every chain the
 * factory is deployed on — so it is computed, not stored. A vault received by an ownership
 * transfer is the exception: it keeps its first owner's address, and exists only on the chain it
 * was received on; anywhere else it is null.
 */
export function vaultAddressOf(v: VaultRef | undefined, network: Network): Address | null {
  if (!v) return null;
  if (v.vault) return v.network === network ? v.vault : null;
  return v.owner ? ownerVaultAddress(v.owner, network) : null;
}

const activeRef = (s: ReturnType<typeof useVaults.getState>) => s.vaults.find((v) => v.index === s.activeIndex);

/** The vault in front on `network`, read now — for code that is not a component. */
export function activeVaultAddress(network: Network): Address | null {
  return vaultAddressOf(activeRef(useVaults.getState()), network);
}

/** The vault in front on `network`, as a subscription: every screen's "which vault" goes through this. */
export function useActiveVaultAddress(network: Network): Address | null {
  const v = useVaults(activeRef);
  return vaultAddressOf(v, network);
}

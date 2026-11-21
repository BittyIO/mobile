import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {useNetwork} from '@/core/network-store';
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

/**
 * The vault in front follows its address from chain to chain. A vault received by a transfer is
 * listed as an entry of its own, for the chain it was received on only; elsewhere the same address
 * is still its first owner's, under that owner's entry. Chosen on one chain, the received entry had
 * no vault anywhere else, and every other chain's screens waited on an address that never came.
 *
 * So on each chain the vault in front is the entry that HAS that address there: the received entry
 * on the chain it was received on, the first owner's everywhere else. A vault with no other entry
 * on the phone stays as it is.
 */
export function followActiveVault(network: Network): void {
  const {vaults, activeIndex, select} = useVaults.getState();
  const v = vaults.find((x) => x.index === activeIndex);
  if (!v) return;
  // The address it stands for: a received vault's own; any other, its owner's on this chain.
  const at = (v.vault ?? vaultAddressOf(v, network))?.toLowerCase();
  if (!at) return;
  const here = vaults.filter((x) => vaultAddressOf(x, network)?.toLowerCase() === at);
  // Received on this chain wins: there the first owner's key no longer owns it.
  const pick = here.find((x) => !!x.vault) ?? here.find((x) => x.index === activeIndex) ?? here[0];
  if (pick && pick.index !== activeIndex) select(pick.index);
}

followActiveVault(useNetwork.getState().network);
useNetwork.subscribe((s, prev) => {
  if (s.network !== prev.network) followActiveVault(s.network);
});

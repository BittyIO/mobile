import type {Address} from 'viem';
import {useWallet} from '@/wallet/store';
import {useVaults} from '@/core/vault-store';
import {useFeePayer, type FeePayer} from '@/core/fee-payer-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import type {Network} from '@/core/chain';
import {useRotationOn} from '@/wallet/rotation-store';

/**
 * Who pays the network fee for the vault in front, and whether that is the owner's to choose.
 *
 * A Safe-owned vault has no choice: the Safe is a contract and sends no transactions of its own, so
 * its writes always go through the relayer and the vault always pays. Nor has a vault on quantum-safe
 * keys: its key changes with every operation and none of them holds ETH (see wallet/rotation). For
 * one owned by a key, it is the setting on the Network fee page.
 */
export function useActiveFeePayer(network: Network): {
  owner: Address | null;
  vault: Address | null;
  payer: FeePayer;
  canChoose: boolean;
} {
  const owner = useWallet((s) => s.address);
  const isSafe = useVaults((s) => !!s.vaults.find((v) => v.index === s.activeIndex)?.safe);
  const vault = useActiveVaultAddress(network);
  const chosen = useFeePayer(network, vault);
  const rotating = useRotationOn(network, vault);
  return {owner, vault, payer: isSafe || rotating ? 'vault' : chosen, canChoose: !isSafe && !rotating && !!owner};
}

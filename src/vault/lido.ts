import {parseAbi, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {relayVaultWrite} from './relay';
import type {VaultWriteBase} from '@/components/useVaultWrite';

/**
 * Lido's withdrawal queue, as the vault sees it.
 *
 * A withdraw from Lido does not hand back ETH: it files a request in Lido's queue, which finalizes
 * some days later, and only then can the vault claim it — as WETH, back into its balance. Until
 * the claim the ETH is in neither the position nor the balance, so a page that did not show the
 * queue showed the money as simply gone. The same reads and the same claim as the web.
 */

/** Lido's unstETH (withdrawal queue NFT) per chain; none where Lido is not deployed. */
const UNSTETH_ADDRESS: Partial<Record<Network, Address>> = {
  mainnet: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1',
  sepolia: '0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd',
};

const VAULT_WITHDRAWALS_ABI = parseAbi([
  'function getPendingWithdrawalIds(address protocol) view returns (uint256[])',
  'function claimWithdrawal(address protocol, uint256 id)',
  'function claimWithdrawals(address protocol, uint256[] ids)',
]);

const UNSTETH_ABI = parseAbi([
  'function getWithdrawalStatus(uint256[] requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[] statuses)',
]);

export type LidoUnstake = {
  /** ETH still waiting in the queue, not yet finalized. */
  unstaking: bigint;
  /** ETH finalized and waiting to be claimed. */
  claimable: bigint;
  /** The finalized, unclaimed request ids — what a claim takes. */
  claimableIds: bigint[];
};

export const NO_UNSTAKE: LidoUnstake = {unstaking: 0n, claimable: 0n, claimableIds: []};

/** The vault's open requests with one Lido adapter, split into still-queued and claimable. */
export async function getLidoUnstake(vault: Address, protocol: Address, network: Network): Promise<LidoUnstake> {
  const unsteth = UNSTETH_ADDRESS[network];
  if (!unsteth) return NO_UNSTAKE;
  const client = publicClientFor(network);
  const ids = await client.readContract({
    address: vault,
    abi: VAULT_WITHDRAWALS_ABI,
    functionName: 'getPendingWithdrawalIds',
    args: [protocol],
  });
  if (ids.length === 0) return NO_UNSTAKE;
  const statuses = await client.readContract({
    address: unsteth,
    abi: UNSTETH_ABI,
    functionName: 'getWithdrawalStatus',
    args: [ids],
  });
  const out: LidoUnstake = {unstaking: 0n, claimable: 0n, claimableIds: []};
  statuses.forEach((s, i) => {
    if (s.isClaimed) return;
    if (s.isFinalized) {
      out.claimable += s.amountOfStETH;
      out.claimableIds.push(ids[i]);
    } else {
      out.unstaking += s.amountOfStETH;
    }
  });
  return out;
}

/** Claim finalized requests back into the vault as WETH — the scalar entry point for the usual one. */
export async function claimLido(o: VaultWriteBase & {protocol: Address; ids: bigint[]}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_WITHDRAWALS_ABI,
    ...(o.ids.length === 1
      ? {functionName: 'claimWithdrawal', args: [o.protocol, o.ids[0]]}
      : {functionName: 'claimWithdrawals', args: [o.protocol, o.ids]}),
    stableCoin: o.stableCoin,
  });
  return hash;
}

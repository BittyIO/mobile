import {parseAbi, type Address, type Hex} from 'viem';
import {isTronNetwork, NATIVE, publicClientFor, type Network} from '@/core/chain';
import {adapterByName} from '@/core/protocols';
import {getTronUnstake, TRON_STAKE} from './tron-stake';
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
  /** The ids still in the queue, which {fetchLidoEta} estimates. */
  pendingIds: bigint[];
  /** When the queue already knows its own timing (Tron's unlocks), so no estimate is fetched. */
  eta?: {start: number; end: number} | null;
};

export const NO_UNSTAKE: LidoUnstake = {unstaking: 0n, claimable: 0n, claimableIds: [], pendingIds: []};

/**
 * The staking adapter on this network whose withdrawals QUEUE and then have to be claimed: Lido on
 * Ethereum, TRON Stake on Tron. Its queue pays back the chain's wrapped coin (WETH, WTRX), in that
 * coin's decimals — what {queueUnits} and {queueSymbol} give the screens.
 */
export function queuedStakeAdapter(network: Network): {protocol: Address; name: string} | null {
  const name = isTronNetwork(network) ? TRON_STAKE : 'Lido';
  const protocol = adapterByName(network, name);
  return protocol ? {protocol, name} : null;
}

/** Is this registry name one whose withdrawals queue? */
export const isQueuedStake = (name: string) => name === 'Lido' || name === TRON_STAKE;

/** The decimals the queue's amounts are in: the native coin's (ETH 18, TRX 6). */
export const queueUnits = (network: Network) => NATIVE[network].decimals;

/** What the queue's amounts are called: the native coin (ETH, TRX). */
export const queueSymbol = (network: Network) => NATIVE[network].symbol;

/** The vault's open requests with one Lido adapter, split into still-queued and claimable. */
export async function getLidoUnstake(vault: Address, protocol: Address, network: Network): Promise<LidoUnstake> {
  if (isTronNetwork(network)) return getTronUnstake(vault, protocol, network);
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
  const out: LidoUnstake = {unstaking: 0n, claimable: 0n, claimableIds: [], pendingIds: []};
  statuses.forEach((s, i) => {
    if (s.isClaimed) return;
    if (s.isFinalized) {
      out.claimable += s.amountOfStETH;
      out.claimableIds.push(ids[i]);
    } else {
      out.unstaking += s.amountOfStETH;
      out.pendingIds.push(ids[i]);
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

/** Lido's own estimate of when queued requests finalize. Mainnet only: it covers no testnet we use. */
const WQ_API: Partial<Record<Network, string>> = {mainnet: 'https://wq-api.lido.fi'};

/**
 * When the queued requests are expected to be claimable: from the earliest request to the LATEST
 * estimated finalization, in unix seconds — the wait for all of it. Null where there is no estimate
 * (another chain, the API down, nothing calculated yet), and the caller shows the amount alone.
 *
 * An estimate, recalculated by Lido as the queue and validator exits move: it is shown as "~2 days",
 * never as a countdown to the second.
 */
export async function fetchLidoEta(network: Network, ids: bigint[]): Promise<{start: number; end: number} | null> {
  const base = WQ_API[network];
  if (!base || ids.length === 0) return null;
  const q = ids.map((id) => `ids=${id}`).join('&');
  const res = await fetch(`${base}/v2/request-time?${q}`);
  if (!res.ok) return null;
  const rows = (await res.json()) as {requestInfo?: {requestedAt?: string; finalizationAt?: string}}[];
  let start = Infinity;
  let end = 0;
  for (const r of rows) {
    const at = Date.parse(r.requestInfo?.requestedAt ?? '');
    const fin = Date.parse(r.requestInfo?.finalizationAt ?? '');
    if (Number.isFinite(at)) start = Math.min(start, at / 1000);
    if (Number.isFinite(fin)) end = Math.max(end, fin / 1000);
  }
  return Number.isFinite(start) && end > start ? {start, end} : null;
}

import {formatUnits, parseAbi, zeroAddress, type Address} from 'viem';
import {NATIVE, publicClientFor, type Network} from '@/core/chain';
import {ASSETS} from '@/core/assets';
import {adapterByName} from '@/core/protocols';
import {accountEnergy, type TronEnergy} from '@/tron/client';
import {evmToTron} from '@/tron/address';
import type {Position} from './positions';

/**
 * TRX staking on Tron, through the TronStakeProtocol adapter (protocol-store).
 *
 * The vault's WTRX is unwrapped and frozen for ENERGY, and the energy is delegated to the vault's
 * owner, so the owner's own Tron transactions burn less TRX. It pays no yield. Unstaking is Tron's
 * own: the TRX unlocks after the network's delay (14 days on mainnet, 1 on Nile) and is then claimed
 * back into the vault as WTRX, through the same vault calls as Lido's queue.
 *
 * The Bitty server does not index Tron, so everything here is read from the chain: the vault's
 * clone of the adapter keeps the stake and the queue, and TronGrid answers the owner's energy.
 */

/** The adapter's registry name, as the catalog API and the vendored table give it. */
export const TRON_STAKE = 'TRON Stake';

/** Tron's unstake delay per network, for the ring's start; the adapter keeps each request's unlock. */
const UNSTAKE_DAYS: Partial<Record<Network, number>> = {'tron-nile': 1};

/** Tron's unstake delay on this network, in days: 14 on mainnet, shorter on a testnet. */
export const tronUnstakeDays = (network: Network): number => UNSTAKE_DAYS[network] ?? 14;

const VAULT_ABI = parseAbi([
  'function getClone(address protocol) view returns (address)',
  'function getPendingWithdrawalIds(address protocol) view returns (uint256[])',
]);
const ADAPTER_ABI = parseAbi([
  'function staked() view returns (uint256)',
  'function unstakeRequest(uint256 id) view returns (uint256 amount, uint256 unlockAt)',
]);

export const tronStakeAdapter = (network: Network): Address | null => adapterByName(network, TRON_STAKE);

/** The vault's clone of the adapter, or null before its first deposit made one. */
async function cloneOf(vault: Address, protocol: Address, network: Network): Promise<Address | null> {
  const clone = await publicClientFor(network).readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: 'getClone',
    args: [protocol],
  });
  return clone === zeroAddress ? null : clone;
}

/**
 * The staked position: what is frozen and earning energy. Not the adapter's `getBalance`, which also
 * counts TRX already unstaking or waiting to be claimed; those are the queue's, shown beside it.
 */
export async function fetchTronStakePosition(vault: Address, network: Network): Promise<Position | null> {
  const protocol = tronStakeAdapter(network);
  const wtrx = ASSETS[network].find((a) => a.symbol === NATIVE[network].wrapped);
  if (!protocol || !wtrx) return null;
  const clone = await cloneOf(vault, protocol, network);
  if (!clone) return null;
  const raw = await publicClientFor(network).readContract({address: clone, abi: ADAPTER_ABI, functionName: 'staked'});
  if (raw <= 0n) return null;
  return {
    protocol,
    protocolName: TRON_STAKE,
    category: 'staking',
    asset: wtrx.address,
    symbol: wtrx.symbol,
    decimals: wtrx.decimals,
    kind: 'staked',
    raw,
    formatted: formatUnits(raw, wtrx.decimals),
  };
}

export type TronUnstake = {
  unstaking: bigint;
  claimable: bigint;
  claimableIds: bigint[];
  pendingIds: bigint[];
  /** From the earliest open request to the last unlock, in unix seconds; null when nothing waits. */
  eta: {start: number; end: number} | null;
};

/**
 * The open unstake requests, split by whether Tron has unlocked them yet. A claim releases every
 * unlocked request at once (the adapter ignores which ids it is handed), so `claimableIds` is only
 * what the claim button passes along.
 */
export async function getTronUnstake(vault: Address, protocol: Address, network: Network): Promise<TronUnstake> {
  const out: TronUnstake = {unstaking: 0n, claimable: 0n, claimableIds: [], pendingIds: [], eta: null};
  const client = publicClientFor(network);
  const ids = await client.readContract({address: vault, abi: VAULT_ABI, functionName: 'getPendingWithdrawalIds', args: [protocol]});
  if (ids.length === 0) return out;
  const clone = await cloneOf(vault, protocol, network);
  if (!clone) return out;
  const now = Date.now() / 1000;
  let last = 0;
  let first = Infinity;
  // One at a time: Tron has no Multicall3, and TronGrid refuses bursts.
  for (const id of ids) {
    const [amount, unlockAt] = await client.readContract({address: clone, abi: ADAPTER_ABI, functionName: 'unstakeRequest', args: [id]});
    if (amount === 0n) continue;
    const at = Number(unlockAt);
    if (at <= now) {
      out.claimable += amount;
      out.claimableIds.push(id);
    } else {
      out.unstaking += amount;
      out.pendingIds.push(id);
      last = Math.max(last, at);
      first = Math.min(first, at);
    }
  }
  const days = tronUnstakeDays(network);
  if (out.pendingIds.length && days) out.eta = {start: first - days * 86_400, end: last};
  return out;
}

/** The owner's energy and today's rate, or null where the node will not say. */
export async function fetchOwnerEnergy(owner: Address, network: Network): Promise<TronEnergy | null> {
  if (network !== 'tron-nile') return null;
  try {
    return await accountEnergy(network, evmToTron(owner));
  } catch {
    return null;
  }
}

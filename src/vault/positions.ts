/**
 * Vault positions (staking + lending) — served by the SAME backend cache the web uses
 * (`/api/ethereum/vaults/{vault}/positions`), not per-pair eth_calls. The server reads the chain,
 * caches, and revalidates; the client just formats.
 */
import {formatUnits, parseUnits, type Address} from 'viem';
import {apiFetch, apiUrl, type Network} from '@/core/chain';
import {ASSETS, assetMeta} from '@/core/assets';
import {adapterByName, protocolMeta, type ProtocolCategory} from '@/core/protocols';
import {fetchYielding} from './yielding';

export type PositionKind = 'staked' | 'supplied';

export type Position = {
  protocol: Address;
  protocolName: string;
  category: ProtocolCategory;
  asset: Address;
  symbol: string;
  decimals: number;
  kind: PositionKind;
  raw: bigint;
  formatted: string;
};

/** The positions endpoint's own ceiling. Generous on purpose; it is there to catch a hang. */
const SLOW_READ_MS = 60_000;

type PositionJson = {
  protocol: string;
  asset: string;
  kind: string;
  balance: string;
};

/**
 * Fetch the vault's staked + supplied positions. Returns only non-zero rows. `fresh` forces a chain
 * re-read on the server (use right after a stake/withdraw tx); the default is happy with the cache.
 */
export async function fetchPositions(
  vault: Address,
  network: Network,
  fresh = false,
): Promise<Position[]> {
  const res = await apiFetch(
    apiUrl(
      // `apiUrl` adds the deployment's `version`.
      `/api/ethereum/vaults/${vault}/positions${fresh ? '?fresh=1' : ''}`,
      network,
    ),
    undefined,
    // The slowest read in the app, and knowingly so: see the note above about `fresh`. On mainnet
    // the server walks every registered asset against every adapter, which on a cold cache takes
    // longer than any other endpoint here.
    SLOW_READ_MS,
  );
  if (!res.ok) throw new Error(`positions ${res.status}`);
  const data = (await res.json()) as {positions?: PositionJson[]};

  return (data.positions ?? [])
    .filter((p) => p.kind === 'staked' || p.kind === 'supplied')
    .map((p): Position => {
      const asset = assetMeta(network, p.asset);
      const proto = protocolMeta(network, p.protocol);
      const raw = BigInt(p.balance);
      return {
        protocol: p.protocol as Address,
        protocolName: proto.name,
        category: proto.category,
        asset: p.asset as Address,
        symbol: asset.symbol,
        decimals: asset.decimals,
        kind: p.kind as PositionKind,
        raw,
        formatted: formatUnits(raw, asset.decimals),
      };
    })
    .filter((p) => p.raw > 0n);
}

/**
 * The vault's Sky savings position, read from the chain rather than the server's cache.
 *
 * A Sky deposit leaves the vault holding sUSDS, and the adapter reports it as a USDC balance — but
 * only through the vault's own `getBalances`, which the indexer has to have run and cached. Until it
 * does (a fresh vault, a chain the indexer is behind on, a failed refresh), the Earn and Overview
 * rows read 0 while the balance is plainly there. This reads the sUSDS balance directly, the same
 * number the Trade screen already trusts for "yielding USDC", and it is used only when the cache has
 * nothing for (Sky, USDC).
 */
export async function fetchSkyPosition(vault: Address, network: Network): Promise<Position | null> {
  const protocol = adapterByName(network, 'Sky');
  const usdc = ASSETS[network].find((a) => a.symbol === 'USDC');
  if (!protocol || !usdc) return null;
  const y = await fetchYielding(vault, network);
  if (!y || !(y.usdc > 0)) return null;
  const raw = parseUnits(y.usdc.toFixed(usdc.decimals) as `${number}`, usdc.decimals);
  if (raw <= 0n) return null;
  return {
    protocol,
    protocolName: 'Sky',
    category: 'staking',
    asset: usdc.address,
    symbol: usdc.symbol,
    decimals: usdc.decimals,
    kind: 'staked',
    raw,
    formatted: formatUnits(raw, usdc.decimals),
  };
}

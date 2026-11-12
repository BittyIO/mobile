import type {Address} from 'viem';
import type {Asset} from '@/core/assets';
import {adapterByName} from '@/core/protocols';
import {NATIVE, type Network} from '@/core/chain';
import {TRON_STAKE} from './tron-stake';

/**
 * Which Earn adapter accepts which asset — the menu of deposits the vault can make.
 *
 * Synthesized rather than discovered, because an adapter cannot be asked: there is no call that
 * answers "what do you take". So the pairs are written down, and every supported asset gets a row
 * whether or not the vault has ever used it — the first deposit is what opts the vault in.
 *
 * `kind` picks the ledger a flow is written to: staking routes go to stake-flows, lending routes to
 * supply-flows, and the two endpoints name their directions differently.
 *
 * Lives here rather than in the Earn list because the DEPOSIT FORM needs it too. The form used to
 * take one route as navigation params and had no idea what else the same adapter would accept, so
 * arriving from an Aave row offered that one asset and nothing else — a form about a protocol that
 * could not name the protocol's own menu. One table, two readers.
 */
export type EarnRoute = {protocol: Address; name: string; asset: Asset; kind: 'staking' | 'lending'};

/**
 * The staking side: Lido takes ether, Sky takes dollars.
 *
 * The Sky adapter takes USDC ONLY — it swaps through the PSM into sUSDS, and every other
 * stablecoin reverts with InvalidAsset, so no other one gets a row.
 */
export function stakeRoutes(network: Network, assets: Asset[]): EarnRoute[] {
  const out: EarnRoute[] = [];
  const lido = adapterByName(network, 'Lido');
  if (lido)
    assets
      .filter((a) => a.symbol === 'WETH')
      .forEach((asset) => out.push({protocol: lido, name: 'Lido', asset, kind: 'staking'}));
  const sky = adapterByName(network, 'Sky');
  if (sky)
    assets
      .filter((a) => a.symbol === 'USDC')
      .forEach((asset) => out.push({protocol: sky, name: 'Sky', asset, kind: 'staking'}));
  // TRON Stake takes WTRX: frozen for energy, not yield. See vault/tron-stake.
  const tron = adapterByName(network, TRON_STAKE);
  if (tron)
    assets
      .filter((a) => a.symbol === NATIVE[network].wrapped)
      .forEach((asset) => out.push({protocol: tron, name: TRON_STAKE, asset, kind: 'staking'}));
  return out;
}

/** The lending side: Aave's blue-chip reserves. */
export function lendRoutes(network: Network, assets: Asset[]): EarnRoute[] {
  const aave = adapterByName(network, 'Aave V3');
  if (!aave) return [];
  // WBNB, BTCB and ETH (Binance-Peg) are the BNB market's.
  const supported = ['WETH', 'WBTC', 'cbBTC', 'USDC', 'USDT', 'WBNB', 'BTCB', 'ETH'];
  return assets
    .filter((a) => supported.includes(a.symbol))
    .map((asset) => ({protocol: aave, name: 'Aave V3', asset, kind: 'lending' as const}));
}

/** Everything one adapter accepts, in catalog order. Empty for an adapter with no routes. */
export function routesForProtocol(network: Network, assets: Asset[], protocol: string): EarnRoute[] {
  const p = protocol.toLowerCase();
  return [...stakeRoutes(network, assets), ...lendRoutes(network, assets)].filter(
    (r) => r.protocol.toLowerCase() === p,
  );
}

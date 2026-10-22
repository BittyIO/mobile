/**
 * Live yield APY per protocol/asset — ported from web `use-protocol-apy`.
 *  - Aave (lending): the supply rate per asset from the Pool Data Provider (`getReserveData.liquidityRate`).
 *  - Sky (staking): the Sky Savings Rate — `ssr()` on mainnet, `getSUSDSData()` on Base and Arbitrum. One rate for all
 *    Sky assets. No Sky deployment on Sepolia, so it's absent there.
 *  - Lido (staking): a backend endpoint (`/api/protocol-apy/lido`), since the APR isn't a simple read.
 */
import {parseAbi, type Address} from 'viem';
import {apiFetch, apiUrl, publicClientFor, type Network} from '@/core/chain';

const SECONDS_PER_YEAR = 31_536_000;

const AAVE_POOL_DATA_PROVIDER: Partial<Record<Network, Address>> = {
  mainnet: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD',
  sepolia: '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31',
  base: '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A',
  arbitrum: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
};

const SKY_RATE_SOURCE: Partial<Record<Network, {address: Address; read: 'ssr' | 'susdsData'}>> = {
  mainnet: {address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', read: 'ssr'},
  base: {address: '0x65d946e533748A998B1f0E430803e39A6388f7a1', read: 'susdsData'},
  arbitrum: {address: '0xEE2816c1E1eed14d444552654Ed3027abC033A36', read: 'susdsData'},
};

const AAVE_DATA_ABI = parseAbi([
  'function getReserveData(address asset) view returns (uint256 unbacked,uint256 accruedToTreasuryScaled,uint256 totalAToken,uint256 totalStableDebt,uint256 totalVariableDebt,uint256 liquidityRate,uint256 variableBorrowRate,uint256 stableBorrowRate,uint256 averageStableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex,uint40 lastUpdateTimestamp)',
]);
const SSR_ABI = parseAbi(['function ssr() view returns (uint256)']);
const SUSDS_DATA_ABI = parseAbi(['function getSUSDSData() view returns (uint96 ssr,uint120 chi,uint40 rho)']);

const aaveSupplyApy = (rateRay: bigint): number => {
  const perSec = Number(rateRay) / 1e27 / SECONDS_PER_YEAR;
  return ((1 + perSec) ** SECONDS_PER_YEAR - 1) * 100;
};
const skySupplyApy = (ssrRay: bigint): number => ((Number(ssrRay) / 1e27) ** SECONDS_PER_YEAR - 1) * 100;

export type ProtocolApy = {
  assetApy: Map<string, number>; // Aave: lowercased asset address → APY (rates differ per asset)
  protocolApy: Map<string, number>; // Sky/Lido: lowercased adapter address → APY (single rate)
};

export const EMPTY_APY: ProtocolApy = {assetApy: new Map(), protocolApy: new Map()};

/** Read the live APY for the given Aave assets and Sky/Lido adapters. Best-effort — each source is optional. */
export async function fetchProtocolApy(o: {
  network: Network;
  aaveAssets: Address[];
  skyProtocols: Address[];
  lidoProtocols: Address[];
}): Promise<ProtocolApy> {
  const client = publicClientFor(o.network);
  const assetApy = new Map<string, number>();
  const protocolApy = new Map<string, number>();

  // Aave supply rate per asset — one multicall to the Pool Data Provider.
  const aaveTask = async () => {
    const provider = AAVE_POOL_DATA_PROVIDER[o.network];
    if (!provider || o.aaveAssets.length === 0) return;
    try {
      const res = await client.multicall({
        contracts: o.aaveAssets.map((a) => ({address: provider, abi: AAVE_DATA_ABI, functionName: 'getReserveData' as const, args: [a] as const})),
        allowFailure: true,
      });
      o.aaveAssets.forEach((a, i) => {
        const r = res[i];
        if (r.status === 'success') {
          // getReserveData returns 12 separate outputs → viem decodes them as an array; liquidityRate is [5].
          const apy = aaveSupplyApy((r.result as readonly bigint[])[5]);
          if (Number.isFinite(apy)) assetApy.set(a.toLowerCase(), apy);
        } else {
          // The batch answered but this reserve reverted: the asset is not listed on this Aave
          // market (USDT on Base), so it earns nothing. Recorded as 0 rather than left unknown, so
          // the Earn tab can hide it; a failure of the whole batch stays unknown (see catch).
          assetApy.set(a.toLowerCase(), 0);
        }
      });
    } catch {
      /* omit Aave APY on failure */
    }
  };

  // Sky Savings Rate — one rate for every Sky asset.
  const skyTask = async () => {
    const sky = SKY_RATE_SOURCE[o.network];
    if (!sky || o.skyProtocols.length === 0) return;
    try {
      const ssr =
        sky.read === 'ssr'
          ? ((await client.readContract({address: sky.address, abi: SSR_ABI, functionName: 'ssr'})) as bigint)
          : // getSUSDSData returns (ssr, chi, rho) → decoded as an array; the rate is [0].
            ((await client.readContract({address: sky.address, abi: SUSDS_DATA_ABI, functionName: 'getSUSDSData'})) as readonly bigint[])[0];
      const apy = skySupplyApy(ssr);
      if (Number.isFinite(apy)) o.skyProtocols.forEach((p) => protocolApy.set(p.toLowerCase(), apy));
    } catch {
      /* omit Sky APY on failure */
    }
  };

  // Lido staking APR — from the backend (not a plain read).
  const lidoTask = async () => {
    if (o.lidoProtocols.length === 0) return;
    try {
      const res = await apiFetch(apiUrl('/api/protocol-apy/lido', o.network));
      const j = (await res.json()) as {apr?: number | string};
      const apr = Number(j?.apr);
      if (Number.isFinite(apr)) o.lidoProtocols.forEach((p) => protocolApy.set(p.toLowerCase(), apr));
    } catch {
      /* omit Lido APY on failure */
    }
  };

  // All three sources concurrently, so a slow one (Lido backend) doesn't hold up the others.
  await Promise.all([aaveTask(), skyTask(), lidoTask()]);
  return {assetApy, protocolApy};
}

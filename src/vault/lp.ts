/**
 * Uniswap V3 LP positions held by the vault — ported from web `getVaultLpPositions`.
 *
 * The position NFTs are owned by the VAULT address (not the clone), so we read the adapter's
 * NonfungiblePositionManager and enumerate the vault's tokens. Amounts come from the standard V3
 * liquidity↔tick math; fees are simulated via a `collect` eth_call (positions().tokensOwed is stale
 * until the position is poked). Adapters that share one position manager (Uniswap 1.0.0 & 1.0.1) are
 * deduped so a position isn't listed twice.
 *
 * This is the one genuinely on-chain-heavy read; everything is best-effort — a position or pool read
 * that fails is skipped rather than failing the whole list.
 */
import {parseAbi, zeroAddress, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {assetMeta} from '@/core/assets';
import {ammAdapters} from '@/core/protocols';

export type LpPosition = {
  tokenId: string;
  token0: Address;
  token1: Address;
  symbol0: string;
  symbol1: string;
  fee: number; // pool fee in hundredths of a bip (3000 = 0.30%)
  liquidity: string; // raw uint128, for removeLiquidity
  amount0: number;
  amount1: number;
  feesOwed0: number;
  feesOwed1: number;
  inRange: boolean;
  priceLower: number;
  priceUpper: number;
};

const MAX128 = (BigInt(1) << BigInt(128)) - BigInt(1);

const PM_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function factory() view returns (address)',
  'function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 fg0,uint256 fg1,uint128 tokensOwed0,uint128 tokensOwed1)',
]);
const FACTORY_ABI = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
]);
const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
]);
const COLLECT_ABI = parseAbi([
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) returns (uint256 amount0,uint256 amount1)',
]);
const ADAPTER_ABI = parseAbi([
  'function positionManager() view returns (address)',
]);

/** All LP positions across the vault's Uniswap adapters (deduped by position manager). */
export async function readLpPositions(
  vault: Address,
  network: Network,
): Promise<LpPosition[]> {
  const client = publicClientFor(network);

  // Resolve each adapter's position manager, dedupe (sibling adapters share one).
  const adapters = ammAdapters(network);
  const pms = await Promise.all(
    adapters.map((a) =>
      client
        .readContract({address: a, abi: ADAPTER_ABI, functionName: 'positionManager'})
        .catch(() => zeroAddress),
    ),
  );
  const uniquePms = [...new Set(pms.filter((p) => p !== zeroAddress).map((p) => p.toLowerCase()))] as Address[];

  const out: LpPosition[] = [];
  for (const pm of uniquePms) {
    try {
      const [balance, factory] = await Promise.all([
        client.readContract({address: pm, abi: PM_ABI, functionName: 'balanceOf', args: [vault]}) as Promise<bigint>,
        client.readContract({address: pm, abi: PM_ABI, functionName: 'factory'}) as Promise<Address>,
      ]);
      for (let i = 0; i < Number(balance); i++) {
        const pos = await readOne(client, pm, factory, vault, BigInt(i), network).catch(() => null);
        if (pos) out.push(pos);
      }
    } catch {
      // Skip a whole PM that fails rather than dropping everything.
    }
  }
  return out;
}

async function readOne(
  client: ReturnType<typeof publicClientFor>,
  pm: Address,
  factory: Address,
  vault: Address,
  index: bigint,
  network: Network,
): Promise<LpPosition | null> {
  const tokenId = (await client.readContract({
    address: pm,
    abi: PM_ABI,
    functionName: 'tokenOfOwnerByIndex',
    args: [vault, index],
  })) as bigint;

  const pos = (await client.readContract({
    address: pm,
    abi: PM_ABI,
    functionName: 'positions',
    args: [tokenId],
  })) as readonly [bigint, string, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];

  const token0 = pos[2];
  const token1 = pos[3];
  const feeTier = Number(pos[4]);
  const tickLower = Number(pos[5]);
  const tickUpper = Number(pos[6]);
  const liquidity = pos[7];
  const tokensOwed0 = pos[10];
  const tokensOwed1 = pos[11];

  // Fully-withdrawn, fee-less — nothing to show.
  if (liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) return null;

  // Current tick from the pool (for amounts + in-range). Falls back to the lower bound on failure.
  let currentTick = tickLower;
  try {
    const pool = (await client.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [token0, token1, feeTier],
    })) as Address;
    const slot0 = (await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'slot0',
    })) as readonly [bigint, number, number, number, number, number, boolean];
    currentTick = Number(slot0[1]);
  } catch {
    /* keep lower bound */
  }

  const L = Number(liquidity);
  const sa = Math.sqrt(Math.pow(1.0001, tickLower));
  const sb = Math.sqrt(Math.pow(1.0001, tickUpper));
  const sp = Math.sqrt(Math.pow(1.0001, currentTick));
  let raw0 = 0;
  let raw1 = 0;
  if (currentTick < tickLower) {
    raw0 = L * (1 / sa - 1 / sb);
  } else if (currentTick >= tickUpper) {
    raw1 = L * (sb - sa);
  } else {
    raw0 = L * (1 / sp - 1 / sb);
    raw1 = L * (sp - sa);
  }

  const m0 = assetMeta(network, token0);
  const m1 = assetMeta(network, token1);

  // Real accrued fees: tokensOwed is stale after swaps, so simulate collect as the vault.
  let fee0 = tokensOwed0;
  let fee1 = tokensOwed1;
  try {
    const sim = await client.simulateContract({
      address: pm,
      abi: COLLECT_ABI,
      functionName: 'collect',
      account: vault,
      args: [{tokenId, recipient: vault, amount0Max: MAX128, amount1Max: MAX128}],
    });
    const res = sim.result as readonly [bigint, bigint];
    fee0 = res[0];
    fee1 = res[1];
  } catch {
    /* fall back to tokensOwed */
  }

  return {
    tokenId: tokenId.toString(),
    token0,
    token1,
    symbol0: m0.symbol,
    symbol1: m1.symbol,
    fee: feeTier,
    liquidity: liquidity.toString(),
    amount0: raw0 / 10 ** m0.decimals,
    amount1: raw1 / 10 ** m1.decimals,
    feesOwed0: Number(fee0) / 10 ** m0.decimals,
    feesOwed1: Number(fee1) / 10 ** m1.decimals,
    inRange: currentTick >= tickLower && currentTick < tickUpper,
    priceLower: Math.pow(1.0001, tickLower) * 10 ** (m0.decimals - m1.decimals),
    priceUpper: Math.pow(1.0001, tickUpper) * 10 ** (m0.decimals - m1.decimals),
  };
}

/**
 * The token a position is actually held as, and what one of it is worth in the underlying.
 *
 * A limit or TWAP order paid from a position sells THIS token rather than unwinding first: the
 * position keeps earning for as long as the order sits open, and nothing is withdrawn for an order
 * that may never fill. A market order does the opposite — it is one transaction, so it withdraws and
 * swaps the underlying, which has real liquidity.
 *
 *  - Sky savings is sUSDS, an ERC-4626 share worth `convertToAssets` of USDC (≈1.11 and rising).
 *  - An Aave supply is an aToken, which rebases 1:1 with its underlying.
 */
import {parseAbi, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {hasYieldingUsdc, fetchYielding} from './yielding';
import type {Position} from './positions';

/** Aave aTokens by underlying, per network — the same set the history feed recognises. */
const ATOKEN: Partial<Record<Network, Record<string, Address>>> = {
  mainnet: {
    USDC: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
    USDT: '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a',
    WETH: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8',
    WBTC: '0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8',
  },
  base: {
    USDC: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
    WETH: '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7',
    cbBTC: '0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6',
  },
  arbitrum: {
    USDC: '0x724dc807b04555b71ed48a6896b6F41593b8C637',
    USDT: '0x6ab707Aca953eDAeFBc4fD23bA73294241490620',
    WETH: '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8',
    WBTC: '0x078f358208685046a11C85e8ad32895DED33A249',
  },
  bsc: {
    WBNB: '0x9B00a09492a626678E5A3009982191586C444Df9',
    BTCB: '0x56a7ddc4e848EbF43845854205ad71D5D5F72d3D',
    ETH: '0x2E94171493fAbE316b6205f1585779C887771E2F',
    USDT: '0xa9251ca9DE909CB71783723713B21E4233fbf1B1',
    USDC: '0x00901a076785e0906d1028c7d6372d247bec7d61',
  },
  sepolia: {
    USDT: '0xAF0F6e8b0Dc5c913bbF4d14c22B4E78Dd14310B6',
    WBTC: '0x1804Bf30507dc2EB3bDEbBBdd859991EAeF6EefF',
  },
};

export type PositionToken = {
  /** The token to sell. */
  address: Address;
  decimals: number;
  /** Underlying per token, so a typed USDC amount converts to what is actually sold. */
  rate: number;
  /** The most that can be sold, in the token's own units. */
  max: bigint;
};

/** What to sell for an order funded from `position`, or null when the app cannot name the token. */
export async function positionToken(
  vault: Address,
  network: Network,
  position: Position,
): Promise<PositionToken | null> {
  if (position.kind === 'staked') {
    // Sky only: Lido's stETH is a staking position the app does not trade.
    if (position.protocolName !== 'Sky' || !hasYieldingUsdc(network)) return null;
    const y = await fetchYielding(vault, network);
    return y ? {address: y.address, decimals: y.decimals, rate: y.rate, max: y.raw} : null;
  }
  const address = ATOKEN[network]?.[position.symbol];
  if (!address) return null;
  const balance = (await publicClientFor(network)
    .readContract({address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [vault]})
    .catch(() => BigInt(0))) as bigint;
  // An aToken rebases: one is always one of the underlying, same decimals.
  return balance > BigInt(0) ? {address, decimals: position.decimals, rate: 1, max: balance} : null;
}

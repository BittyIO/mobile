/**
 * "USDC (Yielding)" — spending the vault's Sky savings balance (sUSDS) directly in a trade, without
 * unwinding it first, mirroring the web's yielding quote.
 *
 * The USDC value of sUSDS comes from the Sky Savings Rate accumulator (chi), where assets = shares·chi/RAY
 * (chi ≈ 1.0x, growing over time):
 *   - mainnet: sUSDS is ERC-4626 and exposes `convertToAssets(shares)` directly.
 *   - base:    sUSDS is a plain ERC-20; the rate lives on the PSM3 rate provider's `getSUSDSData()` → chi.
 * Sepolia has no Sky deployment, so the yielding quote isn't offered there.
 *
 * sUSDS is NOT AMM-liquid, so it can only be a BUY quote via a CoW limit/TWAP order (sell sUSDS → base);
 * a market swap or a sell INTO sUSDS has no path. The Trade screen enforces that.
 */
import {parseAbi, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';

const SUSDS: Partial<Record<Network, Address>> = {
  mainnet: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
  base: '0x5875eEE11Cf8398102FdAd704C9E96607675467a',
  arbitrum: '0xdDb46999F8891663a8F2828d25298f70416d7610',
};
// L2 sUSDS is a bridged token, not the ERC-4626 vault, so its rate comes from the PSM3's rate
// provider — getSUSDSData() returns (ssr, chi, rho); chi is the rate. Arbitrum's is the one its
// PSM3 (0x2B05…7266) names.
const RATE_ORACLE: Partial<Record<Network, Address>> = {
  base: '0x65d946e533748A998B1f0E430803e39A6388f7a1',
  arbitrum: '0xEE2816c1E1eed14d444552654Ed3027abC033A36',
};

const ERC4626_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
]);
const SUSDS_DATA_ABI = parseAbi(['function getSUSDSData() view returns (uint96 ssr,uint120 chi,uint40 rho)']);

export type Yielding = {
  address: Address; // sUSDS token
  decimals: number; // 18
  raw: bigint; // vault's sUSDS balance
  usdc: number; // that balance's USDC value
  rate: number; // USDC per 1 sUSDS (≈ 1.05)
};

/** Whether this network offers the yielding-USDC quote. */
export const hasYieldingUsdc = (network: Network): boolean => !!SUSDS[network];

/** Read the vault's sUSDS balance + its USDC rate, or null if unavailable / zero balance. */
/** The last rate {susdsRate} read per chain, for code that cannot wait for one. */
const lastRate: Partial<Record<Network, number>> = {};

/**
 * USDC per 1 sUSDS on this chain as last read, or 1 before any read — for a label drawn now (a
 * history line, a confirm). Any screen showing positions reads the rate, so it is rarely the
 * default; it moves by a fraction of a percent a month.
 */
export const susdsRateCached = (network: Network): number => lastRate[network] ?? 1;

/** USDC per 1 sUSDS on this chain (the Sky Savings Rate accumulator), or 1 when it cannot be read. */
export async function susdsRate(network: Network): Promise<number> {
  const r = await readSusdsRate(network);
  lastRate[network] = r;
  return r;
}

async function readSusdsRate(network: Network): Promise<number> {
  const address = SUSDS[network];
  if (!address) return 1;
  try {
    const client = publicClientFor(network);
    if (RATE_ORACLE[network]) {
      const data = (await client.readContract({address: RATE_ORACLE[network]!, abi: SUSDS_DATA_ABI, functionName: 'getSUSDSData'})) as readonly bigint[];
      const rate = Number(data[1]) / 1e27;
      return Number.isFinite(rate) && rate > 0 ? rate : 1;
    }
    const perShare = (await client.readContract({address, abi: ERC4626_ABI, functionName: 'convertToAssets', args: [BigInt(1e18)]})) as bigint;
    const rate = Number(perShare) / 1e18;
    return Number.isFinite(rate) && rate > 0 ? rate : 1;
  } catch {
    return 1;
  }
}

export async function fetchYielding(vault: Address, network: Network): Promise<Yielding | null> {
  const address = SUSDS[network];
  if (!address) return null;
  try {
    const client = publicClientFor(network);
    const raw = (await client.readContract({address, abi: ERC4626_ABI, functionName: 'balanceOf', args: [vault]})) as bigint;
    if (raw <= BigInt(0)) return null;

    let rate: number;
    if (RATE_ORACLE[network]) {
      // chi is the assets-per-share accumulator (RAY-scaled): USDS per sUSDS = chi / 1e27.
      const data = (await client.readContract({address: RATE_ORACLE[network]!, abi: SUSDS_DATA_ABI, functionName: 'getSUSDSData'})) as readonly bigint[];
      rate = Number(data[1]) / 1e27;
    } else {
      const perShare = (await client.readContract({address, abi: ERC4626_ABI, functionName: 'convertToAssets', args: [BigInt(1e18)]})) as bigint;
      rate = Number(perShare) / 1e18;
    }
    if (!Number.isFinite(rate) || rate <= 0) rate = 1;
    const usdc = (Number(raw) / 1e18) * rate;
    return {address, decimals: 18, raw, usdc, rate};
  } catch {
    return null;
  }
}

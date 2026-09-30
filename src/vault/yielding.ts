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
};
// Base's SSR oracle (PSM3 rate provider) — getSUSDSData() returns (ssr, chi, rho); chi is the rate.
const BASE_RATE_ORACLE = '0x65d946e533748A998B1f0E430803e39A6388f7a1' as const;

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
/** USDC per 1 sUSDS on this chain (the Sky Savings Rate accumulator), or 1 when it cannot be read. */
export async function susdsRate(network: Network): Promise<number> {
  const address = SUSDS[network];
  if (!address) return 1;
  try {
    const client = publicClientFor(network);
    if (network === 'base') {
      const data = (await client.readContract({address: BASE_RATE_ORACLE, abi: SUSDS_DATA_ABI, functionName: 'getSUSDSData'})) as readonly bigint[];
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
    if (network === 'base') {
      // chi is the assets-per-share accumulator (RAY-scaled): USDS per sUSDS = chi / 1e27.
      const data = (await client.readContract({address: BASE_RATE_ORACLE, abi: SUSDS_DATA_ABI, functionName: 'getSUSDSData'})) as readonly bigint[];
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

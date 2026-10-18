/**
 * Activation/relay fee priced from live gas, ported from web `lib/activation-fee`. The owner SIGNS the
 * fee, so the client must compute it before signing; the server recomputes and accepts within a band.
 */

// Measured gas for activateVaultByAsset (deploy clone + init + pay fee). Constant, not estimated —
// estimating needs the signature that carries the fee we're computing.
export const ACTIVATION_GAS = BigInt(600_000);
// 1.2x margin over measured cost.
const ACTIVATION_MARGIN_BPS = BigInt(2000);
const BPS = BigInt(10000);
const MICRO = BigInt(1_000_000);

/**
 * Round up to whole cents so the signed figure reads as money ($0.01, $1.30), never rounds to 0.
 * Floored at one cent, as the server's copy is: on a near-free chain (Sepolia at a few wei) the exact
 * cost is 0, and a signed $0 against the server's 1¢ quote was refused `fee-too-low`.
 */
function roundUpToCents(exact: bigint, decimals: number): bigint {
  if (decimals < 2) return exact;
  const cents = BigInt(10) ** BigInt(decimals - 2);
  const rounded = ((exact + cents - BigInt(1)) / cents) * cents;
  return rounded > BigInt(0) ? rounded : cents;
}

/** Cost of a relayed op in the stable coin's own units. `l1FeeWei` = OP Stack L1 data fee (0 on L1). */
export function relayFeeUnits(
  gasUnits: bigint,
  gasPriceWei: bigint,
  ethUsd: number,
  decimals: number,
  l1FeeWei: bigint = BigInt(0),
): bigint {
  const weiCost = ((gasUnits * gasPriceWei + l1FeeWei) * (BPS + ACTIVATION_MARGIN_BPS)) / BPS;
  const usdMicro = (weiCost * BigInt(Math.round(ethUsd * 1e6))) / BigInt(10) ** BigInt(18);
  const exact = (usdMicro * BigInt(10) ** BigInt(decimals)) / MICRO;
  return roundUpToCents(exact, decimals);
}

export function activationFeeUnits(
  gasPriceWei: bigint,
  ethUsd: number,
  decimals: number,
  l1FeeWei: bigint = BigInt(0),
): bigint {
  return relayFeeUnits(ACTIVATION_GAS, gasPriceWei, ethUsd, decimals, l1FeeWei);
}

/**
 * Activation/relay fee priced from live gas, ported from web `lib/activation-fee`. The owner SIGNS the
 * fee, so the client must compute it before signing; the server recomputes and accepts within a band.
 */

// Gas for a signed activation with no calls (deploy clone + init + pay fee), for quoting before the
// calls are known. An activation is otherwise priced from its own simulation (vault/activate). The
// owner's activateVault bills 213,752 on mainnet and Base and the signed path adds at most
// SIGNED_ACTIVATION_OVERHEAD_GAS; this was 600,000 — an earlier factory's cost — which charged every
// activation for over twice its gas. Mirrors web lib/activation-fee.
export const ACTIVATION_GAS = BigInt(290_000);
// What the signed entry point costs over the owner's own activateVault: the signature check and the
// fee transfer. Measured on every signed activation so far (29k–68k), rounded up. Must match the
// server's figure (web lib/activation-fee), which quotes the same way.
export const SIGNED_ACTIVATION_OVERHEAD_GAS = BigInt(70_000);
// 1.2x margin over measured cost.
const ACTIVATION_MARGIN_BPS = BigInt(2000);

/**
 * What activating a vault costs, on every chain: a flat $1, whatever the deployment's gas. The
 * owner's first operations, when they ride on the activation, are charged for their own gas on top,
 * as any relayed operation is (see vault/activate `priceActivation`). Mirrors web lib/activation-fee,
 * whose server expects exactly this.
 */
export const ACTIVATION_FEE_USD = 1;

/** {ACTIVATION_FEE_USD} in a coin of `decimals`. */
export const activationFlatUnits = (decimals: number): bigint => BigInt(ACTIVATION_FEE_USD) * BigInt(10) ** BigInt(decimals);

/** {ACTIVATION_FEE_USD} in the native coin's smallest unit (wei, sun) at `nativeUsd`, rounded up. */
export function activationFlatNative(nativeUsd: number, nativeDecimals: number): bigint {
  const price = BigInt(Math.round(nativeUsd * 1e6));
  const num = BigInt(ACTIVATION_FEE_USD) * BigInt(1_000_000) * BigInt(10) ** BigInt(nativeDecimals);
  return (num + price - BigInt(1)) / price;
}
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
  /** Decimals of the coin gas is priced in: 18 for ETH, 6 for TRX (sun). */
  nativeDecimals = 18,
  /** Over the gas cost, in basis points. */
  marginBps: bigint = ACTIVATION_MARGIN_BPS,
): bigint {
  const weiCost = ((gasUnits * gasPriceWei + l1FeeWei) * (BPS + marginBps)) / BPS;
  const usdMicro = (weiCost * BigInt(Math.round(ethUsd * 1e6))) / BigInt(10) ** BigInt(nativeDecimals);
  const exact = (usdMicro * BigInt(10) ** BigInt(decimals)) / MICRO;
  return roundUpToCents(exact, decimals);
}

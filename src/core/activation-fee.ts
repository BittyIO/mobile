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
 * The margin an activation is signed with on `tron`: none on Tron, 20% elsewhere.
 *
 * The margin is there for gas moving between the quote and the block. Tron has no fee market: one
 * energy price (100 sun), changed only by a network vote, and the node's estimate (218,933 for a
 * plain activation on Nile) sits within 3% of what it then burns (212,298). So the fee is the cost
 * and no more, and the relayer — which accepts down to 0.3x its own quote — takes it.
 */
export const activationMarginBps = (tron: boolean): bigint => (tron ? BigInt(0) : ACTIVATION_MARGIN_BPS);
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
  /** Over the gas cost, in basis points. 0 on Tron: see {activationMarginBps}. */
  marginBps: bigint = ACTIVATION_MARGIN_BPS,
): bigint {
  const weiCost = ((gasUnits * gasPriceWei + l1FeeWei) * (BPS + marginBps)) / BPS;
  const usdMicro = (weiCost * BigInt(Math.round(ethUsd * 1e6))) / BigInt(10) ** BigInt(nativeDecimals);
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

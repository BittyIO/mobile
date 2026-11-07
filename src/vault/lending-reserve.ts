import {useEffect, useState} from 'react';
import {keccak256, parseAbi, toBytes, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';

/**
 * Whether a lending pool will take a deposit of `asset` right now — the web's useLendingReserve.
 *
 * Aave governance can freeze a reserve without notice (it froze its reserves for about 14 hours on
 * 29–30 Oct 2026). A frozen reserve still pays out withdrawals but reverts every supply, and the
 * revert reached the user as the vault's "check the allow list" sentence. So the form reads the
 * reserve first and says so before anything is signed.
 *
 * Found through the adapter's own `poolDataProvider()`, so this follows whichever market the adapter
 * was deployed against. An adapter without one (Sky, Lido) answers null, as does a failed read.
 */
export type ReserveState = 'open' | 'frozen' | 'paused' | 'inactive';

const ADAPTER_ABI = parseAbi(['function poolDataProvider() view returns (address)']);
const DATA_PROVIDER_ABI = parseAbi([
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  'function getPaused(address asset) view returns (bool)',
]);

export async function readReserveState(network: Network, adapter: Address, asset: Address): Promise<ReserveState | null> {
  const client = publicClientFor(network);
  let provider: Address;
  try {
    provider = await client.readContract({address: adapter, abi: ADAPTER_ABI, functionName: 'poolDataProvider'});
  } catch {
    return null;
  }
  try {
    const [cfg, paused] = await Promise.all([
      client.readContract({address: provider, abi: DATA_PROVIDER_ABI, functionName: 'getReserveConfigurationData', args: [asset]}),
      // Older data providers have no getPaused; a pause then shows up as the revert instead.
      client.readContract({address: provider, abi: DATA_PROVIDER_ABI, functionName: 'getPaused', args: [asset]}).catch(() => false),
    ]);
    if (!cfg[8]) return 'inactive';
    if (paused) return 'paused';
    if (cfg[9]) return 'frozen';
    return 'open';
  } catch {
    return null;
  }
}

export function useLendingReserve(network: Network, adapter: Address | null | undefined, asset: Address | null | undefined): ReserveState | null {
  const [state, setState] = useState<ReserveState | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    if (!adapter || !asset) return;
    readReserveState(network, adapter, asset).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [network, adapter, asset]);
  return state;
}

/**
 * Aave's own reverts, as the `mobile.earn.*` sentence for each. From v3.2 they are custom errors,
 * and relayed through an adapter they arrive as a bare selector no vault ABI names.
 */
const POOL_ERRORS: Record<string, string> = {
  ReserveFrozen: 'mobile.earn.reserve_frozen',
  ReservePaused: 'mobile.earn.reserve_paused',
  ReserveInactive: 'mobile.earn.reserve_inactive',
  SupplyCapExceeded: 'mobile.earn.supply_cap_reached',
};
const POOL_ERROR_BY_SELECTOR: Record<string, string> = Object.fromEntries(
  Object.keys(POOL_ERRORS).map((name) => [keccak256(toBytes(`${name}()`)).slice(0, 10), name]),
);

/** The translation key for a lending-pool revert named or selected anywhere in `text`; null otherwise. */
export function lendingPoolRevert(text: string | undefined): string | null {
  if (!text) return null;
  for (const m of text.match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? []) {
    if (POOL_ERRORS[m]) return POOL_ERRORS[m];
  }
  for (const hex of text.match(/0x[0-9a-fA-F]{8}\b/g) ?? []) {
    const name = POOL_ERROR_BY_SELECTOR[hex.toLowerCase()];
    if (name) return POOL_ERRORS[name];
  }
  return null;
}

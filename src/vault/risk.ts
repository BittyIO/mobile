/**
 * Owner risk & controls — the small cluster of protective/utility owner writes.
 *
 *  Payment risk (governs the owner's & operators' payments):
 *   - newPaymentProtection: seconds a NEW scheduled/whitelisted payment must age before it's payable.
 *   - maxSendValue: cap in WHOLE stablecoin tokens on cumulative one-off sends (0 = unrestricted).
 *   - maxSendInterval: rolling window (seconds) maxSendValue applies over (0 = per-transaction only).
 *   - changeTimelock: delay a LOOSENING of any control waits out (tightening is immediate).
 *  Each setter writes only its field (the other three go in as UNCHANGED = type(uint256).max) so the
 *  contract leaves them untouched.
 *
 *  Controls:
 *   - pauseTradingUntil(ts): block all trading until a unix second (panic switch).
 *   - wrapNative(): wrap native ETH the vault holds into WETH.
 *   - triggerAutoYield(asset): sweep an asset's idle balance into its configured yield route now.
 *
 * All relayed & gasless, Face-ID-gated at signing. Ported from web writePaymentRisk / getRiskConfig.
 */
import type {Address, Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_RISK_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

/** Leave a PaymentRisk field untouched. */
const UNCHANGED = (1n << 256n) - 1n; // type(uint256).max

export type RiskConfig = {
  newPaymentProtection: bigint; // seconds
  maxSendValue: bigint; // whole stablecoin tokens, 0 = unrestricted
  maxSendInterval: bigint; // seconds, 0 = per-transaction only
  changeTimelock: bigint; // seconds
};

const ZERO_RISK: RiskConfig = {
  newPaymentProtection: 0n,
  maxSendValue: 0n,
  maxSendInterval: 0n,
  changeTimelock: 0n,
};

/**
 * In-force payment-risk controls. NOTE the getter's tuple order is
 * (newPaymentProtection, maxSendValue, changeTimelock, maxSendInterval) — the last two are swapped
 * relative to the struct — so we map by position deliberately. Returns zeros for an un-activated vault.
 */
export async function getRiskConfig(vault: Address, network: Network): Promise<RiskConfig> {
  try {
    const client = publicClientFor(network);
    const r = (await client.readContract({
      address: vault,
      abi: VAULT_RISK_ABI,
      functionName: 'getRiskConfig',
    })) as readonly [bigint, bigint, bigint, bigint];
    return {
      newPaymentProtection: r[0],
      maxSendValue: r[1],
      changeTimelock: r[2],
      maxSendInterval: r[3],
    };
  } catch {
    return ZERO_RISK;
  }
}

type RiskField = keyof RiskConfig;

/** Write a single payment-risk field, leaving the other three UNCHANGED. */
async function writeRiskField(o: {
  account: Acct;
  vault: Address;
  network: Network;
  field: RiskField;
  value: bigint;
  stableCoin: Address;
}): Promise<Hex> {
  const update = {
    newPaymentProtection: o.field === 'newPaymentProtection' ? o.value : UNCHANGED,
    maxSendValue: o.field === 'maxSendValue' ? o.value : UNCHANGED,
    maxSendInterval: o.field === 'maxSendInterval' ? o.value : UNCHANGED,
    changeTimelock: o.field === 'changeTimelock' ? o.value : UNCHANGED,
  };
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName: 'updatePaymentRisk',
    args: [update],
    stableCoin: o.stableCoin,
  });
  return hash;
}

type FieldArgs = {account: Acct; vault: Address; network: Network; value: bigint; stableCoin: Address};

/** Seconds a new payment must age before it can be paid. Higher = safer. */
export const setNewPaymentProtection = (o: FieldArgs) =>
  writeRiskField({...o, field: 'newPaymentProtection'});
/** Cap on cumulative one-off sends in whole stablecoin tokens (0 = unrestricted). */
export const setMaxSendValue = (o: FieldArgs) => writeRiskField({...o, field: 'maxSendValue'});
/** Rolling window (seconds) maxSendValue caps sends over (0 = per-transaction only). */
export const setMaxSendInterval = (o: FieldArgs) => writeRiskField({...o, field: 'maxSendInterval'});
/** Delay (seconds) a loosening of any control must wait. Higher = safer. */
export const setChangeTimelock = (o: FieldArgs) => writeRiskField({...o, field: 'changeTimelock'});

/** Unix second until which trading is paused (0 / past = trading enabled). 0 on read failure. */
export async function getTradeDisabledUntil(vault: Address, network: Network): Promise<bigint> {
  try {
    const client = publicClientFor(network);
    return (await client.readContract({
      address: vault,
      abi: VAULT_RISK_ABI,
      functionName: 'tradeDisabledUntil',
    })) as bigint;
  } catch {
    return 0n;
  }
}

/** Pause ALL trading until `timestamp` (unix seconds). Pass now/past to lift. */
export async function pauseTradingUntil(o: {
  account: Acct;
  vault: Address;
  network: Network;
  timestamp: bigint;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName: 'disableTradeUntilTimestamp',
    args: [o.timestamp],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Wrap native ETH the vault holds into WETH. */
export async function wrapNative(o: {
  account: Acct;
  vault: Address;
  network: Network;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName: 'wrapNative',
    args: [],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Sweep an asset's idle balance into its configured auto-yield route now. */
export async function triggerAutoYield(o: {
  account: Acct;
  vault: Address;
  network: Network;
  asset: Address;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName: 'autoYield',
    args: [o.asset],
    stableCoin: o.stableCoin,
  });
  return hash;
}

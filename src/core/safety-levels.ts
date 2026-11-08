import type {RiskField} from '@/vault/risk';
import {NEW_VAULT_LOSS_ALLOWANCE} from '@/vault/activate';

/**
 * The vault's three risk numbers, each set on its own page (Security › Timelock, Send to new in
 * 24 hours, Market trade slippage in 24 hours). There are no preset levels.
 */
export type RiskValues = Record<RiskField, bigint>;

const DAY = 86_400n;

export const RISK_FIELDS: RiskField[] = ['timelock', 'sendDailyAllowance', 'marketTradeDailyLossAllowance'];

/**
 * What a vault not activated yet starts on (vault 1.0.9 and later, which every network now creates):
 * a 1-day timelock, sends to new addresses off, and market-trade slippage at
 * {NEW_VAULT_LOSS_ALLOWANCE}.
 */
const NEW_VAULT: RiskValues = {timelock: DAY, sendDailyAllowance: 0n, marketTradeDailyLossAllowance: NEW_VAULT_LOSS_ALLOWANCE};

/**
 * The numbers in force, from a risk read. A read that did not land is a vault not activated yet,
 * shown as what it will start on. An allowance of 0 that was read is real: the owner turned regular
 * sends or market trading off. A timelock never set reads 0 and means the vault's 1 day.
 */
export function valuesInForce(r: RiskValues & {read: boolean}): RiskValues {
  if (!r.read) return {...NEW_VAULT};
  return {
    timelock: r.timelock || NEW_VAULT.timelock,
    sendDailyAllowance: r.sendDailyAllowance,
    marketTradeDailyLossAllowance: r.marketTradeDailyLossAllowance,
  };
}

/** Whether moving `field` from `from` to `to` loosens it, and so waits out the timelock. */
export function isLoosening(field: RiskField, from: bigint, to: bigint): boolean {
  return field === 'timelock' ? to < from : to > from;
}

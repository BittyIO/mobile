import type {RiskField} from '@/vault/risk';
import type {Colors} from '@/theme';

/**
 * The three ready-made safety levels a v1.0.0+ vault can be set to, and Custom for anything else.
 *
 * A level is nothing but the three risk numbers, so it is never stored: the vault's level is read
 * back from its values ({levelOf}), and a vault whose numbers match no preset is Custom. Standard is
 * exactly the vault's own on-chain default — 1 day and the largest allowances — so a vault nobody
 * has configured reads as Standard.
 *
 * Named for how safe the vault is, never for risk, and coloured from safe (green) to standard
 * (amber); there is no red, because none of these is a danger.
 */
export type SafetyLevel = 'maximum' | 'balanced' | 'standard';
export type SafetyLevelOrCustom = SafetyLevel | 'custom';

export type RiskValues = Record<RiskField, bigint>;

const DAY = 86_400n;

export const SAFETY_LEVELS: {id: SafetyLevel; values: RiskValues; recommended?: boolean}[] = [
  // Both allowances at 0: nothing goes to a new address and nothing trades at market — money leaves
  // only to a saved recipient, and trades go as limit orders. Needs a vault that accepts 0 (1.0.5+).
  {id: 'maximum', values: {timelock: 7n * DAY, sendDailyAllowance: 0n, marketTradeDailyLossAllowance: 0n}},
  {
    id: 'balanced',
    values: {timelock: 3n * DAY, sendDailyAllowance: 5_000n, marketTradeDailyLossAllowance: 5_000n},
    recommended: true,
  },
  {id: 'standard', values: {timelock: DAY, sendDailyAllowance: 10_000n, marketTradeDailyLossAllowance: 10_000n}},
];

export const RISK_FIELDS: RiskField[] = ['timelock', 'sendDailyAllowance', 'marketTradeDailyLossAllowance'];

const STANDARD = SAFETY_LEVELS.find((l) => l.id === 'standard')!.values;

/**
 * The numbers in force, from a risk read. A vault reads an unset number as its default, so a read
 * that did not land is a vault not activated yet, shown as the Standard it will start on. An
 * allowance of 0 that was read is real: the owner turned regular sends or market trading off.
 */
export function valuesInForce(r: RiskValues & {read: boolean}): RiskValues {
  if (!r.read) return {...STANDARD};
  return {
    timelock: r.timelock || STANDARD.timelock,
    sendDailyAllowance: r.sendDailyAllowance,
    marketTradeDailyLossAllowance: r.marketTradeDailyLossAllowance,
  };
}

/** The level these values are, or Custom when they match no preset exactly. */
export function levelOf(v: RiskValues): SafetyLevelOrCustom {
  const hit = SAFETY_LEVELS.find((l) => RISK_FIELDS.every((f) => l.values[f] === v[f]));
  return hit ? hit.id : 'custom';
}

/** The level's own colour: green, blue, amber, and grey for Custom. */
export function safetyColor(level: SafetyLevelOrCustom, c: Colors): string {
  switch (level) {
    case 'maximum':
      return c.success;
    case 'balanced':
      return c.accent;
    case 'standard':
      return c.warning;
    case 'custom':
      return c.subtext;
  }
}

export const SAFETY_TITLE: Record<SafetyLevelOrCustom, string> = {
  maximum: 'mobile.vault.safety_maximum',
  balanced: 'mobile.vault.safety_balanced',
  standard: 'mobile.vault.safety_standard',
  custom: 'mobile.vault.safety_custom',
};

/**
 * Whether moving `field` from `from` to `to` is a loosening — the direction that waits out the
 * timelock in force. A shorter timelock, or a larger allowance.
 */
export function isLoosening(field: RiskField, from: bigint, to: bigint): boolean {
  return field === 'timelock' ? to < from : to > from;
}

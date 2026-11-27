import {NO_LIMIT} from '@/vault/capabilities';

/** The Guard levels: preset timelocks and daily limits, set together on Guard › Guard level. */
export type GuardLevel = 0 | 1 | 2 | 3 | 4;
export const GUARD_LEVEL_LIST: GuardLevel[] = [0, 1, 2, 3, 4];
/** Which shield colour: a level's own (see GuardShield), a custom mix's nearest by its timelock. */
export type ShieldKind = GuardLevel;

const DAY = 86_400n;
export type GuardValues = {timelock: bigint; sendDailyAllowance: bigint; marketTradeDailyLossAllowance: bigint};

/**
 * The Guard levels. None is a 1.2.0 vault's start: no timelock, no limits. Above none a timelock
 * needs both daily limits to be amounts (TimelockNeedsLimits), so every other level sets all three.
 * Highest turns both limits off ($0): nothing to new addresses, and no trading or bridging.
 */
export const GUARD_LEVELS: Record<GuardLevel, GuardValues> = {
  0: {timelock: 0n, sendDailyAllowance: NO_LIMIT, marketTradeDailyLossAllowance: NO_LIMIT},
  1: {timelock: DAY, sendDailyAllowance: 10_000n, marketTradeDailyLossAllowance: 10_000n},
  2: {timelock: 3n * DAY, sendDailyAllowance: 5_000n, marketTradeDailyLossAllowance: 5_000n},
  3: {timelock: 5n * DAY, sendDailyAllowance: 1_000n, marketTradeDailyLossAllowance: 1_000n},
  4: {timelock: 7n * DAY, sendDailyAllowance: 0n, marketTradeDailyLossAllowance: 0n},
};

export const sameGuardValues = (a: GuardValues, b: GuardValues) =>
  a.timelock === b.timelock && a.sendDailyAllowance === b.sendDailyAllowance && a.marketTradeDailyLossAllowance === b.marketTradeDailyLossAllowance;

/** The level a vault's numbers are exactly, or 'custom' for any other mix. */
export function guardLevelOf(v: GuardValues): GuardLevel | 'custom' {
  const hit = GUARD_LEVEL_LIST.find((l) => sameGuardValues(v, GUARD_LEVELS[l]));
  return hit ?? 'custom';
}

/**
 * The shield a vault's numbers earn: a level's own, and a custom mix the level its timelock reaches —
 * none (grey, and the red dot on Overview's Guard), 1 day, 3, 5, 7.
 */
export function guardShieldOf(v: GuardValues): ShieldKind {
  const exact = guardLevelOf(v);
  if (exact !== 'custom') return exact;
  return v.timelock === 0n ? 0 : v.timelock < 3n * DAY ? 1 : v.timelock < 5n * DAY ? 2 : v.timelock < 7n * DAY ? 3 : 4;
}

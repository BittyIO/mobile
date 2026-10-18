import type {RiskConfig, RiskField} from '@/vault/risk';

type T = (key: string, params?: Record<string, string | number>) => string;

/** Each risk field's name; its explanation is the same key with `_hint`. */
export const RISK_TITLE = {
  timelock: 'mobile.vault.change_timelock',
  sendDailyAllowance: 'mobile.vault.send_daily_allowance',
  marketTradeDailyLossAllowance: 'mobile.vault.market_trade_loss_allowance',
} as const satisfies Record<RiskField, string>;

/**
 * The explanation under a risk field. A v1.0.0 vault bounds every number and has no "off", so its
 * timelock and send cap get their own text; v1.0.3 keeps the one that explains 0. The loss allowance
 * exists on v1.0.0 only.
 */
export function riskHintKey(field: RiskField, bounded: boolean): string {
  if (!bounded || field === 'marketTradeDailyLossAllowance') return `${RISK_TITLE[field]}_hint`;
  return field === 'timelock' ? 'mobile.vault.change_timelock_bounded_hint' : 'mobile.vault.send_daily_allowance_bounded_hint';
}

const HOUR = 3600n;
const DAY = 86400n;

/** A timelock as a person would say it: none, whole days when it is days, otherwise hours. */
export function fmtDuration(s: bigint, t: T): string {
  if (s === 0n) return t('vault.none');
  if (s % DAY === 0n) return t('mobile.vault.duration_days', {n: Number(s / DAY)});
  const h = Number(s) / Number(HOUR);
  return t('mobile.vault.duration_hours', {n: Number.isInteger(h) ? h : Number(h.toFixed(2))});
}

/**
 * The send cap: whole USD on v1.0.0; on v1.0.3 stablecoin tokens, over a window that may not be a
 * day. 0 is no cap on both.
 */
export function fmtAllowance(v: bigint, risk: RiskConfig | null, symbol: string | undefined, t: T): string {
  if (v === 0n) return t('mobile.vault.no_cap');
  const n = Number(v).toLocaleString();
  if (risk?.hasLocks !== false) return `$${n}`;
  const per = risk.window === DAY ? t('mobile.vault.day') : fmtDuration(risk.window, t);
  return `${n} ${symbol ?? t('mobile.vault.tokens')} / ${per}`;
}

/** The market-trade loss cap, whole USD on v1.0.0 only. 0 leaves the protection off. */
export function fmtLossAllowance(v: bigint, t: T): string {
  return v === 0n ? t('mobile.vault.protection_off') : `$${Number(v).toLocaleString()}`;
}

export function fmtRiskValue(field: RiskField, v: bigint, risk: RiskConfig | null, symbol: string | undefined, t: T): string {
  if (field === 'timelock') return fmtDuration(v, t);
  if (field === 'marketTradeDailyLossAllowance') return fmtLossAllowance(v, t);
  return fmtAllowance(v, risk, symbol, t);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What is left, to the second: "2 days 03:12:45", or "03:12:45" inside the last day. Null once it
 * has run out.
 */
export function fmtCountdown(leftSeconds: number, t: T): string | null {
  if (leftSeconds <= 0) return null;
  const days = Math.floor(leftSeconds / 86_400);
  const clock = `${pad(Math.floor((leftSeconds % 86_400) / 3600))}:${pad(Math.floor((leftSeconds % 3600) / 60))}:${pad(leftSeconds % 60)}`;
  return days > 0 ? `${t('mobile.vault.duration_days', {n: days})} ${clock}` : clock;
}

/** "Pending: 48 hours · applies on 18/10/2026" for a loosening still waiting, else undefined. */
export function fmtPending(field: RiskField, risk: RiskConfig | null, symbol: string | undefined, t: T): string | undefined {
  const p = risk?.pending[field];
  if (!p) return undefined;
  const when = t('mobile.vault.on_date', {date: new Date(Number(p.at) * 1000).toLocaleDateString()});
  return `${t('mobile.vault.pending_timelock')}: ${fmtRiskValue(field, p.value, risk, symbol, t)} · ${t('mobile.vault.applies', {when})}`;
}

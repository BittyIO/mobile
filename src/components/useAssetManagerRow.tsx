import {ASSET_MANAGER_PERMS, ASSET_MANAGER_ALL_PERMISSIONS} from '@/core/abi';

type T = (key: string, params?: Record<string, string | number>) => string;

export const isSet = (a?: string) => !!a && !/^0x0+$/.test(a);

/**
 * Expiry choices for an appointment, in days. There is no "never": the vault refuses a grant that
 * does not expire, so a leaked manager key stops mattering on its own.
 */
export const EXPIRIES: {label: string; days: number}[] = [
  {label: '30d', days: 30},
  {label: '90d', days: 90},
  {label: '1y', days: 365},
];

/** The four v1.0.0 permissions, in the order they are listed: trading first, then deposits. */
export const PERM_ROWS: {bit: number; key: string}[] = [
  {bit: ASSET_MANAGER_PERMS.marketTrade, key: 'mobile.vault.perm_market_trade'},
  {bit: ASSET_MANAGER_PERMS.intent, key: 'mobile.vault.perm_intent'},
  {bit: ASSET_MANAGER_PERMS.yield, key: 'mobile.vault.perm_yield'},
  {bit: ASSET_MANAGER_PERMS.supply, key: 'mobile.vault.perm_supply'},
];

/** "All permissions", "No permissions", or the granted ones joined: "Market trade · Yield". */
export function fmtPerms(mask: number, t: T): string {
  if ((mask & ASSET_MANAGER_ALL_PERMISSIONS) === ASSET_MANAGER_ALL_PERMISSIONS) return t('mobile.vault.perm_all');
  const on = PERM_ROWS.filter((p) => mask & p.bit).map((p) => t(p.key));
  return on.length ? on.join(' · ') : t('mobile.vault.perm_none');
}

/**
 * "until 18/10/2026" / "on 18/10/2026", "expired" once past. "no expiry" for 0 is only ever read
 * back from a v1.0.3 vault, the one generation that allowed a grant without one.
 */
export function fmtExpiry(expiresAt: bigint, t: T, mode: 'until' | 'on' = 'until'): string {
  if (expiresAt === 0n) return t('mobile.vault.no_expiry');
  const d = new Date(Number(expiresAt) * 1000);
  if (d < new Date()) return t('mobile.vault.expired');
  return t(mode === 'on' ? 'mobile.vault.on_date' : 'mobile.vault.until_date', {date: d.toLocaleDateString()});
}

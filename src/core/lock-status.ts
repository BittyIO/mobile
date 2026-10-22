import type {LockLevel} from '@/vault/risk';
import type {SettingsIconName} from '@/components/SettingsIcon';
import type {Colors} from '@/theme';

/**
 * The vault's lock, as the app names and shows it: Normal, Temporarily locked (the emergency lock,
 * which this key can undo) and Locked forever. One table, so the Security row, the Lock status page
 * and its actions cannot drift into three wordings, colours or icons for the same state.
 */
export const LOCK_TITLE: Record<LockLevel, string> = {
  0: 'mobile.vault.unlocked',
  1: 'mobile.vault.locked_emergency',
  2: 'mobile.vault.locked_forever',
};

/** The state's own colour: green for normal, amber for a lock that can be undone, red for one that cannot. */
export function lockColor(level: LockLevel, c: Colors): string {
  return level === 2 ? c.danger : level === 1 ? c.warning : c.success;
}

/** The state's icon, and the icon of the action that leads to it. */
export const LOCK_ICON: Record<LockLevel, SettingsIconName> = {0: 'lockOpen', 1: 'lockTemp', 2: 'lockForever'};

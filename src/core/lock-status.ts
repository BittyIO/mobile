import type {LockLevel} from '@/vault/risk';
import type {SettingsIconName} from '@/components/SettingsIcon';

/**
 * The vault's lock, as the app names and shows it: Normal, Temporarily locked (the emergency lock,
 * which this key can undo) and Locked forever. One table, so the Security row, the Lock status page
 * and its actions cannot drift into three wordings or icons for the same state.
 */
export const LOCK_TITLE: Record<LockLevel, string> = {
  0: 'mobile.vault.unlocked',
  1: 'mobile.vault.locked_emergency',
  2: 'mobile.vault.locked_forever',
};

/** The state's icon, and the icon of the action that leads to it. */
export const LOCK_ICON: Record<LockLevel, SettingsIconName> = {0: 'lockOpen', 1: 'lockTemp', 2: 'lockForever'};

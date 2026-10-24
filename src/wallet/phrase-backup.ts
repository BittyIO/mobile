import {getPref, setPref} from '@/core/prefs';

/**
 * Whether the owner has proved they wrote the recovery phrase down — by picking three of its words
 * back, at wallet creation or later on Security › Recovery phrase. Per key: a different phrase is a
 * different backup. A restored wallet counts as verified, since it was typed in from the backup.
 */
const keyOf = (address: string) => `wallet.phraseVerified:${address.toLowerCase()}`;

export const isPhraseVerified = (address: string | null | undefined): boolean =>
  !!address && getPref(keyOf(address)) === '1';

export function markPhraseVerified(address: string | null | undefined): void {
  if (address) setPref(keyOf(address), '1');
}

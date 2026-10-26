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

function randomIndex(max: number): number {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0] % max;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The choices offered for one position of the backup check: the right word and two others from the
 * phrase, in random order.
 *
 * Three, not the whole phrase. Twelve (or twenty-four) words under every question was a wall to
 * read through three times over; three is a quick pick that still cannot be passed without the
 * written copy, since the other two are real words of the same phrase.
 */
export function backupChoices(words: string[], position: number): string[] {
  const right = words[position - 1];
  const others = shuffle(Array.from(new Set(words.filter((w) => w !== right)))).slice(0, 2);
  return shuffle([right, ...others]);
}

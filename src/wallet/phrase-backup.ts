import {getPref, setPref} from '@/core/prefs';
import {useVaults} from '@/core/vault-store';

/**
 * Whether the owner has proved they wrote the recovery phrase down — by picking three of its words
 * back, at wallet creation or later on Security › Recovery phrase. A restored wallet counts as
 * verified, since it was typed in from the backup.
 *
 * Once for the PHRASE, not per vault. Every vault's key is the same phrase at another index, so
 * proving the words once proves them for all of them — keying the flag on the signing key's address
 * asked for the check again on every vault switched to. Cleared when the wallet is wiped (see
 * {forgetPhraseVerified}), since a device holds one phrase at a time.
 */
const PHRASE_KEY = 'wallet.phraseVerified';
/** Each phrase is proven on its own: the main one at {PHRASE_KEY} as before, another by its id. */
const keyFor = (phrase: string) => (phrase === 'main' ? PHRASE_KEY : `${PHRASE_KEY}.${phrase}`);
/** Where the flag lived before: one per key address. Still read, so a backup proven then counts. */
const legacyKeyOf = (address: string) => `wallet.phraseVerified:${address.toLowerCase()}`;

export function isPhraseVerified(phrase = 'main'): boolean {
  if (getPref(keyFor(phrase)) === '1') return true;
  if (phrase !== 'main') return false;
  // Proven under the old per-key flag, for any vault of this phrase: carry it over once.
  const keys = useVaults
    .getState()
    .vaults.filter((v) => !v.imported && !v.phrase)
    .flatMap((v) => (v.safe ? [v.signer] : [v.owner]))
    .filter((a): a is `0x${string}` => !!a);
  if (!keys.some((a) => getPref(legacyKeyOf(a)) === '1')) return false;
  markPhraseVerified();
  return true;
}

export function markPhraseVerified(phrase = 'main'): void {
  setPref(keyFor(phrase), '1');
}

/** The phrase is gone (or the whole wallet, with no argument): the next one here has not been proven. */
export function forgetPhraseVerified(phrase = 'main'): void {
  setPref(keyFor(phrase), '');
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

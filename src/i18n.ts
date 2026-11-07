import {useCallback} from 'react';
import {Platform} from 'react-native';
import en from '@/translations/en.json';
import zh from '@/translations/zh.json';
import zhTW from '@/translations/zh-TW.json';
import ja from '@/translations/ja.json';
import ko from '@/translations/ko.json';
import fr from '@/translations/fr.json';
import es from '@/translations/es.json';
import de from '@/translations/de.json';
// Added for the markets with the most crypto holders and the least English (see language-store).
// These files carry only the keys the app actually asks the web catalogue for — `resolve` falls
// back to English per key, so a partial file is a safe way to ship a language.
import ptBR from '@/translations/pt-BR.json';
import hi from '@/translations/hi.json';
import tr from '@/translations/tr.json';
import ru from '@/translations/ru.json';
import id from '@/translations/id.json';
import vi from '@/translations/vi.json';
import th from '@/translations/th.json';
import {useLanguage, type Language} from '@/core/language-store';
import {useCurrency} from '@/core/currency-store';
import {companyName} from '@/core/company-names';
import {MOBILE_STRINGS} from '@/translations/mobile';

// Translations. Two sources, looked up in this order:
//   1. Mobile-only strings, per screen, in src/translations/mobile/*.ts (keys "mobile.<ns>.<key>").
//   2. The web app's translation files (src/translations/*.json, copied from web/src/translations
//      and keyed the same way: "vault.buy", "common.available", ...), so every string the web
//      already has is reused rather than translated twice.
// A key missing in the chosen language falls back to English, then to the key itself, so a gap
// never renders as an empty label.

type Dict = Record<string, unknown>;
const WEB: Record<Language, Dict> = {en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, 'pt-BR': ptBR, hi, tr, ru, id, vi, th};

function lookup(dict: Dict | undefined, key: string): string | undefined {
  let v: unknown = dict;
  for (const part of key.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = (v as Dict)[part];
  }
  return typeof v === 'string' ? v : undefined;
}

/**
 * "Face ID" is Apple's name; Android unlocks with a fingerprint, the face, or the screen lock. The
 * strings are written once (for iOS), so on Android the term is swapped for each language's generic
 * word for biometric unlock rather than forking every string that names it.
 */
const BIOMETRIC_WORD: Record<Language, string> = {
  en: 'biometrics', zh: '生物识别', 'zh-TW': '生物辨識', ja: '生体認証', ko: '생체 인증',
  fr: 'biométrie', es: 'biometría', de: 'Biometrie', 'pt-BR': 'biometria', hi: 'बायोमेट्रिक',
  tr: 'biyometri', ru: 'биометрия', id: 'biometrik', vi: 'sinh trắc học', th: 'ไบโอเมตริกซ์',
};
const FACE_ID = /Face ID|面容 ?ID/g;

function platformTerms(language: Language, text: string): string {
  if (Platform.OS !== 'android' || !FACE_ID.test(text)) return text;
  FACE_ID.lastIndex = 0;
  return text.replace(FACE_ID, BIOMETRIC_WORD[language] ?? BIOMETRIC_WORD.en);
}

function resolve(language: Language, key: string): string | undefined {
  if (key.startsWith('mobile.')) {
    const [, ns, ...rest] = key.split('.');
    const table = MOBILE_STRINGS[ns];
    const k = rest.join('.');
    return table?.[language]?.[k] ?? table?.en?.[k];
  }
  return lookup(WEB[language], key) ?? lookup(WEB.en, key);
}

export function translate(language: Language, key: string, params?: Record<string, string | number>): string {
  // A key is sometimes looked up in a map before it gets here, and a map that has not kept up with
  // an enum hands over undefined. `resolve` then calls startsWith on it and the screen crashes
  // rather than showing one wrong label — which is how the Allow list page went down when the AMM
  // split added a protocol category. The type system is the real guard; this is so the next gap
  // is a visible string instead of a white screen.
  if (typeof key !== 'string' || !key) return '';
  let out = resolve(language, key);
  out = out === undefined ? key : platformTerms(language, out);
  if (params) {
    for (const [k, v] of Object.entries(params)) out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
}

/**
 * Scripts that do not put a space between words.
 *
 * Chinese and Japanese run words together: "Limit" + "Buy" is 限价买, not 限价 买, and a label
 * assembled with a space in the middle reads as two separate words stuck side by side. Korean
 * does space its words (지정가 매수) and Thai mixes a loanword with a verb clearly enough that a
 * space helps, so both keep it — this is the narrow set where the space is simply wrong.
 */
const NO_WORD_SPACE = new Set<Language>(['zh', 'zh-TW', 'ja']);

/**
 * Join label fragments the way the language writes them.
 *
 * The order badges are built from two translated pieces — the kind and the side — because the
 * alternative is six more keys ("limit buy", "limit sell", "market buy", …) in fifteen files,
 * each one a copy of two strings that already exist. What the pieces cannot carry is the join,
 * which is a property of the script and not of either word.
 */
export function joinWords(language: Language, ...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(NO_WORD_SPACE.has(language) ? '' : ' ');
}

/** `t("vault.buy")`, `t("mobile.settings.language")`; re-renders when the language changes. */
export function useT() {
  const language = useLanguage((s) => s.language);
  /**
   * Also subscribed to the display currency and its FX table, deliberately: {fmtUsd} reads them
   * imperatively, so a screen printing fiat has no subscription of its own — and every screen that
   * prints fiat already calls this hook, exactly as `company` rides along above. Without it a
   * currency change in Settings repainted nothing until the next unrelated render.
   */
  useCurrency((s) => s.chosen);
  useCurrency((s) => s.fx);
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(language, key, params),
    [language],
  );
  /**
   * A tokenized stock's company name in the current language, falling back to the catalog's own.
   *
   * It rides along on this hook because every screen that shows a company name already calls it,
   * and the alternative is each of them reading the language and importing the table separately.
   */
  const company = useCallback(
    (symbol: string, fallback?: string) => companyName(symbol, fallback, language),
    [language],
  );
  /** `words(t('vault.limit'), t('mobile.trade.buy_short'))` → "Limit Buy", 限价买. */
  const words = useCallback(
    (...parts: (string | false | null | undefined)[]) => joinWords(language, ...parts),
    [language],
  );
  return {t, language, company, words};
}

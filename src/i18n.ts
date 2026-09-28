import {useCallback} from 'react';
import en from '@/translations/en.json';
import zh from '@/translations/zh.json';
import zhTW from '@/translations/zh-TW.json';
import ja from '@/translations/ja.json';
import ko from '@/translations/ko.json';
import fr from '@/translations/fr.json';
import es from '@/translations/es.json';
import de from '@/translations/de.json';
import {useLanguage, type Language} from '@/core/language-store';
import {MOBILE_STRINGS} from '@/translations/mobile';

// Translations. Two sources, looked up in this order:
//   1. Mobile-only strings, per screen, in src/translations/mobile/*.ts (keys "mobile.<ns>.<key>").
//   2. The web app's translation files (src/translations/*.json, copied from web/src/translations
//      and keyed the same way: "vault.buy", "common.available", ...), so every string the web
//      already has is reused rather than translated twice.
// A key missing in the chosen language falls back to English, then to the key itself, so a gap
// never renders as an empty label.

type Dict = Record<string, unknown>;
const WEB: Record<Language, Dict> = {en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de};

function lookup(dict: Dict | undefined, key: string): string | undefined {
  let v: unknown = dict;
  for (const part of key.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = (v as Dict)[part];
  }
  return typeof v === 'string' ? v : undefined;
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
  let out = resolve(language, key) ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
}

/** `t("vault.buy")`, `t("mobile.settings.language")`; re-renders when the language changes. */
export function useT() {
  const language = useLanguage((s) => s.language);
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(language, key, params),
    [language],
  );
  return {t, language};
}

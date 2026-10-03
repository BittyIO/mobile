import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

// The app's display language, chosen explicitly in Settings or defaulted from the device locale on
// first launch, and persisted so it survives relaunch. Screens read it through useLanguage(); date
// and number formatting take it as their locale.
//
// The first eight mirror the web's LanguageContext. The seven after them were picked from where
// crypto is actually held rather than from general internet population: Brazil is the largest
// market by Chainalysis' 2026 index and has no English fallback worth relying on; India is the
// largest by user count; Turkey, Vietnam and Indonesia combine very high ownership rates with low
// English penetration; Russian covers the CIS including Ukraine, a perennial top-ten; Thailand
// entered the 2026 top ten.
//
// Arabic is deliberately absent. The UAE has the world's highest ownership rate, but right-to-left
// is a layout problem rather than a translation one, and shipping the strings without mirroring
// the screens would be worse than not shipping them.

export type Language =
  | 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'fr' | 'es' | 'de'
  | 'pt-BR' | 'hi' | 'tr' | 'ru' | 'id' | 'vi' | 'th';

export const LANGUAGES: {code: Language; label: string}[] = [
  {code: 'en', label: 'English'},
  {code: 'zh', label: '简体中文'},
  {code: 'zh-TW', label: '繁體中文'},
  {code: 'ja', label: '日本語'},
  {code: 'ko', label: '한국어'},
  {code: 'fr', label: 'Français'},
  {code: 'es', label: 'Español'},
  {code: 'de', label: 'Deutsch'},
  {code: 'pt-BR', label: 'Português (Brasil)'},
  {code: 'hi', label: 'हिन्दी'},
  {code: 'tr', label: 'Türkçe'},
  {code: 'ru', label: 'Русский'},
  {code: 'id', label: 'Bahasa Indonesia'},
  {code: 'vi', label: 'Tiếng Việt'},
  {code: 'th', label: 'ไทย'},
];

const store = new MMKV({id: 'bitty.language'});
const KEY = 'language';

function deviceLanguage(): Language {
  let tag = 'en';
  try {
    tag = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    // Hermes without Intl data: English.
  }
  const lower = tag.toLowerCase();
  // Traditional Chinese regions map to zh-TW; every other Chinese tag to zh.
  if (lower.startsWith('zh')) {
    return /tw|hk|mo|hant/.test(lower) ? 'zh-TW' : 'zh';
  }
  // Portuguese is carried as pt-BR, the variant the market that needs it speaks; a phone set to
  // pt-PT gets it too, which is far better than falling through to English.
  if (lower.startsWith('pt')) return 'pt-BR';
  const base = lower.split('-')[0] as Language;
  return LANGUAGES.some((l) => l.code === base) ? base : 'en';
}

type LanguageState = {
  language: Language;
  setLanguage: (l: Language) => void;
};

export const useLanguage = create<LanguageState>((set) => ({
  language: (store.getString(KEY) as Language) ?? deviceLanguage(),
  setLanguage: (language) => {
    store.set(KEY, language);
    set({language});
  },
}));

export const languageLabel = (code: Language): string =>
  LANGUAGES.find((l) => l.code === code)?.label ?? code;

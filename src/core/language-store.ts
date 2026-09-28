import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

// The app's display language. Mirrors the web's LanguageContext: the same eight codes, chosen
// explicitly in Settings or defaulted from the device locale on first launch, and persisted so it
// survives relaunch. Screens read it through useLanguage(); date and number formatting take it as
// their locale.

export type Language = 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'fr' | 'es' | 'de';

export const LANGUAGES: {code: Language; label: string}[] = [
  {code: 'en', label: 'English'},
  {code: 'zh', label: '简体中文'},
  {code: 'zh-TW', label: '繁體中文'},
  {code: 'ja', label: '日本語'},
  {code: 'ko', label: '한국어'},
  {code: 'fr', label: 'Français'},
  {code: 'es', label: 'Español'},
  {code: 'de', label: 'Deutsch'},
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

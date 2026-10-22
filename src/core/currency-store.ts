import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';
import {API_BASE} from '@/core/chain';

// The DISPLAY currency — what fiat figures are printed in, chosen in Settings, US dollars until
// then. It is NOT tied to the language: someone reading the app in Chinese may well think in
// dollars, and switching language must never change the figures under them.
//
// It converts at the last moment, for display only: every price in the system stays a dollar
// figure (Chainlink, pools, CoinGecko all quote USD), and nothing that signs, quotes or submits
// ever passes through it. A missing rate therefore degrades to showing dollars, never to a wrong
// number.

export type Currency =
  | 'USD' | 'CNY' | 'TWD' | 'JPY' | 'KRW' | 'EUR'
  | 'BRL' | 'INR' | 'TRY' | 'RUB' | 'IDR' | 'VND' | 'THB'
  | 'GBP' | 'AUD' | 'CAD' | 'CHF' | 'HKD' | 'SGD' | 'NZD' | 'MXN';

/** Native-script labels, the way LANGUAGES carries its own. */
export const CURRENCIES: {code: Currency; label: string}[] = [
  {code: 'USD', label: 'US Dollar ($)'},
  {code: 'EUR', label: 'Euro (€)'},
  {code: 'CNY', label: '人民币 (¥)'},
  {code: 'TWD', label: '新台幣 (NT$)'},
  {code: 'JPY', label: '日本円 (¥)'},
  {code: 'KRW', label: '원화 (₩)'},
  {code: 'BRL', label: 'Real (R$)'},
  {code: 'INR', label: 'रुपया (₹)'},
  {code: 'TRY', label: 'Türk lirası (₺)'},
  {code: 'RUB', label: 'Рубль (₽)'},
  {code: 'IDR', label: 'Rupiah (Rp)'},
  {code: 'VND', label: 'Đồng (₫)'},
  {code: 'THB', label: 'บาท (฿)'},
  {code: 'GBP', label: 'British Pound (£)'},
  {code: 'AUD', label: 'Australian Dollar (A$)'},
  {code: 'CAD', label: 'Canadian Dollar (C$)'},
  {code: 'CHF', label: 'Swiss Franc (Fr)'},
  {code: 'HKD', label: 'Hong Kong Dollar (HK$)'},
  {code: 'SGD', label: 'Singapore Dollar (S$)'},
  {code: 'NZD', label: 'New Zealand Dollar (NZ$)'},
  {code: 'MXN', label: 'Mexican Peso ($)'},
];

export const currencyLabel = (code: Currency): string =>
  CURRENCIES.find((x) => x.code === code)?.label ?? code;

/**
 * The bare sign each currency prints with. Our own map, NOT Intl's: React Native's Hermes has no
 * currency-symbol data, so `toLocaleString({style:'currency'})` falls back to the ISO code ("CNY",
 * "TWD") — which is what showed on screen. These are the everyday signs a reader expects, with the
 * country tag dropped where a sign is shared (TWD prints "$", CNY "¥").
 */
export const CURRENCY_SYMBOL: Record<Currency, string> = {
  USD: '$',
  EUR: '€',
  CNY: '¥',
  TWD: '$',
  JPY: '¥',
  KRW: '₩',
  BRL: 'R$',
  INR: '₹',
  TRY: '₺',
  RUB: '₽',
  IDR: 'Rp',
  VND: '₫',
  THB: '฿',
  GBP: '£',
  // The dollar family prints a bare "$", as TWD does — the picker label (A$, C$, HK$ …) is where
  // they are told apart; on an amount the Settings choice already says which dollar it is.
  AUD: '$',
  CAD: '$',
  CHF: 'Fr',
  HKD: '$',
  SGD: '$',
  NZD: '$',
  MXN: '$',
};

const store = new MMKV({id: 'bitty.currency'});
const KEY = 'currency';
const RATES_KEY = 'rates';

type FxTable = {rates: Partial<Record<Currency, number>>; at: number};

function storedRates(): FxTable {
  try {
    const raw = store.getString(RATES_KEY);
    if (raw) return JSON.parse(raw) as FxTable;
  } catch {
    // A corrupt cache is an empty cache.
  }
  return {rates: {}, at: 0};
}

type CurrencyState = {
  /** The explicit choice, or null for US dollars. */
  chosen: Currency | null;
  /** USD → fiat multipliers, served by /api/fx and kept across launches. */
  fx: FxTable;
  setCurrency: (c: Currency) => void;
};

export const useCurrency = create<CurrencyState>((set) => ({
  chosen: (store.getString(KEY) as Currency) ?? null,
  fx: storedRates(),
  setCurrency: (c) => {
    store.set(KEY, c);
    set({chosen: c});
    // The rate for a fresh pick should be fresh too; a no-op if the table already is.
    void refreshFx();
  },
}));

/** Six hours, matching the server's own cache — the upstream updates daily. */
const FX_TTL_MS = 6 * 60 * 60 * 1000;
let fetching = false;

export async function refreshFx(): Promise<void> {
  const {fx} = useCurrency.getState();
  if (fetching || Date.now() - fx.at < FX_TTL_MS) return;
  fetching = true;
  try {
    const res = await fetch(`${API_BASE}/api/fx`);
    if (!res.ok) return;
    const j = (await res.json()) as FxTable;
    if (!j?.rates) return;
    const table = {rates: j.rates, at: Date.now()};
    store.set(RATES_KEY, JSON.stringify(table));
    useCurrency.setState({fx: table});
  } catch {
    // Offline: the stored table (or USD) stands.
  } finally {
    fetching = false;
  }
}
// Warm the table on startup; nothing waits on it — figures render in USD until it lands.
void refreshFx();

/** The currency in force: the explicit choice, else US dollars. */
export function displayCurrency(): Currency {
  return useCurrency.getState().chosen ?? 'USD';
}

/**
 * The conversion the formatters apply: currency and USD multiplier, resolved RIGHT NOW.
 *
 * Read imperatively by {fmtUsd} on every call rather than held anywhere, so a formatter can never
 * show one screen in two currencies. No rate yet (first launch, offline) falls back to dollars —
 * the only honest figure available — rather than converting by a guess.
 */
export function displayFx(): {currency: Currency; rate: number} {
  const currency = displayCurrency();
  if (currency === 'USD') return {currency, rate: 1};
  const rate = useCurrency.getState().fx.rates[currency];
  return rate && rate > 0 ? {currency, rate} : {currency: 'USD', rate: 1};
}

/** The display currency, as a subscription — for screens that show or pick it. */
export function useDisplayCurrency(): Currency {
  return useCurrency((s) => s.chosen) ?? 'USD';
}

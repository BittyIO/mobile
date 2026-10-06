import type {Language} from '@/core/language-store';

/**
 * Localised company names for the tokenized stocks.
 *
 * A ticker is universal but a company name is not: in Chinese, Costco is 好市多 and Nvidia is 英伟达,
 * and the English string beside the ticker reads as untranslated to anyone using the app in those
 * languages. Keyed by TICKER, which is stable, rather than by the English name, which differs
 * between issuers for the same company ("Circle" and "Circle Internet Group" are both in the
 * catalog).
 *
 * Only languages with a genuinely different, ESTABLISHED name are listed. Apple is Apple in French,
 * German and Spanish, and Circle, SpaceX and SharpLink are written in English in Chinese too — a
 * translation invented for them reads as wrong rather than as localised, so those fall through to
 * the catalog's own name. Traditional Chinese is listed separately wherever it differs
 * from Simplified — 英偉達 against 英伟达, and 好市多 shared by both.
 */
const NAMES: Partial<Record<string, Partial<Record<Language, string>>>> = {
  AAPL: {zh: '苹果', 'zh-TW': '蘋果', ja: 'アップル', ko: '애플'},
  AMD: {zh: '超威半导体', 'zh-TW': '超微半導體', ja: 'AMD', ko: 'AMD'},
  AMZN: {zh: '亚马逊', 'zh-TW': '亞馬遜', ja: 'アマゾン', ko: '아마존'},
  COIN: {ja: 'コインベース', ko: '코인베이스'},
  COST: {zh: '好市多', 'zh-TW': '好市多', ja: 'コストコ', ko: '코스트코'},
  CRCL: {ja: 'サークル', ko: '서클'},
  GLD: {zh: 'SPDR 黄金 ETF', 'zh-TW': 'SPDR 黃金 ETF', ja: 'SPDR ゴールド', ko: 'SPDR 골드'},
  GOOGL: {zh: '谷歌', 'zh-TW': '谷歌', ja: 'アルファベット', ko: '알파벳'},
  HOOD: {zh: '罗宾汉', 'zh-TW': '羅賓漢', ja: 'ロビンフッド', ko: '로빈후드'},
  INTC: {zh: '英特尔', 'zh-TW': '英特爾', ja: 'インテル', ko: '인텔'},
  META: {zh: 'Meta 平台', 'zh-TW': 'Meta 平台', ja: 'メタ', ko: '메타'},
  MSFT: {zh: '微软', 'zh-TW': '微軟', ja: 'マイクロソフト', ko: '마이크로소프트'},
  MSTR: {zh: 'Strategy（微策略）', 'zh-TW': 'Strategy（微策略）'},
  NFLX: {zh: '奈飞', 'zh-TW': '網飛', ja: 'ネットフリックス', ko: '넷플릭스'},
  NVDA: {zh: '英伟达', 'zh-TW': '英偉達', ja: 'エヌビディア', ko: '엔비디아'},
  PLTR: {ja: 'パランティア', ko: '팔란티어'},
  QQQ: {zh: '景顺 QQQ 信托', 'zh-TW': '景順 QQQ 信託'},
  SPCX: {ja: 'スペースX', ko: '스페이스X'},
  SPY: {zh: '标普 500 ETF', 'zh-TW': '標普 500 ETF', ja: 'S&P500 ETF', ko: 'S&P500 ETF'},
  TSLA: {zh: '特斯拉', 'zh-TW': '特斯拉', ja: 'テスラ', ko: '테슬라'},
  TSM: {zh: '台积电', 'zh-TW': '台積電', ja: 'TSMC', ko: 'TSMC'},
};

/**
 * A name for the assets the catalog does not name at all.
 *
 * Every tokenized stock carries the company it represents, but the crypto entries carry nothing,
 * so their rows showed a bare ticker while the stocks beside them read properly. These say what
 * the token IS — who issues it and what it stands for — which is the same question the company
 * name answers for a stock.
 *
 * The fallback is English; CRYPTO_NAMES below carries the Chinese. WETH is listed as plain Ether
 * because the app shows it as ETH (see displaySymbol) and never mentions wrapping.
 */
const UNNAMED: Record<string, string> = {
  USDC: 'USD by Circle Internet Group',
  USDT: 'USD by Tether',
  USDG: 'USD by Paxos',
  WBTC: 'Wrapped Bitcoin by BitGo',
  CBBTC: 'Wrapped Bitcoin by Coinbase',
  WETH: 'Ether',
  XAUT: 'Gold by Tether',
  UNI: 'Token of Uniswap',
  AAVE: 'Token of Aave',
};

/**
 * The Chinese for those same assets.
 *
 * The rule is to translate the noun and leave the brand in Latin script. Wrapped, token, stable
 * coin and gold all have settled Chinese terms; Circle, BitGo, Coinbase, Uniswap and Aave have no
 * Chinese names, and inventing one is how 圆环 happened. Tether is the exception, 泰达 being its
 * actual name, so its two tokens read entirely in Chinese.
 *
 * 封装 for wrapped, not 包装, which reads as physical packaging, and not 托管, which says custody
 * rather than what the token is. 以太币 for ether the currency rather than 以太坊, the network.
 */
const CRYPTO_NAMES: Record<string, {zh: string; 'zh-TW': string}> = {
  USDC: {zh: 'Circle 美元稳定币', 'zh-TW': 'Circle 美元穩定幣'},
  USDT: {zh: '泰达美元稳定币', 'zh-TW': '泰達美元穩定幣'},
  USDG: {zh: 'Paxos 美元稳定币', 'zh-TW': 'Paxos 美元穩定幣'},
  WBTC: {zh: 'BitGo 封装比特币', 'zh-TW': 'BitGo 封裝比特幣'},
  CBBTC: {zh: 'Coinbase 封装比特币', 'zh-TW': 'Coinbase 封裝比特幣'},
  WETH: {zh: '以太币', 'zh-TW': '以太幣'},
  XAUT: {zh: '泰达黄金', 'zh-TW': '泰達黃金'},
  UNI: {zh: 'Uniswap 代币', 'zh-TW': 'Uniswap 代幣'},
  AAVE: {zh: 'Aave 代币', 'zh-TW': 'Aave 代幣'},
};

/**
 * The company name to show beside a ticker, in the user's language.
 *
 * Falls back to the catalog's own name, so an asset added to the catalog tomorrow still shows
 * something rather than nothing, and a language with no entry keeps the English the company itself
 * uses.
 */
export function companyName(symbol: string, fallback: string | undefined, language: Language): string | undefined {
  const up = symbol.toUpperCase();
  if (language === 'zh' || language === 'zh-TW') {
    const cn = CRYPTO_NAMES[up]?.[language];
    if (cn) return cn;
  }
  return NAMES[up]?.[language] ?? fallback ?? UNNAMED[up];
}

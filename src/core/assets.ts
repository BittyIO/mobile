import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {shortAddress} from '@/core/format';

export type AssetKind = 'native' | 'crypto' | 'stable';

/** The web's broad grouping of assets (protocol-metadata AssetCategory); the Overview filters by it. */
export type AssetCategory = 'crypto_native' | 'stock' | 'etf';
export const ASSET_CATEGORIES: AssetCategory[] = ['crypto_native', 'stock', 'etf'];


/**
 * The catalog still carries the older, finer buckets, which fold into the three groups above —
 * here rather than in the data, so rows served by the assets API fold the same way.
 *
 * A crypto treasury company — Strategy, Coinbase, Circle, SharpLink, Bitmine — is a STOCK. It was
 * filed under Crypto on the grounds that someone browsing for crypto would look there, but the
 * thing being traded is a share in a listed company, and putting it beside ETH and WBTC made the
 * crypto tab a mix of two different kinds of instrument while the stock tab was missing its most
 * recognisable names.
 */
const MERGED: Record<string, AssetCategory> = {crypto_stock: 'stock', mega7: 'stock'};
export function assetCategory(category?: string): AssetCategory {
  const c = category ?? 'crypto_native';
  return MERGED[c] ?? (ASSET_CATEGORIES.includes(c as AssetCategory) ? (c as AssetCategory) : 'crypto_native');
}

export type Asset = {
  symbol: string;
  address: Address;
  decimals: number;
  kind: AssetKind;
  /** Grouping for the Overview's category filter; crypto_native when omitted. */
  category?: AssetCategory;
  // Underlying token name / fund the token represents (RWAs/tokenized stocks). Shown next to the ticker,
  // matching the web ("{symbol}" with "{tokenName}" beside it). Omit for plain crypto/stablecoins.
  tokenName?: string;
  // Remote icon URL from the DB catalog (API). Bundled entries omit it and fall back to the local
  // by-symbol icon in TokenIcon. Present only on assets hydrated from /api/ethereum/assets.
  icon?: string;
  // The asset's category bit field on the guard, served by the catalog API.
  // Absent on bundled rows and when the server could not read the guard. See {isAmmLiquid}.
  guardCategory?: number;
  // Whether the guard holds a price feed for it: served only for an AMM-liquid, non-stable row.
  // false makes it limit-only. See {isAmmLiquid}.
  priced?: boolean;
  /**
   * For a tokenized stock or fund, the token's own full name, ticker and issuer — "Apple (Ondo
   * Tokenized)", AAPLon, Ondo Global Markets — which the share's ticker and company name hide.
   * Served with the catalog; absent on bundled rows and on anything that is not an equity token.
   */
  fullName?: string;
  tokenSymbol?: string;
  issuer?: string;
};

/**
 * The vault's core assets per network, mirroring `web/src/utils/protocol-metadata.ts`. Kept compact for
 * the balances view — the Ondo tokenized stocks (limit-only) can be appended the same way later. When a
 * shared `packages/core` is extracted, this becomes a re-export.
 */
export const ASSETS: Record<Network, Asset[]> = {
  mainnet: [
    {symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, kind: 'crypto'},
    {symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, kind: 'crypto'},
    {symbol: 'XAUt', address: '0x68749665FF8D2d112Fa859AA293F07A622782F38', decimals: 6, kind: 'crypto'},
    {symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, kind: 'crypto'},
    {symbol: 'AAVE', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18, kind: 'crypto'},
    {symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, kind: 'stable'},
    {symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, kind: 'stable'},
    // Ondo Global Markets tokenized stocks, registered in the mainnet guard without the AMM-liquid
    // bit: limit / TWAP only (no pool to market-swap through).
    // Crypto treasury companies lead the stock list: Circle, Coinbase, SharpLink, Strategy,
    // Bitmine. They are stocks, and they are also the reason someone holding crypto is looking
    // at stocks at all — buried among the Mega 7 they were the hardest things here to find.
    {symbol: 'CRCL', tokenName: 'Circle Internet Group', address: '0x3632DEa96A953C11dac2f00b4A05a32CD1063fAE', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'COIN', tokenName: 'Coinbase', address: '0xF042cfa86cf1D598a75Bdb55c3507a1F39f9493b', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'SBET', tokenName: 'SharpLink Gaming', address: '0xfDb46864A7C476F0914c5E82CdED3364a9F56F8a', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'MSTR', tokenName: 'Strategy', address: '0xCabD955322dfbf94C084929ac5E9Eca3fEB5556F', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'BMNR', tokenName: 'Bitmine Immersion Technologies', address: '0x33483A58079b4225b10e57958Ca28ad7b9CDbAF7', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'AAPL', tokenName: 'Apple', address: '0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'MSFT', tokenName: 'Microsoft', address: '0xB812837b81a3a6b81d7CD74CfB19A7f2784555E5', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'GOOGL', tokenName: 'Alphabet', address: '0xbA47214eDd2bb43099611b208f75E4b42FDcfEDc', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'AMZN', tokenName: 'Amazon', address: '0xbb8774FB97436d23d74C1b882E8E9A69322cFD31', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'NVDA', tokenName: 'NVIDIA', address: '0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'META', tokenName: 'Meta Platforms', address: '0x59644165402b611b350645555B50Afb581C71EB2', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'TSLA', tokenName: 'Tesla', address: '0xf6b1117ec07684D3958caD8BEb1b302bfD21103f', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'PLTR', tokenName: 'Palantir Technologies', address: '0x0c666485b02F7A87d21AdD7AEb9F5e64975AA490', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'AMD', tokenName: 'Advanced Micro Devices', address: '0x0C1f3412A44Ff99E40bF14e06e5Ea321aE7B3938', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'TSM', tokenName: 'Taiwan Semiconductor', address: '0x3Cafdbfe682aec17d5acE2f97A2f3ab3dCf6a4A9', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'INTC', tokenName: 'Intel', address: '0xFdA09936DbD717368De0835bA441d9E62069d36f', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'QQQ', tokenName: 'Invesco QQQ Trust', address: '0x0e397938C1Aa0680954093495B70A9F5e2249aBa', decimals: 18, kind: 'crypto', category: 'etf'},
    {symbol: 'SPCX', tokenName: 'SpaceX', address: '0xc9eef266834730340A55B6CC24621B31BAF55581', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'NFLX', tokenName: 'Netflix', address: '0x032deC3372F25C41EA8054B4987a7c4832CDB338', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'HOOD', tokenName: 'Robinhood Markets', address: '0x998f02A9E343EF6E3E6f28700d5A20F839fD74E6', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'COST', tokenName: 'Costco', address: '0x0c8276E4FeC072cf7854Be69c70F7773D1610857', decimals: 18, kind: 'crypto', category: 'stock'},
  ],
  base: [
    {symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, kind: 'crypto'},
    {symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, kind: 'crypto'},
    {symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, kind: 'stable'},
    {symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, kind: 'stable'},
  ],
  // Robinhood Chain: USDG (Paxos's Global Dollar) is the chain's dollar; every pool quotes in it.
  robinhood: [
    {symbol: 'WETH', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18, kind: 'crypto'},
    {symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, kind: 'stable'},
    // Tokenized stocks — top holdings by Uniswap TVL on Robinhood Chain (all 18-decimal).
    {symbol: 'SPY', tokenName: 'SPDR S&P 500 ETF Trust', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18, kind: 'crypto', category: 'etf'},
    // Crypto-treasury stocks lead the stock run, as on mainnet: someone holding MSTR or CRCL
    // in a crypto vault is there for the crypto exposure, not for the S&P.
    {symbol: 'CRCL', tokenName: 'Circle', address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'MSTR', tokenName: 'Strategy (MicroStrategy)', address: '0xec262a75e413fAfD0dF80480274532C79D42da09', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'NVDA', tokenName: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'GLD', tokenName: 'SPDR Gold Shares', address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', decimals: 18, kind: 'crypto', category: 'etf'},
    {symbol: 'SPCX', tokenName: 'SpaceX', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'META', tokenName: 'Meta Platforms', address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'GOOGL', tokenName: 'Alphabet (Google)', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'AAPL', tokenName: 'Apple', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'TSLA', tokenName: 'Tesla', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'MSFT', tokenName: 'Microsoft', address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'AMZN', tokenName: 'Amazon', address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'cbBTC', address: '0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4', decimals: 8, kind: 'crypto', category: 'crypto_native'},
    {symbol: 'INTC', tokenName: 'Intel', address: '0xc72b96e0E48ecd4DC75E1e45396e26300BC39681', decimals: 18, kind: 'crypto', category: 'stock'},
    // HIMS, UNI and COST are gone: the guard unregistered them alongside vault 1.0.6, having no
    // Chainlink feed to value them by. Kept in {RETIRED_ASSETS} so their history still reads.
  ],
  sepolia: [
    {symbol: 'WETH', address: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9', decimals: 18, kind: 'crypto'},
    {symbol: 'WBTC', address: '0x29f2D40B0605204364af54EC677bD022dA425d03', decimals: 8, kind: 'crypto'},
    {symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, kind: 'stable'},
    {symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', decimals: 6, kind: 'stable'},
  ],
  // Arbitrum One: what the v1.0.0 guard registers (contracts guard/deployments/arbitrum.toml).
  // USDC is Circle's native one, USDT is USDT0.
  arbitrum: [
    {symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, kind: 'crypto'},
    {symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8, kind: 'crypto'},
    {symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, kind: 'stable'},
    {symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, kind: 'stable'},
  ],
  // What the Nile guard lists (guard repo deployments/tron-nile.json): Tether's Nile USDT
  // (TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf) and Wrapped TRX (TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a), the
  // gas token — WTRX is to TRX what WETH is to ETH. The 20 bytes behind each T… address.
  'tron-nile': [
    {symbol: 'WTRX', address: '0xfb3b3134F13CcD2C81F4012E53024e8135d58FeE', decimals: 6, kind: 'crypto'},
    {symbol: 'USDT', address: '0xECa9bC828A3005B9a3b909f2cc5c2a54794DE05F', decimals: 6, kind: 'stable'},
  ],
};

/** Bit 4 of the guard's asset category: there is a pool behind this token. */
const ASSET_AMM_LIQUID = 4;

/**
 * Whether this asset can be market-traded on this network (it has AMM liquidity).
 *
 * The answer is the guard's own category bit, which the catalog API reads off the guard and serves
 * on every row (`guardCategory`) — the vault enforces the swap
 * against the same bit. There is no bundled list to fall back to: one was kept here and on the
 * web and drifted from the guard twice. Before the catalog answers this is false; the Trade
 * screen waits for {ammLiquidKnown} before it treats that as "no".
 */
export function isAmmLiquid(network: Network, symbolOrAddress: string): boolean {
  const a = knownAssets(network).find(
    (x) => x.symbol === symbolOrAddress || x.address.toLowerCase() === symbolOrAddress.toLowerCase(),
  );
  // The vault values a non-stable leg off the guard's price feed and reverts without one, so an
  // asset flagged liquid with no feed is not market-tradeable either. Unknown
  // (an older server) is not "no".
  return a?.guardCategory != null && (a.guardCategory & ASSET_AMM_LIQUID) !== 0 && a.priced !== false;
}

/** Whether the catalog has delivered guard categories for this network yet. */
export function ammLiquidKnown(network: Network): boolean {
  return !!catalogued[network]?.some((a) => a.guardCategory != null);
}

// The app's one address formatter — see {shortAddress}. This used to be a shorter copy of it, so
// an unknown token's fallback name was cut differently from every other address on screen.
const short = shortAddress;

/** Resolve an asset's symbol/decimals by address. Unknown tokens fall back to 18 decimals. */
/**
 * Tokens a POSITION is held as: the Sky savings share and the Aave aTokens.
 *
 * They are never offered as assets to hold or trade, but the vault does hold them, and a limit order
 * funded from a position sells one directly — so their decimals and a readable symbol have to be
 * known, or an order row divides an aToken's 6-decimal amount by 1e18 and prints nothing. Each names
 * the asset it stands for, which is what makes it read as a stablecoin where that matters.
 */
export const RECEIPT_TOKENS: Record<Network, Record<string, {symbol: string; decimals: number; underlying: string}>> = {
  mainnet: {
    '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd': {symbol: 'sUSDS', decimals: 18, underlying: 'USDC'},
    '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c': {symbol: 'aUSDC', decimals: 6, underlying: 'USDC'},
    '0x23878914efe38d27c4d67ab83ed1b93a74d4086a': {symbol: 'aUSDT', decimals: 6, underlying: 'USDT'},
    '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8': {symbol: 'aWETH', decimals: 18, underlying: 'WETH'},
    '0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8': {symbol: 'aWBTC', decimals: 8, underlying: 'WBTC'},
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': {symbol: 'stETH', decimals: 18, underlying: 'WETH'},
  },
  base: {
    '0x5875eee11cf8398102fdad704c9e96607675467a': {symbol: 'sUSDS', decimals: 18, underlying: 'USDC'},
    '0x4e65fe4dba92790696d040ac24aa414708f5c0ab': {symbol: 'aUSDC', decimals: 6, underlying: 'USDC'},
    '0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7': {symbol: 'aWETH', decimals: 18, underlying: 'WETH'},
    '0xbdb9300b7cde636d9cd4aff00f6f009ffbbc8ee6': {symbol: 'acbBTC', decimals: 8, underlying: 'cbBTC'},
  },
  sepolia: {
    '0xaf0f6e8b0dc5c913bbf4d14c22b4e78dd14310b6': {symbol: 'aUSDT', decimals: 6, underlying: 'USDT'},
    '0x1804bf30507dc2eb3bdebbbdd859991eaef6eeff': {symbol: 'aWBTC', decimals: 8, underlying: 'WBTC'},
  },
  robinhood: {},
  arbitrum: {
    '0xddb46999f8891663a8f2828d25298f70416d7610': {symbol: 'sUSDS', decimals: 18, underlying: 'USDC'},
    '0x724dc807b04555b71ed48a6896b6f41593b8c637': {symbol: 'aUSDC', decimals: 6, underlying: 'USDC'},
    '0x6ab707aca953edaefbc4fd23ba73294241490620': {symbol: 'aUSDT', decimals: 6, underlying: 'USDT'},
    '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8': {symbol: 'aWETH', decimals: 18, underlying: 'WETH'},
    '0x078f358208685046a11c85e8ad32895ded33a249': {symbol: 'aWBTC', decimals: 8, underlying: 'WBTC'},
  },
  // No protocol on Tron, so nothing a vault holds there is a receipt for something else.
  'tron-nile': {},
};

/**
 * Tokens the guard has unregistered, kept only to NAME them: never offered, held to or traded, but
 * a past trade or transfer of one still has to read as the token, not a shortened address with a
 * guessed 18 decimals.
 */
const RETIRED_ASSETS: Partial<Record<Network, Asset[]>> = {
  robinhood: [
    {symbol: 'HIMS', tokenName: 'Hims & Hers Health', address: '0xCceE82fE024c36fA15E1005edE3E9e4787e23D09', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'UNI', address: '0xF177d86a28b520e3E396E4F3B96cd8e72D7dabd8', decimals: 18, kind: 'crypto', category: 'crypto_native'},
    {symbol: 'COST', tokenName: 'Costco', address: '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2', decimals: 18, kind: 'crypto', category: 'stock'},
  ],
};
const retiredAsset = (network: Network, address: string) =>
  RETIRED_ASSETS[network]?.find((x) => x.address.toLowerCase() === address.toLowerCase());

/** The asset a receipt token stands for, or null when the address is not one. */
export function underlyingOf(network: Network, address: string): string | null {
  return RECEIPT_TOKENS[network][address.toLowerCase()]?.underlying ?? null;
}

/**
 * Whether this build can NAME a token, rather than guess at it.
 *
 * {@link assetMeta} answers an address it does not recognise with a shortened form of the address
 * itself and a guessed 18 decimals — a reasonable last resort for a label, and useless for an
 * amount, since a 6-decimal token scaled by 1e18 prints nonsense. Anything that formats a value
 * should ask this first and decline to show the row at all.
 */
/**
 * Catalog rows, handed back here so the by-address lookups can see them.
 *
 * `asset-catalog` reads this module, so it cannot be read FROM here without a cycle — it pushes
 * instead. Without it the two halves disagreed: a screen listed an asset the catalog had added
 * while `assetMeta` looked it up in the bundled table, missed, and printed a shortened address
 * with 18 decimals — so a new token's history rows and toasts named a hex string and sized its
 * amounts wrongly.
 *
 * Bundled entries still win on a tie, since those are the ones the rest of this file reasons
 * about (categories, AMM liquidity, receipt tokens).
 */
const catalogued: Partial<Record<Network, Asset[]>> = {};

/**
 * Catalog icons by SYMBOL, built as the rows arrive.
 *
 * Almost every `<TokenIcon>` in the app is handed a symbol and nothing else — a history row, an
 * order leg, a picker — so an asset whose artwork is not in the binary had no way to reach its
 * URL and fell through to the lettered badge. Threading an `icon` prop through thirty call sites
 * would be thirty chances to miss one; the component asks here instead.
 */
const catalogIcons: Partial<Record<Network, Map<string, string>>> = {};

export function registerCatalogAssets(network: Network, list: Asset[]): void {
  catalogued[network] = list;
  catalogIcons[network] = new Map(
    list.filter((a) => a.icon).map((a) => [a.symbol.toUpperCase(), a.icon as string]),
  );
}

/** The catalog's icon URL for a symbol on this network, if it has one. */
export const catalogIcon = (network: Network, symbol: string): string | undefined =>
  catalogIcons[network]?.get(symbol.toUpperCase());

/**
 * Every asset the app knows on this network, in the bundled table's order.
 *
 * Where both have a row for an address, the CATALOG's fields win. The bundled strings are a
 * snapshot of the day this build was cut and they have already drifted: it calls TSM "Taiwan
 * Semiconductor", MSTR "Strategy" and AMD "Advanced Micro Devices", where the catalog — the same
 * rows the website reads — says TSMC, MicroStrategy and AMD. Two surfaces naming the same holding
 * differently is the bug, and only one of the two can be corrected without an app release.
 *
 * The bundled row is still what fills a gap: anything the catalog has not got, and everything,
 * before it has answered or when it cannot be reached.
 */
export function knownAssets(network: Network): Asset[] {
  const live = catalogued[network];
  if (!live?.length) return ASSETS[network];
  const byAddress = new Map(live.map((a) => [a.address.toLowerCase(), a]));
  const bundled = ASSETS[network].map((a) => {
    const row = byAddress.get(a.address.toLowerCase());
    // Field by field, not row for row: a catalog that omits something keeps the bundled answer
    // rather than blanking it.
    // Except what an amount is built from: the symbol the user picks by and the decimals a typed
    // amount is scaled by stay this build's own. A served row that changed either could turn
    // "send 1 USDC" into a far larger transfer.
    return row
      ? {...a, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)), symbol: a.symbol, decimals: a.decimals, address: a.address}
      : a;
  });
  const have = new Set(ASSETS[network].map((a) => a.address.toLowerCase()));
  return [...bundled, ...live.filter((a) => !have.has(a.address.toLowerCase()))];
}

export function isKnownAsset(network: Network, address: string): boolean {
  const a = address.toLowerCase();
  return knownAssets(network).some((x) => x.address.toLowerCase() === a) || !!RECEIPT_TOKENS[network][a] || !!retiredAsset(network, a);
}

export function assetMeta(
  network: Network,
  address: string,
): {symbol: string; decimals: number} {
  const a = knownAssets(network).find(
    (x) => x.address.toLowerCase() === address.toLowerCase(),
  );
  if (a) return {symbol: a.symbol, decimals: a.decimals};
  const r = RECEIPT_TOKENS[network][address.toLowerCase()] ?? retiredAsset(network, address);
  return r ? {symbol: r.symbol, decimals: r.decimals} : {symbol: short(address), decimals: 18};
}

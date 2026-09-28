import type {Address} from 'viem';
import type {Network} from '@/core/chain';

export type AssetKind = 'native' | 'crypto' | 'stable';

/** The web's broad grouping of assets (protocol-metadata AssetCategory); the Overview filters by it. */
export type AssetCategory = 'crypto_native' | 'crypto_stock' | 'mega7' | 'stock' | 'etf';
export const ASSET_CATEGORIES: AssetCategory[] = ['crypto_native', 'crypto_stock', 'mega7', 'stock', 'etf'];

export type Asset = {
  symbol: string;
  address: Address;
  decimals: number;
  kind: AssetKind;
  /** Grouping for the Overview's category filter; crypto_native when omitted. */
  category?: AssetCategory;
  // Underlying company / fund the token represents (RWAs/tokenized stocks). Shown next to the ticker,
  // matching the web ("{symbol}" with "{company}" beside it). Omit for plain crypto/stablecoins.
  company?: string;
  // Remote icon URL from the DB catalog (API). Bundled entries omit it and fall back to the local
  // by-symbol icon in TokenIcon. Present only on assets hydrated from /api/ethereum/assets.
  icon?: string;
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
    // Ondo Global Markets tokenized stocks, registered in the mainnet guard without the AMM-liquid bit:
    // limit / TWAP only (no pool to market-swap through), grouped by the web's categories.
    {symbol: 'CRCL', company: 'Circle Internet Group', address: '0x3632DEa96A953C11dac2f00b4A05a32CD1063fAE', decimals: 18, kind: 'crypto', category: 'crypto_stock'},
    {symbol: 'COIN', company: 'Coinbase', address: '0xF042cfa86cf1D598a75Bdb55c3507a1F39f9493b', decimals: 18, kind: 'crypto', category: 'crypto_stock'},
    {symbol: 'SBET', company: 'SharpLink Gaming', address: '0xfDb46864A7C476F0914c5E82CdED3364a9F56F8a', decimals: 18, kind: 'crypto', category: 'crypto_stock'},
    {symbol: 'AAPL', company: 'Apple', address: '0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'MSFT', company: 'Microsoft', address: '0xB812837b81a3a6b81d7CD74CfB19A7f2784555E5', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'GOOGL', company: 'Alphabet', address: '0xbA47214eDd2bb43099611b208f75E4b42FDcfEDc', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'AMZN', company: 'Amazon', address: '0xbb8774FB97436d23d74C1b882E8E9A69322cFD31', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'NVDA', company: 'NVIDIA', address: '0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'META', company: 'Meta Platforms', address: '0x59644165402b611b350645555B50Afb581C71EB2', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'TSLA', company: 'Tesla', address: '0xf6b1117ec07684D3958caD8BEb1b302bfD21103f', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'PLTR', company: 'Palantir Technologies', address: '0x0c666485b02F7A87d21AdD7AEb9F5e64975AA490', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'AMD', company: 'Advanced Micro Devices', address: '0x0C1f3412A44Ff99E40bF14e06e5Ea321aE7B3938', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'TSM', company: 'Taiwan Semiconductor', address: '0x3Cafdbfe682aec17d5acE2f97A2f3ab3dCf6a4A9', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'INTC', company: 'Intel', address: '0xFdA09936DbD717368De0835bA441d9E62069d36f', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'QQQ', company: 'Invesco QQQ Trust', address: '0x0e397938C1Aa0680954093495B70A9F5e2249aBa', decimals: 18, kind: 'crypto', category: 'etf'},
    {symbol: 'SPCX', company: 'SpaceX', address: '0xc9eef266834730340A55B6CC24621B31BAF55581', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'NFLX', company: 'Netflix', address: '0x032deC3372F25C41EA8054B4987a7c4832CDB338', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'HOOD', company: 'Robinhood Markets', address: '0x998f02A9E343EF6E3E6f28700d5A20F839fD74E6', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'MSTR', company: 'Strategy', address: '0xCabD955322dfbf94C084929ac5E9Eca3fEB5556F', decimals: 18, kind: 'crypto', category: 'crypto_stock'},
    {symbol: 'BMNR', company: 'Bitmine Immersion Technologies', address: '0x33483A58079b4225b10e57958Ca28ad7b9CDbAF7', decimals: 18, kind: 'crypto', category: 'crypto_stock'},
    {symbol: 'SNDK', company: 'Sandisk', address: '0x71E2400CF1Cb83204f33794eD326636A71a9AAfC', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'COST', company: 'Costco', address: '0x0c8276E4FeC072cf7854Be69c70F7773D1610857', decimals: 18, kind: 'crypto', category: 'stock'},
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
    {symbol: 'SPY', company: 'SPDR S&P 500 ETF Trust', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18, kind: 'crypto', category: 'etf'},
    {symbol: 'NVDA', company: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'GLD', company: 'SPDR Gold Shares', address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', decimals: 18, kind: 'crypto', category: 'etf'},
    {symbol: 'SPCX', company: 'SpaceX', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'META', company: 'Meta Platforms', address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'GOOGL', company: 'Alphabet (Google)', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'AAPL', company: 'Apple', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'HIMS', company: 'Hims & Hers Health', address: '0xCceE82fE024c36fA15E1005edE3E9e4787e23D09', decimals: 18, kind: 'crypto', category: 'stock'},
    {symbol: 'MSTR', company: 'Strategy (MicroStrategy)', address: '0xec262a75e413fAfD0dF80480274532C79D42da09', decimals: 18, kind: 'crypto', category: 'crypto_stock'},
    {symbol: 'TSLA', company: 'Tesla', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'MSFT', company: 'Microsoft', address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', decimals: 18, kind: 'crypto', category: 'mega7'},
    {symbol: 'AMZN', company: 'Amazon', address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', decimals: 18, kind: 'crypto', category: 'mega7'},
  ],
  sepolia: [
    {symbol: 'WETH', address: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9', decimals: 18, kind: 'crypto'},
    {symbol: 'WBTC', address: '0x29f2D40B0605204364af54EC677bD022dA425d03', decimals: 8, kind: 'crypto'},
    {symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, kind: 'stable'},
    {symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', decimals: 6, kind: 'stable'},
  ],
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Resolve an asset's symbol/decimals by address. Unknown tokens fall back to 18 decimals. */
export function assetMeta(
  network: Network,
  address: string,
): {symbol: string; decimals: number} {
  const a = ASSETS[network].find(
    (x) => x.address.toLowerCase() === address.toLowerCase(),
  );
  return a
    ? {symbol: a.symbol, decimals: a.decimals}
    : {symbol: short(address), decimals: 18};
}

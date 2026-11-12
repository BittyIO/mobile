/**
 * What a protocol IS, for the sheet its logo opens: which brand an adapter name belongs to, and that
 * brand's own app. The words are in translations/mobile/protocols, keyed by the same brand.
 *
 * Keyed by brand, not adapter: "Aave V3", "Uniswap Universal" and "Uniswap V4" are each one brand to a
 * user, and the catalog's versioned names ("Sky V1") would otherwise each need a line. UniswapX keeps
 * its own entry: it is not the pools, and the sheet says what it is used for.
 */
export type ProtocolBrand = 'sky' | 'lido' | 'aave' | 'uniswap' | 'uniswapx' | 'cow' | 'pancakeswap' | 'tronstake' | 'sunswap';

const APP_URL: Record<ProtocolBrand, string> = {
  sky: 'https://app.sky.money',
  lido: 'https://stake.lido.fi',
  aave: 'https://app.aave.com',
  uniswap: 'https://app.uniswap.org',
  uniswapx: 'https://app.uniswap.org',
  cow: 'https://swap.cow.fi',
  pancakeswap: 'https://pancakeswap.finance',
  // Tron's own staking (Stake 2.0), not a protocol with an app: its page on the network's site.
  tronstake: 'https://tron.network',
  sunswap: 'https://sun.io',
};

/** The brand behind an adapter name, or null for one there is nothing to say about yet. */
export function protocolBrand(name: string): ProtocolBrand | null {
  const n = name.trim().toLowerCase();
  if (n.startsWith('uniswapx')) return 'uniswapx';
  if (n.startsWith('uniswap')) return 'uniswap';
  if (n.startsWith('aave')) return 'aave';
  if (n.startsWith('lido')) return 'lido';
  if (n.startsWith('sky')) return 'sky';
  if (n.startsWith('cow')) return 'cow';
  // BNB Chain's market trades: the same trade adapter as Uniswap's, pointed at PancakeSwap's router.
  if (n.startsWith('pancake')) return 'pancakeswap';
  // Tron's native staking, through the vault's TRON Stake adapter.
  if (n.startsWith('tron stake')) return 'tronstake';
  // Tron's market trades: the same trade adapter as Uniswap's, pointed at SunSwap's router.
  if (n.startsWith('sunswap')) return 'sunswap';
  return null;
}

export const protocolAppUrl = (brand: ProtocolBrand) => APP_URL[brand];

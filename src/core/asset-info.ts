/**
 * What an asset IS, in a sentence or two — the thing a ticker and a price cannot tell you.
 *
 * Keyed by SYMBOL, not address, so one entry serves every network the asset appears on. The text
 * describes the company or the protocol only, never the wrapper: AAPL is Ondo's tokenized share on
 * mainnet and Robinhood's on its own chain, and a description that named the issuer would be wrong
 * on one of them. What kind of instrument it is comes from the catalog's own `kind` and `category`.
 *
 * ENGLISH ONLY for now. These are prose, not labels, and machine-translating two dozen of them into
 * fifteen languages would produce text nobody has read. The right home is a `description` column on
 * the assets catalog the server already serves, per locale; until then a missing entry simply means
 * no paragraph is shown, which is why every lookup is optional.
 */
const DESCRIPTIONS: Record<string, string> = {
  // --- crypto ---------------------------------------------------------------
  WETH: 'Ether, wrapped as an ERC-20 token so contracts can hold and move it like any other. The vault wraps ETH the moment it arrives, and shows the balance as ETH.',
  WBTC: 'Bitcoin held in custody and issued one-for-one as an ERC-20 token, so it can be used on Ethereum.',
  cbBTC: "Bitcoin held by Coinbase and issued one-for-one as an ERC-20 token on Base and Ethereum.",
  XAUt: 'A token backed one-for-one by physical gold held in Switzerland, issued by Tether. One unit tracks one troy ounce.',
  UNI: 'The governance token of Uniswap, the largest decentralised exchange on Ethereum. Holders vote on protocol changes and treasury spending.',
  AAVE: 'The governance token of Aave, a lending market where deposits earn interest and borrowers post collateral. Holders vote on the protocol and backstop it.',

  // --- stablecoins ----------------------------------------------------------
  USDC: 'A dollar stablecoin issued by Circle, redeemable one-for-one and backed by cash and short-term US Treasuries.',
  USDT: 'A dollar stablecoin issued by Tether, the largest by supply, redeemable one-for-one against its reserves.',
  USDG: 'A dollar stablecoin issued by Paxos under the Global Dollar Network, backed by cash and short-term US Treasuries.',

  // --- crypto-linked companies ---------------------------------------------
  COIN: 'Coinbase runs the largest regulated crypto exchange in the US, and earns from trading fees, custody and the Base network it operates.',
  CRCL: 'Circle issues USDC, the second-largest dollar stablecoin, and earns mostly from the interest on the reserves behind it.',
  MSTR: 'Strategy, formerly MicroStrategy, is a software company that has turned its balance sheet into a leveraged bitcoin holding — the largest of any public company.',
  SBET: 'SharpLink Gaming is a sports betting affiliate business that has adopted an Ethereum treasury strategy, holding ETH as its primary reserve asset.',
  BMNR: 'Bitmine Immersion Technologies builds and hosts immersion-cooled bitcoin mining rigs, and holds an Ethereum treasury.',
  HOOD: 'Robinhood is a retail brokerage built around commission-free trading of stocks, options and crypto, and runs its own chain for tokenized assets.',

  // --- large-cap technology -------------------------------------------------
  AAPL: 'Apple designs the iPhone, Mac and iPad, and runs the fast-growing services business — the App Store, iCloud, advertising — built on top of them.',
  MSFT: 'Microsoft sells Windows and Office, and runs Azure, the second-largest cloud platform. It is the largest commercial backer of OpenAI.',
  GOOGL: 'Alphabet owns Google Search, YouTube and Android, earns most of its money from advertising, and runs Google Cloud and the Gemini models.',
  AMZN: 'Amazon is the largest Western online retailer, and owns AWS, the biggest cloud platform — which supplies most of its operating profit.',
  META: 'Meta runs Facebook, Instagram and WhatsApp, earns almost entirely from advertising, and spends heavily on AI and on its Reality Labs headsets.',
  NVDA: 'NVIDIA designs the GPUs that nearly all large AI models are trained on, together with the CUDA software that locks the ecosystem to them.',
  AMD: 'AMD designs CPUs and GPUs that compete with Intel and NVIDIA, and has taken substantial server-processor share with its EPYC line.',
  INTC: 'Intel designs and — unlike its rivals — manufactures its own processors, and is spending heavily to sell that manufacturing capacity to others.',
  TSM: 'TSMC manufactures chips for almost everyone who designs them, Apple and NVIDIA included, and makes nearly all of the world’s most advanced nodes.',
  PLTR: 'Palantir sells data-analysis platforms to governments and large enterprises, and has grown quickly by packaging AI on top of them.',
  NFLX: 'Netflix is the largest subscription streaming service, and now earns from an advertising tier and from live events alongside subscriptions.',
  TSLA: 'Tesla is the largest Western electric-vehicle maker, and also sells grid-scale batteries and is betting on autonomy and robotics.',
  COST: 'Costco is a membership warehouse retailer whose profit comes largely from membership fees rather than from the goods themselves.',
  HIMS: 'Hims & Hers sells prescription treatments — hair loss, weight loss, mental health — directly to consumers by subscription.',
  SPCX: 'SpaceX builds and flies the Falcon and Starship rockets, launches more mass to orbit than everyone else combined, and operates the Starlink satellite internet network.',

  // --- funds ----------------------------------------------------------------
  QQQ: 'An index fund tracking the Nasdaq-100: the hundred largest non-financial companies listed on the Nasdaq, so it leans heavily towards technology.',
  SPY: 'An index fund tracking the S&P 500, the five hundred largest US listed companies — the standard proxy for the US stock market.',
  GLD: 'An index fund holding physical gold bullion, so one share tracks the gold price without the holder storing any metal.',
};

/** The description for a symbol, or undefined when there is none to show. */
export const assetDescription = (symbol: string): string | undefined => DESCRIPTIONS[symbol.toUpperCase()];

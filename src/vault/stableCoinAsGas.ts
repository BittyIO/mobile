/**
 * StableCoinAsGas config — which stable coins (and, from v1.0.2, the vault's WETH) the vault may be charged in for relayed ops. Ported from web
 * getStableCoinAsGasConfig / setStableCoinAsGas / toggleGasCoin. An EMPTY allowlist means "any guard-registered coin"
 * (the un-narrowed default); naming coins restricts to those; naming none turns relaying off.
 *
 * Changing the config is itself a relayed (gasless) write — a fresh activated vault already relays.
 */
import {apiUrl, publicClientFor, type Network} from '@/core/chain';
import {VAULT_STABLE_COIN_AS_GAS_ABI} from '@/core/abi';
import {bornVault, WETH_GAS_VERSION} from './activate';
import {relayVaultWrite} from './relay';
import {parseUnits, zeroAddress, type Address, type Hex} from 'viem';
import {knownAssets} from '@/core/assets';
import type {Asset} from '@/core/assets';
import {balanceOfSymbol, type VaultBalances} from './read';
import {feeCoinOrder, gasReserveSize} from '@/core/prefs';
import {stableCoinAsGasFunctionNames} from './manage';
import {useEffect, useState} from 'react';
import {ethUsd} from './fee-quote';

/**
 * `dailyLimit` and `maxFeePerOp` are whole dollars (the contract's uint64: 100 = $100/day, 10 = $10 per
 * operation; the vault reports the system default when the owner has not set a value). `remaining` and
 * `usedToday` are 18-decimal dollar amounts for the current UTC day.
 */
export type StableCoinAsGasConfig = {
  stableCoins: string[]; // allowlist; empty = any coin allowed
  dailyLimit: bigint;
  maxFeePerOp: bigint;
  remaining: bigint;
  usedToday: bigint;
  configured: boolean; // relaying actually on (dailyLimit > 0)
  weth: Address | null; // the vault's WETH, when it may pay too (v1.0.2+); null on older vaults
};

/** The contract's ceilings for the two caps (Constants.sol SYSTEM_DAILY_MAX_GAS_BUDGET / SYSTEM_MAX_FEE_PER_OP). */
export const STABLE_COIN_AS_GAS_MAX_DAILY = 100;
export const STABLE_COIN_AS_GAS_MAX_PER_OP = 10;

/**
 * What a relay actually costs, measured rather than guessed: an L2 relay runs to cents and a
 * mainnet one about 0.84 USDC. Kept as a note, not as a constant — what an operation LEAVES
 * BEHIND is the owner's setting now, which is a different question and a larger number. See
 * {reserveAgainst} and {gasReserve}.
 */

/**
 * What a vault that is not deployed yet will be born with: the system defaults, every coin allowed,
 * and — when the guard's latest vault implementation is a token-as-gas build — the WETH the factory
 * will hand it. See {bornVault}.
 */
async function bornConfig(network: Network): Promise<StableCoinAsGasConfig> {
  const born = await bornVault(network);
  const weth = born && born.version >= WETH_GAS_VERSION ? born.weth : null;
  const daily = BigInt(STABLE_COIN_AS_GAS_MAX_DAILY);
  return {
    stableCoins: [],
    dailyLimit: daily,
    maxFeePerOp: BigInt(STABLE_COIN_AS_GAS_MAX_PER_OP),
    remaining: daily * BigInt(10) ** BigInt(18),
    usedToday: BigInt(0),
    configured: true,
    weth,
  };
}

export async function getStableCoinAsGasConfig(
  vault: Address,
  network: Network,
): Promise<StableCoinAsGasConfig | null> {
  try {
    const client = publicClientFor(network);
    const code = await client.getCode({address: vault});
    if (!code || code === '0x') return await bornConfig(network);
    const names = await stableCoinAsGasFunctionNames(vault, network);
    let cfg: readonly [readonly Address[], bigint, bigint];
    let remaining: bigint;
    try {
      [cfg, remaining] = await client.multicall({
        contracts: [
          {address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: names.config},
          {address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: 'gasBudgetRemaining'},
        ] as const,
        allowFailure: false,
      });
    } catch {
      [cfg, remaining] = await Promise.all([
        client.readContract({address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: names.config}),
        client.readContract({address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: 'gasBudgetRemaining'}),
      ]);
    }
    const [stableCoins, dailyLimit, maxFeePerOp] = cfg;
    const limit18 = dailyLimit * BigInt(10) ** BigInt(18);
    const weth =
      names.config === 'tokenAsGasConfig'
        ? await client.readContract({address: vault, abi: VAULT_STABLE_COIN_AS_GAS_ABI, functionName: 'gasWrappedAddress'})
        : null;
    return {
      stableCoins: [...stableCoins],
      dailyLimit,
      maxFeePerOp,
      remaining,
      usedToday: remaining >= limit18 ? BigInt(0) : limit18 - remaining,
      configured: dailyLimit > BigInt(0),
      weth,
    };
  } catch {
    return null; // not activated / never configured
  }
}

/** Set the stable-coin allowlist (empty = any coin). Keeps the existing daily/per-op limits. */
export async function setStableCoinAsGasCoins(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  coins: Address[];
  dailyLimit: bigint;
  maxFeePerOp: bigint;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_STABLE_COIN_AS_GAS_ABI,
    functionName: (await stableCoinAsGasFunctionNames(o.vault, o.network)).set,
    args: [o.coins, o.dailyLimit, o.maxFeePerOp],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Turn relaying off entirely. */
export async function disableStableCoinAsGas(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_STABLE_COIN_AS_GAS_ABI,
    functionName: (await stableCoinAsGasFunctionNames(o.vault, o.network)).disable,
    args: [],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Set the daily budget and the per-operation cap (whole dollars), keeping the coin allowlist as is. */
export async function setStableCoinAsGasLimits(o: {
  account: Parameters<typeof relayVaultWrite>[0]['account'];
  vault: Address;
  network: Network;
  coins: Address[];
  dailyLimit: number;
  maxFeePerOp: number;
  stableCoin: Address;
}): Promise<Hex> {
  return setStableCoinAsGasCoins({...o, dailyLimit: BigInt(o.dailyLimit), maxFeePerOp: BigInt(o.maxFeePerOp)});
}

/** Tried in this order until the owner drags their own: the relayer's own first choice, then the rest. */
const PREFERRED = ['USDT', 'USDC', 'USDG'];

/** The owner's fee-coin order, upper-cased, or {PREFERRED} until they have set one. */
const preferred = (network: string, vault: string | null | undefined): string[] => {
  const order = feeCoinOrder(network, vault).map((s) => s.toUpperCase());
  return order.length ? order : PREFERRED;
};

/** The one fee coin that is not a dollar: the vault's WETH, from v1.0.2. */
export const FEE_WETH = 'WETH';
const WETH_REPRICE_MS = 15 * 60 * 1000;

/**
 * The vault's WETH as a coin the reserve can be held in, priced in dollars — or null.
 *
 * Null wherever WETH cannot actually pay: an older vault, relaying off, or an allowlist that names
 * only stablecoins. A float held in a coin the relayer may not bill is a float that protects
 * nothing. The price is the same Chainlink feed the fee quote reads, which is the feed the vault
 * values WETH charges off, so "ten dollars of WETH" means what the vault will count.
 */
export function useWethFeeCoin(network: Network, vault: Address | null | undefined): {usd: number} | null {
  const [coin, setCoin] = useState<{usd: number} | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    setCoin(null);
    if (!vault) return;
    getStableCoinAsGasConfig(vault, network)
      .then(async (cfg) => {
        const weth = cfg?.weth;
        if (!weth || !cfg.configured) return;
        const named = cfg.stableCoins.length === 0 || cfg.stableCoins.some((a) => a.toLowerCase() === weth.toLowerCase());
        if (!named) return;
        const read = () =>
          ethUsd(network)
            .then((usd) => live && usd > 0 && setCoin({usd}))
            .catch(() => {});
        await read();
        // Re-priced while the app stays open, so a WETH float reported to the keeper follows ETH.
        timer = setInterval(read, WETH_REPRICE_MS);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [network, vault]);
  return coin;
}

/**
 * Which stablecoin holds the fee float, and how much of it this operation must leave behind.
 *
 * The relayer bills its fee to a vault stablecoin AFTER the call runs, so an operation that spends
 * the last of the coin it will be billed in reverts at the charge with nothing wrong with the
 * operation itself — `fee-leg-failed`, and a long afternoon working out why.
 *
 * The coin follows the owner's fee-coin order (see {feeCoinOrder}, dragged on the Network fee page;
 * {PREFERRED} until they first drag): the first coin in it holding at least the reserve, then any
 * coin that does, then the one holding the most, then nothing. Only a coin the vault actually HOLDS
 * can hold the float, so it cannot land on a reserve that does not exist.
 *
 * Returns the coin either way, so a caller can SAY which one it is rather than only subtract it.
 */
export function resolveFeeReserve(opts: {
  network: string;
  vault: string | null | undefined;
  /**
   * Every fee coin the vault could hold, with what it holds of each. A stablecoin is a dollar; the
   * vault's WETH carries its `usd` price (see {useWethFeeCoin}) and is absent when it cannot pay.
   */
  heldStables: {symbol: string; amount: number; usd?: number}[];
  /** The coin this operation is spending, when there is one. */
  spendSymbol?: string;
}): {coin: string | null; size: number; keep: number} {
  const dollars = gasReserveSize(opts.network, opts.vault);
  const value = (h: {amount: number; usd?: number}) => h.amount * (h.usd ?? 1);
  const covers = (h: {amount: number; usd?: number}) => value(h) >= dollars;
  // Short of a coin that covers it, the one holding the most: a partial float still pays fees, and
  // "none" would let the keeper sweep the coin the relayer bills down to nothing.
  const largest = opts.heldStables.filter((h) => value(h) > 0).sort((a, b) => value(b) - value(a))[0]?.symbol;
  const auto =
    preferred(opts.network, opts.vault).map((p) => opts.heldStables.find((h) => h.symbol.toUpperCase() === p && covers(h))?.symbol).find(
      Boolean,
    ) ??
    opts.heldStables.find(covers)?.symbol ??
    largest;
  const coin = auto ?? null;
  // The setting is in dollars; what is held back is in the coin's own units. WETH with no price, or
  // on a vault where it cannot pay, holds nothing back rather than ten whole ether.
  const entry = coin ? opts.heldStables.find((h) => h.symbol.toUpperCase() === coin.toUpperCase()) : undefined;
  const usd = entry?.usd ?? (coin?.toUpperCase() === FEE_WETH ? 0 : 1);
  const size = usd > 0 ? dollars / usd : 0;
  if (!coin || !(size > 0)) return {coin, size, keep: 0};
  const keep = opts.spendSymbol && opts.spendSymbol.toUpperCase() === coin.toUpperCase() ? size : 0;
  return {coin, size, keep};
}

/**
 * What the reserve actually holds back of a balance — never more than the balance itself.
 *
 * {resolveFeeReserve} reports the SIZE the owner asked for, which is the right figure for the
 * arithmetic: a balance below it leaves nothing to spend either way, and `max(0, balance - size)`
 * says so. It is the wrong figure to PRINT. A vault holding 4 USDC against a 10 USDC float had a
 * row reading "10 USDC reserved", which is a claim about 6 USDC that does not exist, under an
 * Available of nothing — so the two numbers on screen did not add up to the balance above them.
 */
export const reserveHeld = (keep: number, balance: number): number =>
  Math.max(0, Math.min(keep, balance));

/** The reserve last reported per vault, so an unchanged one is not posted on every render. */
const reported = new Map<string, string>();

/**
 * Report the resolved fee reserve to the server, which the auto-yield keeper reads to leave it
 * behind when it sweeps (it deposits balance − reserve of that coin).
 *
 * The figure is what the forms on this device hold back — the same {resolveFeeReserve} answer, in
 * the coin's own units — so a sweep and a Max agree about what the float is. Nothing is sent until
 * balances have loaded, or while a WETH reserve is still waiting for its price: either would
 * resolve to "no reserve" and clear the one on the server for no reason.
 */
export function useSyncFeeReserve(
  network: Network,
  vault: Address | null | undefined,
  balances: VaultBalances | null,
  catalog: Asset[],
): void {
  const weth = useWethFeeCoin(network, vault);
  const held = [
    ...catalog
      .filter((a) => a.kind === 'stable')
      .map((a) => ({symbol: a.symbol, amount: Number(balanceOfSymbol(balances, a.symbol) || 0)})),
    ...(weth ? [{symbol: FEE_WETH, amount: Number(balanceOfSymbol(balances, FEE_WETH) || 0), usd: weth.usd}] : []),
  ];
  const {coin, size} = resolveFeeReserve({network, vault, heldStables: held});
  const asset = coin ? catalog.find((a) => a.symbol.toUpperCase() === coin.toUpperCase()) : undefined;
  const waiting = !balances || (coin?.toUpperCase() === FEE_WETH && !weth) || (coin && !asset);
  const amount =
    asset && size > 0 ? parseUnits(size.toFixed(Math.min(asset.decimals, 6)), asset.decimals) : BigInt(0);
  const body = JSON.stringify({vault, asset: asset?.address ?? zeroAddress, amount: amount.toString()});
  useEffect(() => {
    if (!vault || waiting) return;
    const key = `${network}:${vault.toLowerCase()}`;
    if (reported.get(key) === body) return;
    reported.set(key, body);
    fetch(apiUrl('/api/ethereum/vaults/fee-reserve', network), {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body,
    }).catch(() => reported.delete(key)); // best-effort; retried on the next render that resolves it
  }, [network, vault, waiting, body]);
}

/**
 * Which coin a spend should have the relayer BILL, given where the fee float sits.
 *
 * The float ({resolveFeeReserve}) is held back only in its own coin, so a spend of ANOTHER coin may
 * use all of that one. The relayer, though, is hinted the owner's first fee coin, checks its balance
 * before the call and charges after — so spending the hinted coin down passes the check and fails
 * the charge (`fee-leg-failed`). When the float is in another coin than the one being spent, that is
 * the coin to bill, pinned (see {relayVaultWrite}'s `pinFee`). Null when the hint can stand.
 */
export function feeCoinForSpend(network: string, floatCoin: string | null, spendSymbol: string | undefined): Address | null {
  const coin = floatCoin?.toUpperCase();
  if (!coin || spendSymbol === undefined || coin === spendSymbol.toUpperCase()) return null;
  const sym = coin === FEE_WETH ? 'WETH' : coin;
  return (knownAssets(network as Network).find((a) => a.symbol.toUpperCase() === sym)?.address as Address | undefined) ?? null;
}

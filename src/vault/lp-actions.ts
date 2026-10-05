/**
 * LP write actions on the AMM adapter, relayed gaslessly. Ported from web addLiquidity /
 * changeLpLiquidity / claimAmmFees. Each encodes the Uniswap params into the `data` blob the adapter
 * forwards to the position manager, then relays the vault call.
 *
 * Add is FULL-RANGE (ticks aligned to spacing across the whole price range) — no price-range UI; the
 * user just supplies amounts of the two tokens. Any unused input is refunded to the vault.
 */
import {encodeAbiParameters, parseUnits, zeroAddress, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import type {Network} from '@/core/chain';
import {VAULT_LP_ABI} from '@/core/abi';
import {marketMakerAdapters} from '@/core/protocols';
import {assetMeta} from '@/core/assets';
import {relayVaultWrite, relayVaultMulticall, type VaultCall} from './relay';
import {buildSetupCalls} from './trade-setup';

const MAX128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const DEADLINE_SECS = 20 * 60;
const TICK_SPACING: Record<number, number> = {500: 10, 3000: 60, 10000: 200};
const MIN_TICK = -887272;
const MAX_TICK = 887272;

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECS);
}
/**
 * The adapter liquidity is added through and removed from.
 *
 * Named for what it does rather than for the category it used to come from: since the AMM split
 * this is the market-MAKER adapter, which on an unsplit chain is still the same contract that
 * handles swaps. Sending a mint to the trade adapter on a split chain reverts.
 */
function canonicalMarketMaker(network: Network): Address {
  const maker = marketMakerAdapters(network)[0];
  if (!maker) throw new Error('No market maker adapter configured');
  return maker;
}

type PositionRef = {
  account: Signer;
  vault: Address;
  network: Network;
  tokenId: string;
  stableCoin: Address;
};

/** Fully remove a position's liquidity, returning both tokens (+ fees) to the vault. */
export async function removeLp(o: PositionRef & {liquidity: string}): Promise<Hex> {
  const data = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {name: 'tokenId', type: 'uint256'},
          {name: 'liquidity', type: 'uint128'},
          {name: 'amount0Min', type: 'uint256'},
          {name: 'amount1Min', type: 'uint256'},
          {name: 'deadline', type: 'uint256'},
        ],
      },
    ],
    [
      {
        tokenId: BigInt(o.tokenId),
        liquidity: BigInt(o.liquidity),
        amount0Min: BigInt(0),
        amount1Min: BigInt(0),
        deadline: deadline(),
      },
    ],
  );
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_LP_ABI,
    functionName: 'removeLiquidity',
    args: [canonicalMarketMaker(o.network), data],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Collect a position's accrued fees back to the vault. */
export async function claimLpFees(o: PositionRef): Promise<Hex> {
  const data = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {name: 'tokenId', type: 'uint256'},
          {name: 'recipient', type: 'address'},
          {name: 'amount0Max', type: 'uint128'},
          {name: 'amount1Max', type: 'uint128'},
        ],
      },
    ],
    [{tokenId: BigInt(o.tokenId), recipient: zeroAddress, amount0Max: MAX128, amount1Max: MAX128}],
  );
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_LP_ABI,
    functionName: 'claimAMMFees',
    args: [canonicalMarketMaker(o.network), data],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Provide full-range liquidity for a pair at a fee tier, using the given amounts of each token. */
export async function addLiquidityFullRange(o: {
  account: Signer;
  vault: Address;
  network: Network;
  tokenA: Address;
  tokenB: Address;
  amountA: string; // human units of tokenA
  amountB: string; // human units of tokenB
  fee: number;
  stableCoin: Address;
}): Promise<Hex> {
  const spacing = TICK_SPACING[o.fee] ?? 60;
  const tickLower = Math.ceil(MIN_TICK / spacing) * spacing;
  const tickUpper = Math.floor(MAX_TICK / spacing) * spacing;

  // Uniswap requires token0 < token1 by address; assign amounts to match.
  const aIsLower = o.tokenA.toLowerCase() < o.tokenB.toLowerCase();
  const token0 = (aIsLower ? o.tokenA : o.tokenB) as Address;
  const token1 = (aIsLower ? o.tokenB : o.tokenA) as Address;
  const amtA = parseUnits(o.amountA, assetMeta(o.network, o.tokenA).decimals);
  const amtB = parseUnits(o.amountB, assetMeta(o.network, o.tokenB).decimals);
  const amount0 = aIsLower ? amtA : amtB;
  const amount1 = aIsLower ? amtB : amtA;

  const mintParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {name: 'token0', type: 'address'},
          {name: 'token1', type: 'address'},
          {name: 'fee', type: 'uint24'},
          {name: 'tickLower', type: 'int24'},
          {name: 'tickUpper', type: 'int24'},
          {name: 'amount0Desired', type: 'uint256'},
          {name: 'amount1Desired', type: 'uint256'},
          {name: 'amount0Min', type: 'uint256'},
          {name: 'amount1Min', type: 'uint256'},
          {name: 'recipient', type: 'address'},
          {name: 'deadline', type: 'uint256'},
        ],
      },
    ],
    [
      {
        token0,
        token1,
        fee: o.fee,
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: BigInt(0),
        amount1Min: BigInt(0),
        recipient: o.vault,
        deadline: deadline(),
      },
    ],
  );

  // The adapter's addLiquidity decodes `(bool isMint, bytes params)` — mint (new NFT) vs increase (existing
  // position). Full-range add always mints, so wrap the params with isMint=true (matches the web).
  const data = encodeAbiParameters([{type: 'bool'}, {type: 'bytes'}], [true, mintParams]);

  const maker = canonicalMarketMaker(o.network);
  const add: VaultCall = {
    abi: VAULT_LP_ABI,
    functionName: 'addLiquidity',
    args: [maker, token0, amount0, token1, amount1, data],
  };
  /**
   * Register the maker adapter and both tokens first, the way a market swap registers its own.
   *
   * Before the AMM split this was not needed: one adapter swapped and held liquidity, so any
   * vault that had ever traded already had it listed and the mint inherited that registration.
   * The split gives the maker its own address, so on a restricted vault the FIRST add through it
   * reverts with `InvalidAMMProtocol` even though the same vault trades fine. Bundled ahead of
   * the mint in one multicall, so it is one signature and the mint sees the listing.
   *
   * Costs nothing on an unrestricted vault or an already-registered adapter: `buildSetupCalls`
   * returns an empty list and the plain write is used.
   */
  const setup = await buildSetupCalls({network: o.network, vault: o.vault, adapter: maker, tokens: [token0, token1]});
  const {hash} = setup.length
    ? await relayVaultMulticall({account: o.account, vault: o.vault, network: o.network, calls: [...setup, add], stableCoin: o.stableCoin})
    : await relayVaultWrite({
        account: o.account,
        vault: o.vault,
        network: o.network,
        abi: VAULT_LP_ABI,
        functionName: 'addLiquidity',
        args: add.args,
        stableCoin: o.stableCoin,
      });
  return hash;
}

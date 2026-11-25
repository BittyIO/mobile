import {decodeFunctionData, encodeFunctionData, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {knownAssets} from '@/core/assets';
import {VAULT_DEFI_ABI, VAULT_MULTICALL_ABI} from '@/core/abi';
import {ethUsd, quoteRelayFeeUsd, RELAY_GAS, relayGasFor} from './fee-quote';
import {fetchPositions, type Position} from './positions';
import {getStableCoinAsGasConfig} from './stableCoinAsGas';
import {isQueuedStake} from './lido';

/**
 * The relayer bills the vault in a fee coin it holds FREE: a stablecoin, or its WETH. A vault whose
 * stablecoin sits in a yield route, or whose ETH is lent out, holds the money but not loose, and the
 * relayer refused every operation it asked for (`insufficient-liquid-balance`) — the owner could not
 * even withdraw, since the withdrawal needs the fee too.
 *
 * So when the relayer says no fee coin is free enough, a withdrawal of a little of one goes in FRONT of the
 * operation, in the same transaction: the position pays the fee it could not before. The relayer
 * charges after the call runs, so the coin is free by then. A few times the fee is taken, so a fee
 * that moves before the transaction lands is still covered; the rest stays free for the next one.
 */

/** How many fees' worth to take out, and the least, in dollars. */
const FEES_TAKEN = 3;
const LEAST_USD = 1;
/** A position this big can give the fee: the quote with room for the relayer's reprice. */
const ENOUGH = 1.3;

export type FeeFunding = {data: Hex; feeCoin: Address};

function callsOf(data: Hex): readonly Hex[] {
  try {
    const d = decodeFunctionData({abi: VAULT_MULTICALL_ABI, data});
    if (d.functionName === 'multicall') return d.args[0];
  } catch {
    // Not a multicall.
  }
  return [data];
}

/**
 * `data` with a fee withdrawal in front, and the coin to bill; null when none can help (no position
 * in a fee coin, or the batch would not run). Asked only once the relayer has refused for want of a
 * free fee coin, so the balances are not read again.
 */
export async function withFeeFromPosition(o: {vault: Address; network: Network; from: Address; data: Hex}): Promise<FeeFunding | null> {
  const {vault, network} = o;
  const client = publicClientFor(network);
  const cfg = await getStableCoinAsGasConfig(vault, network);
  if (!cfg?.configured) return null;
  const listed = knownAssets(network);
  const allowed = new Set(cfg.stableCoins.map((a) => a.toLowerCase()));
  const stables = listed.filter((a) => a.kind === 'stable' && (allowed.size === 0 || allowed.has(a.address.toLowerCase())));
  const weth = cfg.weth ? cfg.weth.toLowerCase() : null;
  const coins: {address: Address; decimals: number; weth: boolean}[] = [
    ...stables.map((a) => ({address: a.address as Address, decimals: a.decimals, weth: false})),
    ...(weth ? [{address: cfg.weth as Address, decimals: 18, weth: true}] : []),
  ];
  if (!coins.length) return null;

  // What this operation would cost, as the relayer will price it, with the withdrawal in it.
  const opGas = await client
    .estimateGas({account: o.from, to: vault, data: o.data})
    .catch(() => relayGasFor({swap: 1}));
  const [feeUsd, eth, positions] = await Promise.all([
    quoteRelayFeeUsd(network, opGas + RELAY_GAS.overhead + RELAY_GAS.withdraw),
    weth ? ethUsd(network).catch(() => 0) : Promise.resolve(0),
    fetchPositions(vault, network, true).catch((): Position[] => []),
  ]);
  if (feeUsd == null || !(feeUsd > 0)) return null;
  const usdOf = (c: {decimals: number; weth: boolean}, raw: bigint) => (Number(raw) / 10 ** c.decimals) * (c.weth ? eth : 1);

  // The positions in a fee coin, stablecoins first. Not Lido's: its withdrawal is a queue.
  const byCoin = new Map(coins.map((c) => [c.address.toLowerCase(), c]));
  const want = Math.max(feeUsd * FEES_TAKEN, LEAST_USD);
  const usable = positions
    .filter((p) => byCoin.has(p.asset.toLowerCase()) && !isQueuedStake(p.protocolName))
    .map((p) => ({p, coin: byCoin.get(p.asset.toLowerCase())!}))
    .filter(({p, coin}) => usdOf(coin, p.raw) >= feeUsd * ENOUGH)
    .sort((a, b) => Number(a.coin.weth) - Number(b.coin.weth) || usdOf(b.coin, b.p.raw) - usdOf(a.coin, a.p.raw));

  const calls = callsOf(o.data);
  for (const {p, coin} of usable) {
    const price = coin.weth ? eth : 1;
    if (!(price > 0)) continue;
    // The dollars wanted in the coin's units, never more than the position holds.
    const units = BigInt(Math.ceil((want / price) * 10 ** Math.min(coin.decimals, 12))) * 10n ** BigInt(Math.max(0, coin.decimals - 12));
    const raw = units > p.raw ? p.raw : units;
    const pull = encodeFunctionData({abi: VAULT_DEFI_ABI, functionName: 'withdraw', args: [p.protocol, p.asset, raw]});
    const data = encodeFunctionData({abi: VAULT_MULTICALL_ABI, functionName: 'multicall', args: [[pull, ...calls]]});
    // The batch must run as the owner would send it; a position that will not give it up is skipped.
    const ok = await client.estimateGas({account: o.from, to: vault, data}).then(() => true, () => false);
    if (ok) return {data, feeCoin: coin.address};
  }
  return null;
}

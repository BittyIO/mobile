/**
 * Earn from a WALLET (core/account-mode): the same protocols the vault's Earn adapters drive — Aave,
 * Sky, Lido, TRON Stake — driven by the key itself, with the positions in its own name.
 *
 * Every protocol address is read from the vault's own adapter (its immutables: Aave's pool, Sky's
 * PSM and sUSDS, Lido's stETH), so a wallet deposits exactly where a vault would, on every chain the
 * adapter is deployed on, with nothing hard-coded twice.
 *
 * The calls are the adapter's, made from the key: a token is approved to the protocol and then
 * deposited; the chain's coin, which balances show together with its wrapped token, is unwrapped
 * first where the protocol takes the coin (Lido, TRON Stake), or wrapped where it takes the token
 * (Aave's WETH). No Bitty fee: the vault's yield fee lives in its adapter, which a wallet does not go
 * through.
 */
import {encodeFunctionData, formatUnits, maxUint256, parseAbi, zeroAddress, type Address, type Hex} from 'viem';
import {isTronNetwork, NATIVE, publicClientFor, type Network} from '@/core/chain';
import {knownAssets, type Asset} from '@/core/assets';
import {currentCatalog} from '@/core/asset-catalog';
import {adapterByName, protocolMeta} from '@/core/protocols';
import {ownerEthBalance} from '@/vault/direct';
import {lendRoutes, type EarnRoute} from '@/vault/earn-routes';
import {TRON_STAKE, tronUnstakeDays} from '@/vault/tron-stake';
import {NO_UNSTAKE, type LidoUnstake} from '@/vault/lido';
import type {Position} from '@/vault/positions';
import type {Signer} from '@/wallet/signer';
import {approvalIfNeeded, sendWalletCalls, type WalletCall} from './calls';

const AAVE_ADAPTER_ABI = parseAbi(['function aaveV3() view returns (address)', 'function poolDataProvider() view returns (address)']);
const AAVE_ABI = parseAbi([
  'function getPool() view returns (address)',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
]);
const AAVE_DATA_ABI = parseAbi(['function getReserveTokensAddresses(address asset) view returns (address aToken, address stableDebt, address variableDebt)']);
const SKY_ADAPTER_ABI = parseAbi(['function sUsds() view returns (address)', 'function psm() view returns (address)', 'function usds() view returns (address)']);
const DSS_PSM_ABI = parseAbi([
  'function sellGem(address usr, uint256 gemAmt) returns (uint256)',
  'function buyGem(address usr, uint256 gemAmt) returns (uint256)',
  'function tin() view returns (uint256)',
  'function tout() view returns (uint256)',
]);
const PSM3_ABI = parseAbi([
  'function swapExactIn(address assetIn, address assetOut, uint256 amountIn, uint256 minAmountOut, address receiver, uint256 referralCode) returns (uint256)',
  'function swapExactOut(address assetIn, address assetOut, uint256 amountOut, uint256 maxAmountIn, address receiver, uint256 referralCode) returns (uint256)',
  'function previewSwapExactIn(address assetIn, address assetOut, uint256 amountIn) view returns (uint256)',
  'function previewSwapExactOut(address assetIn, address assetOut, uint256 amountOut) view returns (uint256)',
]);
const SUSDS_ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const LIDO_ADAPTER_ABI = parseAbi(['function stETH() view returns (address)', 'function unstETH() view returns (address)']);
const STETH_ABI = parseAbi(['function submit(address referral) payable returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const UNSTETH_ABI = parseAbi([
  'function requestWithdrawals(uint256[] amounts, address owner) returns (uint256[])',
  'function getWithdrawalRequests(address owner) view returns (uint256[])',
  'function getWithdrawalStatus(uint256[] requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[])',
  'function claimWithdrawal(uint256 requestId)',
]);
const WRAPPED_ABI = parseAbi(['function deposit() payable', 'function withdraw(uint256 wad)']);
const ERC20_BAL = parseAbi(['function balanceOf(address) view returns (uint256)']);

const WAD = BigInt(10) ** BigInt(18);
/** USDC's 6 decimals to USDS's 18. */
const GEM = BigInt(10) ** BigInt(12);
/** What a swap quoted now may come up short by when it lands: sUSDS's rate only climbs. */
const SLIP_BPS = BigInt(10);

const listed = (network: Network): Asset[] => {
  const m = new Map<string, Asset>();
  for (const a of [...knownAssets(network), ...currentCatalog(network)]) m.set(a.address.toLowerCase(), a);
  return [...m.values()];
};
const wrapped = (network: Network) => listed(network).find((a) => a.symbol === NATIVE[network].wrapped);
const isWrappedNative = (network: Network, asset: Address) => wrapped(network)?.address.toLowerCase() === asset.toLowerCase();

async function aavePool(network: Network, adapter: Address): Promise<Address> {
  const client = publicClientFor(network);
  const provider = (await client.readContract({address: adapter, abi: AAVE_ADAPTER_ABI, functionName: 'aaveV3'})) as Address;
  return (await client.readContract({address: provider, abi: AAVE_ABI, functionName: 'getPool'})) as Address;
}

/** Sky's PSM and sUSDS, and USDS where the chain's PSM is Maker's (mainnet) rather than PSM3 (Base). */
async function skyParts(network: Network, adapter: Address): Promise<{psm: Address; sUsds: Address; usds: Address | null}> {
  const client = publicClientFor(network);
  const [psm, sUsds, usds] = await Promise.all([
    client.readContract({address: adapter, abi: SKY_ADAPTER_ABI, functionName: 'psm'}) as Promise<Address>,
    client.readContract({address: adapter, abi: SKY_ADAPTER_ABI, functionName: 'sUsds'}) as Promise<Address>,
    (client.readContract({address: adapter, abi: SKY_ADAPTER_ABI, functionName: 'usds'}) as Promise<Address>).catch(() => null),
  ]);
  return {psm, sUsds, usds};
}

async function lidoParts(network: Network, adapter: Address): Promise<{stETH: Address; unstETH: Address}> {
  const client = publicClientFor(network);
  const [stETH, unstETH] = await Promise.all([
    client.readContract({address: adapter, abi: LIDO_ADAPTER_ABI, functionName: 'stETH'}) as Promise<Address>,
    client.readContract({address: adapter, abi: LIDO_ADAPTER_ABI, functionName: 'unstETH'}) as Promise<Address>,
  ]);
  return {stETH, unstETH};
}

/** The chain's coin the wallet must have unwrapped for a payment of `need`: an unwrap of the shortfall, or nothing. */
async function unwrapShortfall(network: Network, wallet: Address, need: bigint): Promise<WalletCall[]> {
  const have = await ownerEthBalance(network, wallet);
  const w = wrapped(network);
  if (need <= have || !w) return [];
  return [{to: w.address, data: encodeFunctionData({abi: WRAPPED_ABI, functionName: 'withdraw', args: [need - have]})}];
}

/** The wrapped token the wallet must have for a payment of `need` in it: a wrap of the shortfall from the coin. */
async function wrapShortfall(network: Network, wallet: Address, token: Address, need: bigint): Promise<WalletCall[]> {
  const have = (await publicClientFor(network).readContract({address: token, abi: ERC20_BAL, functionName: 'balanceOf', args: [wallet]})) as bigint;
  if (need <= have) return [];
  return [{to: token, value: need - have, data: encodeFunctionData({abi: WRAPPED_ABI, functionName: 'deposit'})}];
}

export type WalletEarnStep = WalletCall | {tron: 'freeze' | 'unfreeze' | 'withdrawUnfrozen'; amountSun?: bigint};

/**
 * Every transaction a wallet deposit or withdrawal of `raw` (the route's asset units) makes, in order.
 * `all` withdraws the whole position, so nothing is left behind by rounding or accrued interest.
 */
export async function walletEarnSteps(o: {network: Network; route: EarnRoute; wallet: Address; mode: 'deposit' | 'withdraw'; raw: bigint; all?: boolean}): Promise<WalletEarnStep[]> {
  const {network, route, wallet, mode, raw} = o;
  const asset = route.asset.address;
  const client = publicClientFor(network);

  if (route.name === TRON_STAKE) {
    if (mode === 'deposit') return [...(await unwrapShortfall(network, wallet, raw)), {tron: 'freeze', amountSun: raw}];
    return [{tron: 'unfreeze', amountSun: raw}];
  }

  if (route.name === 'Aave V3') {
    const pool = await aavePool(network, route.protocol);
    if (mode === 'deposit') {
      const wrap = isWrappedNative(network, asset) ? await wrapShortfall(network, wallet, asset, raw) : [];
      return [
        ...wrap,
        ...(await approvalIfNeeded(network, wallet, asset, pool, raw)),
        {to: pool, data: encodeFunctionData({abi: AAVE_ABI, functionName: 'supply', args: [asset, raw, wallet, 0]})},
      ];
    }
    return [{to: pool, data: encodeFunctionData({abi: AAVE_ABI, functionName: 'withdraw', args: [asset, o.all ? maxUint256 : raw, wallet]})}];
  }

  if (route.name === 'Sky') {
    const {psm, sUsds, usds} = await skyParts(network, route.protocol);
    if (usds) {
      // Maker's PSM: USDC ⇄ USDS at par less its fee, then USDS ⇄ sUSDS.
      if (mode === 'deposit') {
        const tin = (await client.readContract({address: psm, abi: DSS_PSM_ABI, functionName: 'tin'})) as bigint;
        const usdsOut = raw * GEM - (raw * GEM * tin) / WAD;
        return [
          ...(await approvalIfNeeded(network, wallet, asset, psm, raw)),
          {to: psm, data: encodeFunctionData({abi: DSS_PSM_ABI, functionName: 'sellGem', args: [wallet, raw]})},
          ...(await approvalIfNeeded(network, wallet, usds, sUsds, usdsOut)),
          {to: sUsds, data: encodeFunctionData({abi: SUSDS_ABI, functionName: 'deposit', args: [usdsOut, wallet]})},
        ];
      }
      const tout = (await client.readContract({address: psm, abi: DSS_PSM_ABI, functionName: 'tout'})) as bigint;
      let usdsNeeded: bigint;
      let out: bigint;
      let first: WalletCall;
      if (o.all) {
        const shares = (await client.readContract({address: sUsds, abi: SUSDS_ABI, functionName: 'balanceOf', args: [wallet]})) as bigint;
        usdsNeeded = (await client.readContract({address: sUsds, abi: SUSDS_ABI, functionName: 'convertToAssets', args: [shares]})) as bigint;
        out = (usdsNeeded * WAD) / (GEM * (WAD + tout));
        first = {to: sUsds, data: encodeFunctionData({abi: SUSDS_ABI, functionName: 'redeem', args: [shares, wallet, wallet]})};
      } else {
        out = raw;
        usdsNeeded = raw * GEM + (raw * GEM * tout) / WAD;
        first = {to: sUsds, data: encodeFunctionData({abi: SUSDS_ABI, functionName: 'withdraw', args: [usdsNeeded, wallet, wallet]})};
      }
      return [
        first,
        ...(await approvalIfNeeded(network, wallet, usds, psm, usdsNeeded)),
        {to: psm, data: encodeFunctionData({abi: DSS_PSM_ABI, functionName: 'buyGem', args: [wallet, out]})},
      ];
    }
    // PSM3 (Base): one swap each way, USDC ⇄ sUSDS.
    if (mode === 'deposit') {
      const quoted = (await client.readContract({address: psm, abi: PSM3_ABI, functionName: 'previewSwapExactIn', args: [asset, sUsds, raw]})) as bigint;
      const minOut = quoted - (quoted * SLIP_BPS) / BigInt(10_000);
      return [
        ...(await approvalIfNeeded(network, wallet, asset, psm, raw)),
        {to: psm, data: encodeFunctionData({abi: PSM3_ABI, functionName: 'swapExactIn', args: [asset, sUsds, raw, minOut, wallet, BigInt(0)]})},
      ];
    }
    if (o.all) {
      const shares = (await client.readContract({address: sUsds, abi: SUSDS_ABI, functionName: 'balanceOf', args: [wallet]})) as bigint;
      const quoted = (await client.readContract({address: psm, abi: PSM3_ABI, functionName: 'previewSwapExactIn', args: [sUsds, asset, shares]})) as bigint;
      return [
        ...(await approvalIfNeeded(network, wallet, sUsds, psm, shares)),
        {to: psm, data: encodeFunctionData({abi: PSM3_ABI, functionName: 'swapExactIn', args: [sUsds, asset, shares, quoted - (quoted * SLIP_BPS) / BigInt(10_000), wallet, BigInt(0)]})},
      ];
    }
    const sharesIn = (await client.readContract({address: psm, abi: PSM3_ABI, functionName: 'previewSwapExactOut', args: [sUsds, asset, raw]})) as bigint;
    const maxIn = sharesIn + (sharesIn * SLIP_BPS) / BigInt(10_000);
    return [
      ...(await approvalIfNeeded(network, wallet, sUsds, psm, maxIn)),
      {to: psm, data: encodeFunctionData({abi: PSM3_ABI, functionName: 'swapExactOut', args: [sUsds, asset, raw, maxIn, wallet, BigInt(0)]})},
    ];
  }

  if (route.name === 'Lido') {
    const {stETH, unstETH} = await lidoParts(network, route.protocol);
    if (mode === 'deposit') {
      return [
        ...(await unwrapShortfall(network, wallet, raw)),
        {to: stETH, value: raw, data: encodeFunctionData({abi: STETH_ABI, functionName: 'submit', args: [zeroAddress]})},
      ];
    }
    // Lido's queue takes up to 1,000 stETH a request.
    const cap = BigInt(1000) * WAD;
    const amounts: bigint[] = [];
    for (let left = raw; left > BigInt(0); left -= left > cap ? cap : left) amounts.push(left > cap ? cap : left);
    return [
      ...(await approvalIfNeeded(network, wallet, stETH, unstETH, raw)),
      {to: unstETH, data: encodeFunctionData({abi: UNSTETH_ABI, functionName: 'requestWithdrawals', args: [amounts, wallet]})},
    ];
  }

  throw new Error(`${route.name} is not available from a wallet`);
}

/** Send a Tron Stake 2.0 system transaction (freeze, unfreeze, withdraw unlocked) from the wallet key. */
async function sendTronStake(account: Signer, network: Network, step: {tron: 'freeze' | 'unfreeze' | 'withdrawUnfrozen'; amountSun?: bigint}): Promise<{hash: Hex}> {
  if (!account.sign) throw new Error('This key cannot sign a Tron transaction');
  const {evmToTron} = require('@/tron/address') as typeof import('@/tron/address');
  const {broadcast, refBlock} = require('@/tron/client') as typeof import('@/tron/client');
  const {encodeRaw, encodeSigned, txIdOf} = require('@/tron/tx') as typeof import('@/tron/tx');
  const net = network as import('@/tron/config').TronChain;
  const from = evmToTron(account.address);
  const call =
    step.tron === 'withdrawUnfrozen'
      ? ({kind: 'withdrawUnfrozen', from} as const)
      : ({kind: step.tron, from, amountSun: step.amountSun ?? BigInt(0)} as const);
  const raw = encodeRaw(call, await refBlock(net));
  const txID = txIdOf(raw);
  const signature = await account.sign({hash: `0x${txID}`});
  const id = await broadcast(net, encodeSigned(raw, signature.replace(/^0x/, '')), txID);
  return {hash: `0x${id}`};
}

/** Run the steps from the wallet, in order. Resolves with the last one's hash. */
export async function runWalletEarn(account: Signer, network: Network, steps: WalletEarnStep[]): Promise<{hash: Hex}> {
  const calls: WalletCall[] = [];
  let last: {hash: Hex} | null = null;
  const flush = async () => {
    if (!calls.length) return;
    last = await sendWalletCalls({account, network, calls: calls.splice(0)});
    // The next step (a Tron freeze) needs this one landed.
    await publicClientFor(network).waitForTransactionReceipt({hash: last.hash, timeout: 180_000});
  };
  for (const s of steps) {
    if ('tron' in s) {
      await flush();
      last = await sendTronStake(account, network, s);
    } else calls.push(s);
  }
  if (calls.length) last = await sendWalletCalls({account, network, calls});
  if (!last) throw new Error('Nothing to send');
  return last;
}

/** Deposit or withdraw from the wallet. */
export async function walletEarn(o: {account: Signer; network: Network; route: EarnRoute; wallet: Address; mode: 'deposit' | 'withdraw'; raw: bigint; all?: boolean}): Promise<{hash: Hex}> {
  const steps = await walletEarnSteps(o);
  return runWalletEarn(o.account, o.network, steps);
}

/** Claim what the staking queue has unlocked: Lido's finalized requests, or Tron's expired unstakes. */
export async function walletClaim(o: {account: Signer; network: Network; protocol: Address; ids: bigint[]}): Promise<{hash: Hex}> {
  if (isTronNetwork(o.network)) return sendTronStake(o.account, o.network, {tron: 'withdrawUnfrozen'});
  const {unstETH} = await lidoParts(o.network, o.protocol);
  const calls: WalletCall[] = o.ids.map((id) => ({to: unstETH, data: encodeFunctionData({abi: UNSTETH_ABI, functionName: 'claimWithdrawal', args: [id]})}));
  return sendWalletCalls({account: o.account, network: o.network, calls});
}

/** The wallet's staking queue, in the vault queue's shape (vault/lido `LidoUnstake`). */
export async function walletUnstake(wallet: Address, protocol: Address, network: Network): Promise<LidoUnstake> {
  if (isTronNetwork(network)) {
    const {accountStake} = require('@/tron/client') as typeof import('@/tron/client');
    const {evmToTron} = require('@/tron/address') as typeof import('@/tron/address');
    const st = await accountStake(network as import('@/tron/config').TronChain, evmToTron(wallet));
    const now = Date.now();
    const out: LidoUnstake = {unstaking: BigInt(0), claimable: BigInt(0), claimableIds: [], pendingIds: [], eta: null};
    let first = Infinity;
    let last = 0;
    st.unfreezing.forEach((u, i) => {
      if (u.unlockMs <= now) {
        out.claimable += u.amountSun;
        out.claimableIds.push(BigInt(i));
      } else {
        out.unstaking += u.amountSun;
        out.pendingIds.push(BigInt(i));
        first = Math.min(first, u.unlockMs / 1000);
        last = Math.max(last, u.unlockMs / 1000);
      }
    });
    if (out.pendingIds.length) out.eta = {start: first - tronUnstakeDays(network) * 86_400, end: last};
    return out;
  }
  const {unstETH} = await lidoParts(network, protocol);
  const client = publicClientFor(network);
  const ids = (await client.readContract({address: unstETH, abi: UNSTETH_ABI, functionName: 'getWithdrawalRequests', args: [wallet]})) as readonly bigint[];
  if (!ids.length) return NO_UNSTAKE;
  const statuses = (await client.readContract({address: unstETH, abi: UNSTETH_ABI, functionName: 'getWithdrawalStatus', args: [[...ids]]})) as readonly {
    amountOfStETH: bigint;
    isFinalized: boolean;
    isClaimed: boolean;
  }[];
  const out: LidoUnstake = {unstaking: BigInt(0), claimable: BigInt(0), claimableIds: [], pendingIds: []};
  statuses.forEach((s, i) => {
    if (s.isClaimed) return;
    if (s.isFinalized) {
      out.claimable += s.amountOfStETH;
      out.claimableIds.push(ids[i]);
    } else {
      out.unstaking += s.amountOfStETH;
      out.pendingIds.push(ids[i]);
    }
  });
  return out;
}

const position = (network: Network, protocol: Address, asset: Asset, kind: Position['kind'], raw: bigint): Position => ({
  protocol,
  protocolName: protocolMeta(network, protocol).name,
  category: protocolMeta(network, protocol).category,
  asset: asset.address,
  symbol: asset.symbol,
  decimals: asset.decimals,
  kind,
  raw,
  formatted: formatUnits(raw, asset.decimals),
});

/**
 * The wallet's positions, read from the chain: what it supplies on Aave (its aTokens), holds in Sky
 * (sUSDS, valued in USDC), stakes with Lido (stETH, as WETH) or has frozen on Tron. The Bitty server
 * indexes vaults, not keys, so nothing here is served.
 */
export async function readWalletPositions(wallet: Address, network: Network): Promise<Position[]> {
  const client = publicClientFor(network);
  const assets = listed(network);
  const out: Position[] = [];

  if (isTronNetwork(network)) {
    const protocol = adapterByName(network, TRON_STAKE);
    const w = wrapped(network);
    if (!protocol || !w) return [];
    const {accountStake} = require('@/tron/client') as typeof import('@/tron/client');
    const {evmToTron} = require('@/tron/address') as typeof import('@/tron/address');
    const st = await accountStake(network as import('@/tron/config').TronChain, evmToTron(wallet));
    return st.energySun > BigInt(0) ? [position(network, protocol, w, 'staked', st.energySun)] : [];
  }

  const tasks: Promise<void>[] = [];
  const aave = adapterByName(network, 'Aave V3');
  if (aave) {
    tasks.push(
      (async () => {
        const data = (await client.readContract({address: aave, abi: AAVE_ADAPTER_ABI, functionName: 'poolDataProvider'})) as Address;
        const reserves = lendRoutes(network, assets).map((r) => r.asset);
        const tokens = await client.multicall({
          contracts: reserves.map((a) => ({address: data, abi: AAVE_DATA_ABI, functionName: 'getReserveTokensAddresses', args: [a.address]} as const)),
          allowFailure: true,
        });
        const held = await client.multicall({
          contracts: tokens.map((tk) => ({address: (tk.result?.[0] ?? zeroAddress) as Address, abi: ERC20_BAL, functionName: 'balanceOf', args: [wallet]} as const)),
          allowFailure: true,
        });
        held.forEach((h, i) => {
          const raw = (h.result as bigint | undefined) ?? BigInt(0);
          if (raw > BigInt(0) && tokens[i].result?.[0] && tokens[i].result?.[0] !== zeroAddress) out.push(position(network, aave, reserves[i], 'supplied', raw));
        });
      })().catch(() => {}),
    );
  }
  const sky = adapterByName(network, 'Sky');
  const usdc = assets.find((a) => a.symbol === 'USDC');
  if (sky && usdc) {
    tasks.push(
      (async () => {
        const {psm, sUsds, usds} = await skyParts(network, sky);
        const shares = (await client.readContract({address: sUsds, abi: SUSDS_ABI, functionName: 'balanceOf', args: [wallet]})) as bigint;
        if (shares === BigInt(0)) return;
        const raw = usds
          ? ((await client.readContract({address: sUsds, abi: SUSDS_ABI, functionName: 'convertToAssets', args: [shares]})) as bigint) / GEM
          : ((await client.readContract({address: psm, abi: PSM3_ABI, functionName: 'previewSwapExactIn', args: [sUsds, usdc.address, shares]})) as bigint);
        if (raw > BigInt(0)) out.push(position(network, sky, usdc, 'staked', raw));
      })().catch(() => {}),
    );
  }
  const lido = adapterByName(network, 'Lido');
  const w = wrapped(network);
  if (lido && w) {
    tasks.push(
      (async () => {
        const {stETH} = await lidoParts(network, lido);
        const raw = (await client.readContract({address: stETH, abi: STETH_ABI, functionName: 'balanceOf', args: [wallet]})) as bigint;
        if (raw > BigInt(0)) out.push(position(network, lido, w, 'staked', raw));
      })().catch(() => {}),
    );
  }
  await Promise.all(tasks);
  return out;
}

/**
 * What a wallet Earn action costs the chain's coin, worst case, in whole coins: an approval or a
 * wrap and the deposit (Sky on mainnet is four steps) on EVM; on Tron, a freeze's bandwidth and an
 * unwrap's energy. What Max keeps back of the coin, and the fee line under Confirm.
 */
export async function estimateWalletGas(network: Network): Promise<number> {
  if (isTronNetwork(network)) return 8;
  const fees = await publicClientFor(network).estimateFeesPerGas();
  return Number(formatUnits(BigInt(450_000) * (fees.maxFeePerGas ?? BigInt(0)), 18));
}

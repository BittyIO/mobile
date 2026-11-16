import {encodeAbiParameters, keccak256, parseAbi, toBytes, zeroAddress, type Address, type Hex} from 'viem';
import {CHAIN_ID, isTestnet, isTronNetwork, NATIVE, publicClientFor, type Network} from '@/core/chain';
import {NETWORKS} from '@/core/network-store';
import {vaultGuard} from '@/core/vault-contracts';
import type {Asset} from '@/core/assets';
import {VAULT_DEFI_ABI} from '@/core/abi';
import {relayVaultMulticall, relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

/**
 * The vault's bridge (vault 1.1.0, contracts vault `BridgeLogic` + protocol-store
 * `AcrossBridgeProtocol`): move an asset from this vault to the owner's own vault on another chain.
 *
 * What the chain decides, and the app only reads:
 *  - the adapter: the guard's one live protocol of the bridge category (5);
 *  - which assets may cross: the guard's bridgeable bit (8) on the asset — for the chain's own coin,
 *    on the wrapped gas token the vault holds it as;
 *  - where they may go and what arrives: a route the guard holds per (input token, destination
 *    chain), naming the output token and the most the crossing may cost;
 *  - who receives: the adapter pays the CURRENT owner's vault on the destination chain, whatever
 *    the app asks for.
 *
 * The app fetches Across's quote for the crossing, checks it against the route's cost cap before
 * anything is signed, and hands it to the vault as the adapter's request. The chain's coin is
 * bridged as the native coin (`asset` = 0): the vault unwraps its WETH, and the route is keyed by the
 * Across SpokePool's own wrapped token, which is not always the vault's (on Sepolia it is not).
 */

export const BRIDGE_SINCE = '1.1.0';

const PROTOCOL_BRIDGE = 5;
const ASSET_BRIDGEABLE = 8;
/** The adapter's ceiling on what any route may let the bridge keep (`MAX_COST_BPS`). */
const MAX_COST_BPS = 300;
/** The protocol behind the adapter this app drives (Across), as the Bridge tab names it. */
export const BRIDGE_PROTOCOL_NAME = 'Across';
/**
 * Bitty's fee on a bridge: 0.2%, as on a trade (Terms section 7). Taken out of the amount by the
 * adapter before the deposit, so what arrives is quoted on the rest; the adapter refuses more than
 * its `MAX_FEE_BPS` (also 0.2%), and rounding down keeps this at or under it.
 */
export const BRIDGE_FEE_BPS = 20;

const GUARD_ABI = parseAbi([
  'function getProtocols() view returns (address[])',
  'function protocolCategory(address protocol) view returns (uint8)',
  'function isProtocolDeprecated(address protocol) view returns (bool)',
  'function assetCategory(address asset) view returns (uint8)',
  'function getUint(bytes32 key) view returns (uint256)',
]);
const ADAPTER_ABI = parseAbi([
  'function spokePool() view returns (address)',
  'function vaultOn(uint256 destinationChainId, address owner) view returns (address)',
]);
const OWNER_ABI = parseAbi(['function owner() view returns (address)']);

/** The vault's own bridge calls (1.1.0). */
export const VAULT_BRIDGE_ABI = parseAbi([
  'function bridgeSettings() view returns (bool enabled, uint64 enableAt)',
  'function setBridgeEnabled(bool enabled)',
  'function bridge(address bridgeProtocol, address asset, uint256 amount, uint256 fee, bytes data)',
]);

/** The adapter's request, as `AcrossBridgeProtocol.AcrossQuote`. */
const ACROSS_QUOTE = [
  {
    type: 'tuple',
    components: [
      {name: 'destinationChainId', type: 'uint256'},
      {name: 'outputToken', type: 'address'},
      {name: 'outputAmount', type: 'uint256'},
      {name: 'exclusiveRelayer', type: 'address'},
      {name: 'quoteTimestamp', type: 'uint32'},
      {name: 'fillDeadline', type: 'uint32'},
      {name: 'exclusivityParameter', type: 'uint32'},
    ],
  },
] as const;

const SPOKE_ABI = parseAbi(['function wrappedNativeToken() view returns (address)']);
const ROUTE_KEY = keccak256(toBytes('bitty.bridge.across.route'));

/** The guard key of the route from `inputToken` here to `destinationChainId` (adapter `routeKey`). */
export const routeKey = (inputToken: Address, destinationChainId: number): Hex =>
  keccak256(
    encodeAbiParameters([{type: 'bytes32'}, {type: 'address'}, {type: 'uint256'}], [ROUTE_KEY, inputToken, BigInt(destinationChainId)]),
  );

/** One way across: this asset, from here, to that network. */
export type BridgeRoute = {
  to: Network;
  asset: Asset;
  /** The chain's own coin: sent as native, unwrapped by the vault. */
  native: boolean;
  /** What Across is quoted in on this side: the asset, or the SpokePool's wrapped native token. */
  inputToken: Address;
  outputToken: Address;
  outputDecimals: number;
  /** The most the crossing may cost, in basis points of what is deposited. */
  maxCostBps: number;
};

export type BridgeInfo = {adapter: Address; spokePool: Address; routes: BridgeRoute[]};

const EVM_DESTINATIONS = (from: Network): Network[] =>
  NETWORKS.filter((n) => n !== from && !isTronNetwork(n) && isTestnet(n) === isTestnet(from));

/**
 * Keyed by network AND the assets asked about. Keyed by network alone, a read made the moment after
 * a network switch, while the asset list still held the network just left, asked the guard about
 * tokens that are not on this chain, found no routes, and kept that empty answer for the launch.
 */
const infos = new Map<string, Promise<BridgeInfo | null>>();
const infoKey = (network: Network, assets: Asset[]) =>
  `${network}|${assets.map((a) => a.address.toLowerCase()).sort().join(',')}`;

/**
 * The bridge on `network`: its adapter and every route the guard holds from here, for the assets
 * in `assets`. Null where the guard lists no live bridge adapter. Read once per launch per network;
 * a failed read is not kept.
 */
/** Forgets what was read of `network`'s bridge, so the next {loadBridge} asks the guard again (a pull to refresh). */
export function forgetBridge(network: Network): void {
  for (const k of [...infos.keys()]) if (k.startsWith(`${network}|`)) infos.delete(k);
}

export function loadBridge(network: Network, assets: Asset[]): Promise<BridgeInfo | null> {
  const key = infoKey(network, assets);
  const hit = infos.get(key);
  if (hit) return hit;
  // A failed read is not cached and not a "no bridge here": it rejects, and the next call asks again.
  const p = readBridge(network, assets).catch((e) => {
    infos.delete(key);
    throw e;
  });
  infos.set(key, p);
  return p;
}

async function readBridge(network: Network, assets: Asset[]): Promise<BridgeInfo | null> {
  if (isTronNetwork(network)) return null;
  const client = publicClientFor(network);
  const guard = vaultGuard(network);
  const protocols = (await client.readContract({address: guard, abi: GUARD_ABI, functionName: 'getProtocols'})) as readonly Address[];
  const facts = await client.multicall({
    contracts: protocols.flatMap((p) => [
      {address: guard, abi: GUARD_ABI, functionName: 'protocolCategory', args: [p]},
      {address: guard, abi: GUARD_ABI, functionName: 'isProtocolDeprecated', args: [p]},
    ]),
    allowFailure: true,
  });
  const fact = (i: number) => facts[i]?.result as unknown;
  const adapter = protocols.find((_, i) => Number(fact(2 * i)) === PROTOCOL_BRIDGE && fact(2 * i + 1) === false);
  if (!adapter) return null;

  const spokePool = (await client.readContract({address: adapter, abi: ADAPTER_ABI, functionName: 'spokePool'})) as Address;

  /**
   * The vault's WETH goes as the chain's coin (`native`): the vault unwraps it and sends ETH, and
   * Across delivers ETH, which the vault on the other side wraps again on arrival. It cannot go as
   * the token itself: on Sepolia the vault's WETH is not the one Across carries. Shown and spent as
   * the WETH balance, as on every other screen.
   */
  const spokeWrapped = (await client.readContract({address: spokePool, abi: SPOKE_ABI, functionName: 'wrappedNativeToken'})) as Address;
  const gasWrapped = NATIVE[network].wrapped.toUpperCase();
  const candidates = assets.map((asset) => {
    const native = asset.symbol.toUpperCase() === gasWrapped;
    return {asset, native, inputToken: native ? spokeWrapped : asset.address};
  });
  const destinations = EVM_DESTINATIONS(network);
  const pairs = candidates.flatMap((c) => destinations.map((to) => ({...c, to})));
  const [categories, routes] = await Promise.all([
    client.multicall({
      contracts: candidates.map((c) => ({address: guard, abi: GUARD_ABI, functionName: 'assetCategory', args: [c.asset.address] as const})),
      allowFailure: true,
    }),
    client.multicall({
      contracts: pairs.map((p) => ({address: guard, abi: GUARD_ABI, functionName: 'getUint', args: [routeKey(p.inputToken, CHAIN_ID[p.to])]})),
      allowFailure: true,
    }),
  ]);
  // A read that failed is not a "no": thrown, so the empty answer is not cached and the next visit asks again.
  if ([...categories, ...routes].some((r) => r.status === 'failure')) throw new Error('bridge routes unreadable');
  const bridgeable = new Set(
    candidates.filter((_, i) => ((Number(categories[i].result ?? 0) & ASSET_BRIDGEABLE) !== 0)).map((c) => c.asset.address.toLowerCase()),
  );
  const out: BridgeRoute[] = [];
  pairs.forEach((p, i) => {
    const v = routes[i].result as bigint | undefined;
    if (!v || !bridgeable.has(p.asset.address.toLowerCase())) return;
    const outputToken = `0x${(v & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}` as Address;
    out.push({
      to: p.to,
      asset: p.asset,
      native: p.native,
      inputToken: p.inputToken,
      outputToken,
      outputDecimals: Number((v >> 160n) & 0xffn),
      maxCostBps: Math.min(Number((v >> 168n) & 0xffffn), MAX_COST_BPS),
    });
  });
  return {adapter, spokePool, routes: out};
}

/**
 * The vault's bridge switch. `enableAt` is when a turn-on still waiting out the timelock applies
 * (seconds), 0 if none. Null when the vault cannot answer: a release before 1.1.0, or not activated.
 */
export async function readBridgeSettings(vault: Address, network: Network): Promise<{enabled: boolean; enableAt: number} | null> {
  try {
    const [enabled, enableAt] = (await publicClientFor(network).readContract({
      address: vault,
      abi: VAULT_BRIDGE_ABI,
      functionName: 'bridgeSettings',
    })) as readonly [boolean, bigint];
    return {enabled, enableAt: Number(enableAt)};
  } catch {
    return null;
  }
}

/**
 * Where the money arrives: the vault's current owner's vault on `to`, as the adapter computes it.
 * A vault not activated yet has no owner to read; its owner is the key it is derived from (`owner`).
 */
export async function bridgeRecipient(network: Network, adapter: Address, vault: Address, to: Network, owner: Address): Promise<Address> {
  const client = publicClientFor(network);
  const current = ((await client.readContract({address: vault, abi: OWNER_ABI, functionName: 'owner'}).catch(() => null)) as Address | null) ?? owner;
  return (await client.readContract({address: adapter, abi: ADAPTER_ABI, functionName: 'vaultOn', args: [BigInt(CHAIN_ID[to]), current]})) as Address;
}

export type BridgeQuote = {
  /** What leaves the vault, Bitty's fee included. */
  amount: bigint;
  fee: bigint;
  /** What arrives, in the OUTPUT token's units. */
  outputAmount: bigint;
  /** What arrives, in the input asset's units — what the vault charges the difference against. */
  received: bigint;
  fillSeconds: number;
  data: Hex;
};

/** Thrown with a translation key under `mobile.bridge.` for a quote the vault would refuse. */
export class BridgeQuoteError extends Error {
  constructor(public key: 'too_low' | 'too_high' | 'cost_too_high' | 'quote_failed', public params: Record<string, string> = {}) {
    super(key);
  }
}

const acrossApi = (network: Network) => (isTestnet(network) ? 'https://testnet.across.to/api' : 'https://app.across.to/api');

/**
 * Across's quote for sending `amount` (input asset units, fee included) along `route` to
 * `recipient`, checked as the adapter will check it: what arrives must be at least the deposit less
 * the route's cost cap.
 */
export async function quoteBridge(network: Network, route: BridgeRoute, amount: bigint, recipient: Address): Promise<BridgeQuote> {
  const fee = (amount * BigInt(BRIDGE_FEE_BPS)) / 10_000n;
  const deposit = amount - fee;
  const q = new URLSearchParams({
    inputToken: route.inputToken,
    outputToken: route.outputToken,
    originChainId: String(CHAIN_ID[network]),
    destinationChainId: String(CHAIN_ID[route.to]),
    amount: deposit.toString(),
    recipient,
    // USDC and USDT on BNB Chain have 18 decimals, not 6: Across refuses the pair without this, and
    // the amounts are converted here (`outputDecimals`), so it is safe on every route.
    allowUnmatchedDecimals: 'true',
  });
  type Limits = {minDeposit?: string; maxDeposit?: string};
  let j: {
    outputAmount?: string;
    timestamp?: string;
    fillDeadline?: string;
    exclusiveRelayer?: string;
    exclusivityDeadline?: number | string;
    estimatedFillTimeSec?: number;
    isAmountTooLow?: boolean;
    limits?: Limits;
    message?: string;
    code?: string;
  };
  try {
    const res = await fetch(`${acrossApi(network)}/suggested-fees?${q.toString()}`);
    j = await res.json();
  } catch {
    throw new BridgeQuoteError('quote_failed');
  }
  /**
   * Over or under what the route carries, Across answers 400 with a code and no limits (on testnet
   * anything above about 8 USDC). Its limits endpoint gives the bound, so the screen can name it
   * rather than say the quote failed.
   */
  if (j.code === 'AMOUNT_TOO_HIGH' || j.code === 'AMOUNT_TOO_LOW') {
    const lq = new URLSearchParams({
      inputToken: route.inputToken,
      outputToken: route.outputToken,
      originChainId: String(CHAIN_ID[network]),
      destinationChainId: String(CHAIN_ID[route.to]),
      allowUnmatchedDecimals: 'true',
    });
    const limits = await fetch(`${acrossApi(network)}/limits?${lq.toString()}`)
      .then((r) => (r.ok ? (r.json() as Promise<Limits>) : null))
      .catch(() => null);
    if (j.code === 'AMOUNT_TOO_HIGH') {
      if (!limits?.maxDeposit) throw new BridgeQuoteError('quote_failed');
      throw new BridgeQuoteError('too_high', {max: limits.maxDeposit});
    }
    throw new BridgeQuoteError('too_low', {min: limits?.minDeposit ?? '0'});
  }
  if (j.code || !j.outputAmount) throw new BridgeQuoteError('quote_failed');
  const min = j.limits?.minDeposit ? BigInt(j.limits.minDeposit) : 0n;
  const max = j.limits?.maxDeposit ? BigInt(j.limits.maxDeposit) : null;
  if (j.isAmountTooLow || deposit < min) throw new BridgeQuoteError('too_low', {min: min.toString()});
  if (max != null && deposit > max) throw new BridgeQuoteError('too_high', {max: max.toString()});
  if (!j.outputAmount || !j.timestamp || !j.fillDeadline) throw new BridgeQuoteError('quote_failed');

  const outputAmount = BigInt(j.outputAmount);
  const inDec = route.native ? 18 : route.asset.decimals;
  const scaleUp = (x: bigint, from: number, to: number) => (to >= from ? x * 10n ** BigInt(to - from) : x / 10n ** BigInt(from - to));
  const least = scaleUp((deposit * BigInt(10_000 - route.maxCostBps)) / 10_000n, inDec, route.outputDecimals);
  if (outputAmount < least || outputAmount === 0n) throw new BridgeQuoteError('cost_too_high');

  const data = encodeAbiParameters(ACROSS_QUOTE, [
    {
      destinationChainId: BigInt(CHAIN_ID[route.to]),
      outputToken: route.outputToken,
      outputAmount,
      exclusiveRelayer: (j.exclusiveRelayer ?? zeroAddress) as Address,
      quoteTimestamp: Number(j.timestamp),
      fillDeadline: Number(j.fillDeadline),
      exclusivityParameter: Number(j.exclusivityDeadline ?? 0),
    },
  ]);
  return {
    amount,
    fee,
    outputAmount,
    received: scaleUp(outputAmount, route.outputDecimals, inDec),
    fillSeconds: j.estimatedFillTimeSec ?? 0,
    data,
  };
}

/** Send `quote` across (relayed, gasless). Resolves with the transaction hash. */
export async function bridgeFromVault(o: {
  account: Acct;
  vault: Address;
  network: Network;
  adapter: Address;
  route: BridgeRoute;
  quote: BridgeQuote;
  stableCoin: Address;
  /** See {relayVaultWrite}: the coin billed is not the one this bridge spends. */
  pinFee?: boolean;
  /** Upgrade the vault in the same transaction, though Auto upgrade is off: the user said yes. */
  upgradeVault?: boolean;
  /**
   * What yielding or lending positions pay into this bridge, as on Send: each adapter and how much
   * to withdraw from it. The withdrawals and the bridge go as ONE multicall, so the money never sits
   * idle half-way: a bridge that would revert takes the withdrawals back with it.
   */
  withdrawals?: {protocol: Address; raw: bigint}[];
}): Promise<Hex> {
  const asset = o.route.native ? zeroAddress : o.route.asset.address;
  if (o.withdrawals?.length) {
    const r = await relayVaultMulticall({
      account: o.account,
      vault: o.vault,
      network: o.network,
      calls: [
        // A position holds the asset itself (WETH for the native route), which the bridge then sends.
        ...o.withdrawals.map((w) => ({abi: VAULT_DEFI_ABI, functionName: 'withdraw', args: [w.protocol, o.route.asset.address, w.raw]})),
        {abi: VAULT_BRIDGE_ABI, functionName: 'bridge', args: [o.adapter, asset, o.quote.amount, o.quote.fee, o.quote.data]},
      ],
      stableCoin: o.stableCoin,
      pinFee: o.pinFee,
      upgradeVault: o.upgradeVault,
    });
    return r.hash;
  }
  const r = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_BRIDGE_ABI,
    functionName: 'bridge',
    args: [o.adapter, asset, o.quote.amount, o.quote.fee, o.quote.data],
    stableCoin: o.stableCoin,
    pinFee: o.pinFee,
    upgradeVault: o.upgradeVault,
  });
  return r.hash;
}

/** Turn the bridge on (waits out the timelock) or off (at once). */
export async function setBridgeEnabled(o: {account: Acct; vault: Address; network: Network; enabled: boolean; stableCoin: Address}): Promise<Hex> {
  const r = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_BRIDGE_ABI,
    functionName: 'setBridgeEnabled',
    args: [o.enabled],
    stableCoin: o.stableCoin,
  });
  return r.hash;
}

export type DepositStatus = 'pending' | 'filled' | 'expired' | 'refunded' | 'unknown';

/** Across's view of a deposit made in `hash` on `network`. */
export async function depositStatus(network: Network, hash: Hex): Promise<DepositStatus> {
  try {
    const res = await fetch(`${acrossApi(network)}/deposit/status?originChainId=${CHAIN_ID[network]}&depositTxHash=${hash}`);
    if (!res.ok) return 'pending';
    const j = (await res.json()) as {status?: string};
    return (['pending', 'filled', 'expired', 'refunded'] as const).find((s) => s === j.status) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Across's record of `vault`'s bridges on `network`, by transaction hash (lowercase):
 *  - `arrivals`: the fills that delivered into the vault, and the network each came from. On chain
 *    a fill is only the relayer handing the vault tokens, which history would call a payment.
 *  - `departures`: the vault's own deposits, and where each went. The vault's call names these as
 *    well, but only where the history server decodes `bridge`; this does not wait on that.
 * Empty when Across cannot be read: history without the names is still history.
 */
/** One Across delivery into the vault, as Across reports it: enough to draw it before Bitty's server has indexed it. */
export type BridgeArrival = {txHash: string; from: Network; token: string; amount: string; blockNum: number; timestamp: string | null};

export async function bridgeHistory(
  vault: string,
  network: Network,
): Promise<{arrivals: Map<string, Network>; departures: Map<string, Network>; arrivalRows: BridgeArrival[]}> {
  const arrivals = new Map<string, Network>();
  const departures = new Map<string, Network>();
  const arrivalRows: BridgeArrival[] = [];
  if (isTronNetwork(network)) return {arrivals, departures, arrivalRows};
  try {
    const res = await fetch(`${acrossApi(network)}/deposits?address=${vault}&limit=100`);
    if (!res.ok) return {arrivals, departures, arrivalRows};
    const rows = (await res.json()) as {
      depositor?: string;
      recipient?: string;
      destinationChainId?: number;
      originChainId?: number;
      depositTxHash?: string | null;
      fillTx?: string | null;
      outputToken?: string;
      outputAmount?: string;
      fillBlockNumber?: number | null;
      fillBlockTimestamp?: string | null;
    }[];
    const byChain = new Map((Object.keys(CHAIN_ID) as Network[]).map((n) => [CHAIN_ID[n], n] as const));
    const me = vault.toLowerCase();
    const here = CHAIN_ID[network];
    for (const r of rows) {
      const from = byChain.get(Number(r.originChainId));
      const to = byChain.get(Number(r.destinationChainId));
      if (r.fillTx && r.destinationChainId === here && r.recipient?.toLowerCase() === me && from) {
        arrivals.set(r.fillTx.toLowerCase(), from);
        if (r.outputToken && r.outputAmount && r.fillBlockNumber)
          arrivalRows.push({txHash: r.fillTx, from, token: r.outputToken, amount: r.outputAmount, blockNum: Number(r.fillBlockNumber), timestamp: r.fillBlockTimestamp ?? null});
      }
      if (r.depositTxHash && r.originChainId === here && r.depositor?.toLowerCase() === me && to) departures.set(r.depositTxHash.toLowerCase(), to);
    }
  } catch {
    // As above.
  }
  return {arrivals, departures, arrivalRows};
}

/** One route's identity on the Bridge screen: ETH and WETH share an asset and differ by `native`. */
export const routeId = (r: BridgeRoute) => `${r.asset.address.toLowerCase()}|${r.native ? 'native' : 'token'}`;

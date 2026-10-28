/**
 * Gasless CoW limit orders. Ported from web placeGaslessCowOrder:
 *  1. sign the GPv2 Order (EIP-712, settlement domain) with the owner key,
 *  2. wrap it into the eip1271 payload the intent clone verifies (abi.encode(order, sig, salt=0)),
 *  3. register the fee appData, then POST to the CoW orderbook (signingScheme: eip1271).
 * No on-chain tx, no gas — the order settles or expires against the vault's live balance.
 *
 * Prerequisite for a SELL to actually settle: the vault must have approved the intent adapter's
 * spender (CoW's vault relayer) for the sell token once (see {@link prepareIntent}), and the CoW
 * intent adapter must be enabled.
 */
import {encodeAbiParameters, parseAbi, parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, CHAIN_ID, publicClientFor, type Network} from '@/core/chain';
import {BALANCE_ERC20, COW_PARTNER_FEE_BPS, GPV2_SETTLEMENT, KIND_BUY, KIND_SELL, LIMIT_APP_DATA_HASHES, ORDER_712_TYPES, ORDER_TUPLE, buildLimitAppData, cowApiBase, cowFeeRecipient, cowSupported, orderSignerSig} from '@/core/cow';
import {VAULT_INTENT_ABI} from '@/core/abi';
import {intentAdapters} from '@/core/protocols';
import {assetMeta} from '@/core/assets';
import {relayVaultWrite, relayVaultMulticall, type VaultCall} from './relay';
import {buildSetupCalls} from './trade-setup';
import {vaultImplVersion} from './manage';
import {fetchUniswapXOrders, uniswapXAdapter} from './uniswapx';

const FEE_BPS = BigInt(COW_PARTNER_FEE_BPS);

export type CowOrder = {
  uid: string;
  kind: 'buy' | 'sell';
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  status: string;
  /**
   * When CoW accepted the order, ISO-8601. Present on every order the account endpoint returns.
   *
   * The only time an order object carries: there is no execution date on it, which is why a fill's
   * time has to come off the settlement transaction. It is what a history is ORDERED by — see
   * {placedAt}.
   */
  creationDate?: string;
  appData?: string;
  executedSellAmount?: string;
  executedBuyAmount?: string;
};

/**
 * Sign + submit a limit order. `sellAmount`/`buyAmount` are HUMAN units and define the limit price:
 * sell exactly sellAmount for at least buyAmount (sell), or receive exactly buyAmount for at most
 * sellAmount (buy). Returns the CoW order UID.
 */
export async function placeLimitOrder(o: {
  account: Signer;
  vault: Address;
  network: Network;
  /** The CoW adapter; the vault's clone of it decides which fee recipient the appData must name. */
  intentProtocol: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  buyAmount: string;
  kind: 'sell' | 'buy';
  validSeconds: number;
}): Promise<string> {
  const chainId = CHAIN_ID[o.network];
  const sellDec = assetMeta(o.network, o.sellToken).decimals;
  const buyDec = assetMeta(o.network, o.buyToken).decimals;
  const validTo = Math.floor(Date.now() / 1000) + o.validSeconds;
  const {hash: appData, fullAppData} = buildLimitAppData(await cowFeeRecipient(o.network, o.vault, o.intentProtocol));

  // Fee adjust for the 0.2% partner fee: a sell discounts the min received; a buy grosses up the max spent.
  let sellAmount = parseUnits(o.sellAmount, sellDec);
  let buyAmount = parseUnits(o.buyAmount, buyDec);
  if (o.kind === 'sell') buyAmount = buyAmount - (buyAmount * FEE_BPS) / BigInt(10000);
  else sellAmount = sellAmount + (sellAmount * FEE_BPS) / BigInt(10000);

  // Register the fee document first (idempotent): CoW needs it to resolve the fee whoever posts the
  // order, and for a multi-owner Safe that is whichever owner's signature completes it, later.
  const base = cowApiBase(o.network);
  await fetch(`${base}/app_data/${appData}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({fullAppData}),
  }).catch(() => {});

  const order: LimitOrderFields = {
    sellToken: o.sellToken,
    buyToken: o.buyToken,
    receiver: o.vault,
    sellAmount,
    buyAmount,
    validTo,
    appData,
    kind: o.kind,
  };

  // 1. Manager (owner) signs the order — exactly as an EOA signs its own CoW order. A Safe owner's
  // signature may first have to be completed by co-owners (vault/safe SafeSignaturePending).
  const managerSig = await o.account.signTypedData({
    domain: {name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: GPV2_SETTLEMENT},
    types: ORDER_712_TYPES,
    primaryType: 'Order',
    message: {...order, feeAmount: BigInt(0), partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20'},
  });

  return postLimitOrder({network: o.network, order, signerSig: orderSignerSig(o.account, managerSig)});
}

/** The fields of a vault limit order that vary; the rest are fixed (fill-or-kill, ERC-20, no fee). */
export type LimitOrderFields = {
  sellToken: Address;
  buyToken: Address;
  receiver: Address; // the vault
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  appData: Hex;
  kind: 'sell' | 'buy';
};

/**
 * Wrap an order's signature in the eip1271 payload the vault's intent clone verifies and post it to
 * CoW. `signerSig` is the owner's signature as the clone reads it (core/cow `orderSignerSig`).
 * Split from {placeLimitOrder} so an order whose Safe signature was collected later is posted the
 * same way. Returns the CoW order UID.
 */
export async function postLimitOrder(o: {network: Network; order: LimitOrderFields; signerSig: Hex}): Promise<string> {
  const {order} = o;
  // 2. eip1271 payload = abi.encode(GPv2Order (bytes32 kind/balance), managerSig, appDataSalt=0).
  const signature = encodeAbiParameters(
    [ORDER_TUPLE, {type: 'bytes'}, {type: 'uint256'}],
    [
      {
        ...order,
        feeAmount: BigInt(0),
        kind: order.kind === 'sell' ? KIND_SELL : KIND_BUY,
        partiallyFillable: false,
        sellTokenBalance: BALANCE_ERC20,
        buyTokenBalance: BALANCE_ERC20,
      },
      o.signerSig,
      BigInt(0),
    ],
  );

  // 3. Post the order.
  const res = await fetch(`${cowApiBase(o.network)}/orders`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      validTo: order.validTo,
      appData: order.appData,
      feeAmount: '0',
      kind: order.kind,
      partiallyFillable: false,
      signingScheme: 'eip1271',
      signature,
      from: order.receiver,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    }),
  });
  if (!res.ok) throw new Error(`CoW rejected: ${await res.text()}`);
  return (await res.json()) as string; // order UID
}

/**
 * One-time on-chain setup for a CoW order, bundled into a SINGLE relayed tx (one signature): allowlist the
 * sell/buy assets + register the intent adapter (which makes the vault clone it — the clone is what CoW
 * calls isValidSignature on) when the restricted allowlist requires it, and — when `approveToken` is set —
 * approve the intent adapter's spender to pull the sell token. Runs only the missing steps; a no-op when nothing
 * is needed. Waits for the tx to mine, because the clone + allowlist must be on-chain before the order is
 * posted (CoW validates isValidSignature against them).
 */
const SPENDER_SOURCE_ABI = parseAbi([
  'function spender() view returns (address)',
  // The same address under the name adapters released before the generic intent interface use.
  'function vaultRelayer() view returns (address)',
]);
const ALLOWANCE_ABI = parseAbi(['function allowance(address owner,address spender) view returns (uint256)']);

/**
 * Does the vault still have to approve the intent adapter's spender for this token?
 *
 * The approval sets an unlimited allowance from the VAULT to the adapter's spender (CoW's vault
 * relayer, Permit2 for UniswapX),
 * so the question is answered on chain and stays answered. It used to be tracked in a Set that
 * lived as long as the screen, which meant every app restart re-approved a token that already had
 * an unlimited allowance and charged a relay fee to do nothing.
 *
 * A failed read answers "yes": approving twice wastes a little gas, skipping a needed approval
 * makes the order unfillable.
 */
export async function needsRelayerApproval(o: {
  vault: Address;
  network: Network;
  intentProtocol: Address;
  token: Address;
}): Promise<boolean> {
  const client = publicClientFor(o.network);
  try {
    const spender = (await client
      .readContract({address: o.intentProtocol, abi: SPENDER_SOURCE_ABI, functionName: 'spender'})
      .catch(() =>
        client.readContract({address: o.intentProtocol, abi: SPENDER_SOURCE_ABI, functionName: 'vaultRelayer'}),
      )) as Address;
    const allowance = (await client.readContract({
      address: o.token,
      abi: ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [o.vault, spender],
    })) as bigint;
    return allowance === BigInt(0);
  } catch {
    return true;
  }
}

// v1.0.4 made intent protocols generic and renamed the approval for the adapter's spender.
const INTENT_SPENDER_RENAME_VERSION = 1_000_004;

async function approveIntentFunctionName(
  vault: Address,
  network: Network,
): Promise<'approveIntentSpender' | 'approveIntentRelayer'> {
  return (await vaultImplVersion(vault, network)) >= INTENT_SPENDER_RENAME_VERSION
    ? 'approveIntentSpender'
    : 'approveIntentRelayer';
}

/**
 * The on-chain calls a CoW order still needs before it can be posted, which is usually none.
 *
 * Split out of {prepareIntent} so the sheet can ask the same question the submit path answers, and
 * say truthfully whether the order costs anything. An order on a vault that has already traded
 * this pair sends no transaction and is free; charging it a fee line was simply wrong.
 */
export async function intentPrepCalls(o: {
  vault: Address;
  network: Network;
  intentProtocol: Address;
  tokens: Address[];
  approveToken?: Address;
  preCalls?: VaultCall[];
}): Promise<VaultCall[]> {
  const calls: VaultCall[] = [
    ...(o.preCalls ?? []),
    ...(await buildSetupCalls({network: o.network, vault: o.vault, adapter: o.intentProtocol, tokens: o.tokens, intent: true})),
  ];
  if (o.approveToken) {
    const functionName = await approveIntentFunctionName(o.vault, o.network);
    calls.push({abi: VAULT_INTENT_ABI, functionName, args: [o.intentProtocol, o.approveToken]});
  }
  return calls;
}

export async function prepareIntent(o: {
  account: Signer;
  vault: Address;
  network: Network;
  intentProtocol: Address;
  tokens: Address[];
  approveToken?: Address;
  stableCoin: Address;
  /** Extra calls run BEFORE setup in the same tx — e.g. a Sky withdraw to top up the sell token. */
  preCalls?: VaultCall[];
}): Promise<void> {
  const calls = await intentPrepCalls(o);
  if (calls.length === 0) return;

  const {hash} =
    calls.length > 1
      ? await relayVaultMulticall({account: o.account, vault: o.vault, network: o.network, calls, stableCoin: o.stableCoin, noRotate: true})
      : await relayVaultWrite({account: o.account, vault: o.vault, network: o.network, ...calls[0], stableCoin: o.stableCoin, noRotate: true});
  await publicClientFor(o.network).waitForTransactionReceipt({hash});
}

/**
 * Cancel one or more open orders. CoW can't soft-cancel a vault (eip1271) order, so the vault cancels
 * the UIDs on-chain via cancelIntentOrders — relayed gaslessly. On v1.0.4+ the cancel
 * is recorded in the vault's adapter clone, which refuses the order from then on; CoW never
 * learns of it, which is why {fetchRecentOrders} asks the clone. They stop filling at once.
 */
export async function cancelLimitOrders(o: {
  account: Signer;
  vault: Address;
  network: Network;
  intentProtocol: Address;
  uids: Hex[];
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_INTENT_ABI,
    functionName: 'cancelIntentOrders',
    args: [o.intentProtocol, o.uids],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Cancel a single open order. Thin wrapper over {@link cancelLimitOrders}. */
export async function cancelLimitOrder(o: {
  account: Signer;
  vault: Address;
  network: Network;
  intentProtocol: Address;
  uid: Hex;
  stableCoin: Address;
}): Promise<Hex> {
  return cancelLimitOrders({...o, uids: [o.uid]});
}

/**
 * The vault's recent CoW orders (any status), newest first — for a live list that shows fills and
 * cancellations, not just the currently-open ones. Poll this to track status.
 */
export async function fetchRecentOrders(vault: Address, network: Network): Promise<CowOrder[]> {
  const cow = async (): Promise<CowOrder[]> => {
    if (!cowSupported(network)) return [];
    const res = await apiFetch(`${cowApiBase(network)}/account/${vault}/orders?limit=30`);
    return res.ok ? ((await res.json()) as CowOrder[]) : [];
  };
  // Where the intent adapter was UniswapX (Robinhood), its limit orders share this list: retired,
  // but an order placed before still shows, and can be cancelled, until it ends.
  const ux = (): Promise<CowOrder[]> => (uniswapXAdapter(network) ? fetchUniswapXOrders(vault, network) : Promise.resolve([]));
  try {
    const [a, b] = await Promise.all([cow().catch(() => []), ux().catch(() => [])]);
    const all = b.length ? [...a, ...b].sort((x, y) => (y.creationDate ?? '').localeCompare(x.creationDate ?? '')) : a;
    // Cancels are recorded on the vault's adapter clone, never at CoW or Uniswap: asked of it.
    return await markCancelledOrders(vault, network, all).catch(() => all);
  } catch {
    return [];
  }
}

const CLONE_ABI = parseAbi([
  'function getClone(address protocol) view returns (address)',
  'function isOrderCancelled(bytes orderId) view returns (bool)',
]);

/**
 * Relabel as cancelled every order CoW still calls "open" that the vault cancelled on its adapter
 * clone. That cancel never reaches CoW's orderbook, so without this a cancelled order reads open on
 * every device but the one that cancelled it, until it expires. A clone older than the generic intent
 * interface has no isOrderCancelled; those reads fail and the order keeps CoW's status.
 *
 * The retired UniswapX adapter is asked as well: the guard no longer lists it, but its orders are
 * still on its clone.
 */
async function markCancelledOrders(vault: Address, network: Network, orders: CowOrder[]): Promise<CowOrder[]> {
  const open = orders.filter((o) => o.status === 'open');
  const ux = uniswapXAdapter(network);
  const adapters = [...intentAdapters(network), ...(ux ? [ux] : [])];
  if (open.length === 0 || adapters.length === 0) return orders;
  const client = publicClientFor(network);
  // Clones are per lineage, so every version of an adapter names the same one.
  const clones = await client.multicall({
    allowFailure: true,
    contracts: adapters.map((a) => ({address: vault, abi: CLONE_ABI, functionName: 'getClone', args: [a]}) as const),
  });
  const live = [
    ...new Set(
      clones
        .map((r) => (r.status === 'success' ? (r.result as Address) : null))
        .filter((c): c is Address => !!c && !/^0x0+$/.test(c))
        .map((c) => c.toLowerCase() as Address),
    ),
  ];
  if (live.length === 0) return orders;
  const reads = await client.multicall({
    allowFailure: true,
    contracts: live.flatMap((clone) =>
      open.map((o) => ({address: clone, abi: CLONE_ABI, functionName: 'isOrderCancelled', args: [o.uid as Hex]}) as const),
    ),
  });
  const cancelled = new Set<string>();
  reads.forEach((r, i) => {
    if (r.status === 'success' && r.result === true) cancelled.add(open[i % open.length].uid);
  });
  return orders.map((o) => (cancelled.has(o.uid) ? {...o, status: 'cancelled'} : o));
}

// The CoW settlement contract, the counterparty of every fill's transfer legs.
export {GPV2_SETTLEMENT};

export type SettlementMeta = {orderUid: string; twap: boolean};

/**
 * Order uid → the settlement transaction that filled it, lower-cased.
 *
 * One request, and the narrow half of what {fetchSettlements} works out — no order fetch, because
 * nothing here needs to know whether the order was part of a TWAP. Paired with the transfer feed's
 * timestamp for that transaction, it is how a filled order can say WHEN: CoW's order objects carry
 * a creation date and no execution date, so the fill time exists only on chain.
 */
export async function fetchFillTxs(vault: Address, network: Network): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!cowSupported(network)) return out;
  try {
    const res = await apiFetch(`${cowApiBase(network)}/trades?owner=${vault}`);
    if (!res.ok) return out;
    const trades = (await res.json()) as {orderUid: string; txHash?: string}[];
    if (!Array.isArray(trades)) return out;
    for (const tr of trades) if (tr.txHash) out.set(tr.orderUid.toLowerCase(), tr.txHash.toLowerCase());
  } catch {
    // Best effort: without it a filled order simply shows no time.
  }
  return out;
}

/**
 * The vault's fills, keyed by the settlement transaction (lower-cased hash). A limit order is signed
 * off-chain and executed by a CoW solver in its own transaction, so the fill has a hash of its own,
 * separate from the relayed approval that preceded it; this is what links a history row or a
 * finished order to that execution. Empty on a chain without CoW.
 */
export async function fetchSettlements(vault: Address, network: Network): Promise<Map<string, SettlementMeta>> {
  const out = new Map<string, SettlementMeta>();
  if (!cowSupported(network)) return out;
  try {
    const base = cowApiBase(network);
    const [tradesRes, orders] = await Promise.all([apiFetch(`${base}/trades?owner=${vault}`), fetchRecentOrders(vault, network)]);
    if (!tradesRes.ok) return out;
    const trades = (await tradesRes.json()) as {orderUid: string; txHash?: string}[];
    if (!Array.isArray(trades)) return out;
    const appDataByUid = new Map(orders.map((o) => [o.uid.toLowerCase(), (o.appData ?? '').toLowerCase()]));
    for (const tr of trades) {
      if (!tr.txHash) continue;
      const appData = appDataByUid.get(tr.orderUid.toLowerCase());
      // A TWAP part carries a salted appData; anything else that is not the standard one is treated
      // as a plain limit order.
      out.set(tr.txHash.toLowerCase(), {orderUid: tr.orderUid, twap: !!appData && !LIMIT_APP_DATA_HASHES.has(appData)});
    }
  } catch {
    // Best effort: the history still shows the fill, just as a generic trade.
  }
  return out;
}

/** Whether an order can still be cancelled (open / awaiting signature). */
export function isOrderOpen(o: CowOrder): boolean {
  return o.status === 'open' || o.status === 'presignaturePending';
}

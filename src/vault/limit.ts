/**
 * Gasless CoW limit orders. Ported from web placeGaslessCowOrder:
 *  1. sign the GPv2 Order (EIP-712, settlement domain) with the owner key,
 *  2. wrap it into the eip1271 payload the intent clone verifies (abi.encode(order, sig, salt=0)),
 *  3. register the fee appData, then POST to the CoW orderbook (signingScheme: eip1271).
 * No on-chain tx, no gas — the order settles or expires against the vault's live balance.
 *
 * Prerequisite for a SELL to actually settle: the vault must have approved the CoW vault relayer for
 * the sell token once (see {@link prepareIntent}), and the CoW intent adapter must be enabled.
 */
import {encodeAbiParameters, parseAbi, parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, CHAIN_ID, publicClientFor, type Network} from '@/core/chain';
import {BALANCE_ERC20, COW_PARTNER_FEE_BPS, GPV2_SETTLEMENT, KIND_BUY, KIND_SELL, ORDER_712_TYPES, ORDER_TUPLE, buildLimitAppData, cowApiBase, cowSupported} from '@/core/cow';
import {VAULT_INTENT_ABI} from '@/core/abi';
import {assetMeta} from '@/core/assets';
import {relayVaultWrite, relayVaultMulticall, type VaultCall} from './relay';
import {buildSetupCalls} from './trade-setup';

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
  const {hash: appData, fullAppData} = buildLimitAppData();

  // Fee adjust for the 0.2% partner fee: a sell discounts the min received; a buy grosses up the max spent.
  let sellAmount = parseUnits(o.sellAmount, sellDec);
  let buyAmount = parseUnits(o.buyAmount, buyDec);
  if (o.kind === 'sell') buyAmount = buyAmount - (buyAmount * FEE_BPS) / BigInt(10000);
  else sellAmount = sellAmount + (sellAmount * FEE_BPS) / BigInt(10000);

  // 1. Manager (owner) signs the order — exactly as an EOA signs its own CoW order.
  const managerSig = await o.account.signTypedData({
    domain: {name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: GPV2_SETTLEMENT},
    types: ORDER_712_TYPES,
    primaryType: 'Order',
    message: {
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      receiver: o.vault,
      sellAmount,
      buyAmount,
      validTo,
      appData,
      feeAmount: BigInt(0),
      kind: o.kind,
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
  });

  // 2. eip1271 payload = abi.encode(GPv2Order (bytes32 kind/balance), managerSig, appDataSalt=0).
  const signature = encodeAbiParameters(
    [ORDER_TUPLE, {type: 'bytes'}, {type: 'uint256'}],
    [
      {
        sellToken: o.sellToken,
        buyToken: o.buyToken,
        receiver: o.vault,
        sellAmount,
        buyAmount,
        validTo,
        appData,
        feeAmount: BigInt(0),
        kind: o.kind === 'sell' ? KIND_SELL : KIND_BUY,
        partiallyFillable: false,
        sellTokenBalance: BALANCE_ERC20,
        buyTokenBalance: BALANCE_ERC20,
      },
      managerSig,
      BigInt(0),
    ],
  );

  // 3. Register the fee document (idempotent), then post the order.
  const base = cowApiBase(o.network);
  await fetch(`${base}/app_data/${appData}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({fullAppData}),
  }).catch(() => {});

  const res = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      receiver: o.vault,
      sellAmount: sellAmount.toString(),
      buyAmount: buyAmount.toString(),
      validTo,
      appData,
      feeAmount: '0',
      kind: o.kind,
      partiallyFillable: false,
      signingScheme: 'eip1271',
      signature,
      from: o.vault,
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
 * approve the settlement relayer to pull the sell token. Runs only the missing steps; a no-op when nothing
 * is needed. Waits for the tx to mine, because the clone + allowlist must be on-chain before the order is
 * posted (CoW validates isValidSignature against them).
 */
const RELAYER_SOURCE_ABI = parseAbi(['function vaultRelayer() view returns (address)']);
const ALLOWANCE_ABI = parseAbi(['function allowance(address owner,address spender) view returns (uint256)']);

/**
 * Does the vault still have to approve the settlement relayer for this token?
 *
 * `approveIntentRelayer` sets an unlimited allowance from the VAULT to the adapter's vaultRelayer,
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
    const relayer = (await client.readContract({
      address: o.intentProtocol,
      abi: RELAYER_SOURCE_ABI,
      functionName: 'vaultRelayer',
    })) as Address;
    const allowance = (await client.readContract({
      address: o.token,
      abi: ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [o.vault, relayer],
    })) as bigint;
    return allowance === BigInt(0);
  } catch {
    return true;
  }
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
  if (o.approveToken) calls.push({abi: VAULT_INTENT_ABI, functionName: 'approveIntentRelayer', args: [o.intentProtocol, o.approveToken]});
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
      ? await relayVaultMulticall({account: o.account, vault: o.vault, network: o.network, calls, stableCoin: o.stableCoin})
      : await relayVaultWrite({account: o.account, vault: o.vault, network: o.network, ...calls[0], stableCoin: o.stableCoin});
  await publicClientFor(o.network).waitForTransactionReceipt({hash});
}

/**
 * Cancel one or more open orders. CoW can't soft-cancel a vault (eip1271) order, so the vault
 * invalidates the UIDs on-chain via cancelIntentOrders — relayed gaslessly. They stop filling at once.
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
  try {
    const res = await apiFetch(`${cowApiBase(network)}/account/${vault}/orders?limit=30`);
    if (!res.ok) return [];
    const all = (await res.json()) as CowOrder[];
    // CoW returns newest first already; keep it defensive.
    return all;
  } catch {
    return [];
  }
}

// The CoW settlement contract, the counterparty of every fill's transfer legs.
export {GPV2_SETTLEMENT};

export type SettlementMeta = {orderUid: string; twap: boolean};

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
    const limitAppData = buildLimitAppData().hash.toLowerCase();
    const appDataByUid = new Map(orders.map((o) => [o.uid.toLowerCase(), (o.appData ?? '').toLowerCase()]));
    for (const tr of trades) {
      if (!tr.txHash) continue;
      const appData = appDataByUid.get(tr.orderUid.toLowerCase());
      // A TWAP part carries a salted appData; anything else that is not the standard one is treated
      // as a plain limit order.
      out.set(tr.txHash.toLowerCase(), {orderUid: tr.orderUid, twap: !!appData && appData !== limitAppData});
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

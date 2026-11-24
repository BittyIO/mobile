/**
 * Trading from a WALLET (core/account-mode).
 *
 * Market: the same route the vault's trade adapter swaps along — the quoting service's Universal
 * Router route (vault/universal-route), Uniswap's on EVM chains and SunSwap's on Tron — sent by the
 * key straight to the router the adapter itself calls. The route's recipient and payer are the
 * router's MSG_SENDER, so the key pays the input through Permit2 and receives the output, exactly
 * as the adapter does for a vault.
 *
 * Bitty's fee is the adapter's: 0.2% of the input (`SWAP_FEE_BPS`) to the adapter's own fee
 * recipient. The service builds a stablecoin's route for the input less the fee, as it does for a
 * vault; for any other input the route is asked for the input less the fee, so the fee is always the
 * input's and is sent once the swap has landed — a swap that reverts costs nothing but gas.
 *
 * Limit: a CoW order signed by the key itself (EIP-712, Gnosis Protocol v2), carrying the same
 * partner-fee appData as a vault's order — 0.2% to the fee vault, taken by CoW at settlement. The
 * key approves CoW's vault relayer once per token. TWAP needs a smart account and stays the vault's.
 */
import {decodeAbiParameters, encodeFunctionData, erc20Abi, parseAbi, sliceHex, type Address, type Hex} from 'viem';
import {CHAIN_ID, NATIVE, publicClientFor, type Network} from '@/core/chain';
import {knownAssets} from '@/core/assets';
import {currentCatalog} from '@/core/asset-catalog';
import {ammAdapters} from '@/core/protocols';
import {vaultGuard} from '@/core/vault-contracts';
import {FEE_RECIPIENTS, GPV2_SETTLEMENT, ORDER_712_TYPES, buildLimitAppData, cowApiBase} from '@/core/cow';
import {ownerEthBalance} from '@/vault/direct';
import {ammSpeaksUniversal, fetchUniversalRoute} from '@/vault/universal-route';
import type {Signer} from '@/wallet/signer';
import {sendWalletCalls, standingApprovalIfNeeded, type WalletCall} from './calls';

const ADAPTER_ABI = parseAbi([
  'function universalRouter() view returns (address)',
  'function permit2() view returns (address)',
  'function feeRecipient() view returns (address)',
]);
const PERMIT2_ABI = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const GUARD_ABI = parseAbi(['function assetCategory(address asset) view returns (uint8)']);
const WRAPPED_ABI = parseAbi(['function deposit() payable']);

/** The adapter's market-swap fee. */
export const WALLET_SWAP_FEE_BPS = BigInt(20);
const STABLE_BIT = 1;
/** CoW's vault relayer: what pulls a CoW order's sell token. Same address on every chain CoW runs. */
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as Address;

const wrappedOf = (network: Network) =>
  [...knownAssets(network), ...currentCatalog(network)].find((a) => a.symbol === NATIVE[network].wrapped);

/**
 * The chain's coin, which balances show together with its wrapped token: wrap whatever the token
 * alone is short of `need`, so selling "WETH" spends ETH too.
 */
async function wrapShortfall(network: Network, wallet: Address, token: Address, need: bigint): Promise<WalletCall[]> {
  const w = wrappedOf(network);
  if (!w || w.address.toLowerCase() !== token.toLowerCase()) return [];
  const have = (await publicClientFor(network).readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet]})) as bigint;
  if (have >= need) return [];
  const coin = await ownerEthBalance(network, wallet);
  const short = need - have;
  if (coin < short) throw new Error('Not enough to sell');
  return [{to: token, value: short, data: encodeFunctionData({abi: WRAPPED_ABI, functionName: 'deposit'})}];
}

/** The trade adapter the vault would swap through, its router, Permit2 and fee recipient. */
async function marketParts(network: Network): Promise<{router: Address; permit2: Address; feeTo: Address}> {
  const amm = ammAdapters(network)[0];
  if (!amm || !(await ammSpeaksUniversal(amm, network))) throw new Error('Market trades from a wallet are not available on this network yet');
  const client = publicClientFor(network);
  const [router, permit2, feeTo] = await Promise.all([
    client.readContract({address: amm, abi: ADAPTER_ABI, functionName: 'universalRouter'}) as Promise<Address>,
    client.readContract({address: amm, abi: ADAPTER_ABI, functionName: 'permit2'}) as Promise<Address>,
    client.readContract({address: amm, abi: ADAPTER_ABI, functionName: 'feeRecipient'}) as Promise<Address>,
  ]);
  return {router, permit2, feeTo};
}

async function isStable(network: Network, token: Address): Promise<boolean> {
  try {
    const c = (await publicClientFor(network).readContract({address: vaultGuard(network), abi: GUARD_ABI, functionName: 'assetCategory', args: [token]})) as number;
    return (Number(c) & STABLE_BIT) !== 0;
  } catch {
    return false;
  }
}

/**
 * Market-sell exactly `amountIn` of `sellToken` for `buyToken` from the wallet. Resolves with the
 * swap's hash once it is broadcast; the fee follows it once it lands.
 */
export async function walletMarketSell(o: {
  account: Signer;
  network: Network;
  wallet: Address;
  sellToken: Address;
  buyToken: Address;
  amountIn: bigint;
  slippageBps: number;
}): Promise<{hash: Hex}> {
  const {network, wallet, sellToken, amountIn} = o;
  const client = publicClientFor(network);
  const {router, permit2, feeTo} = await marketParts(network);
  const fee = (amountIn * WALLET_SWAP_FEE_BPS) / BigInt(10_000);
  const swapIn = amountIn - fee;

  // 1. What the swap needs in place: the token in hand, Permit2 allowed to move it, the router allowed by Permit2.
  const prep: WalletCall[] = [...(await wrapShortfall(network, wallet, sellToken, amountIn))];
  prep.push(...(await standingApprovalIfNeeded(network, wallet, sellToken, permit2, swapIn)));
  const [allowed, expiration] = (await client.readContract({address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [wallet, sellToken, router]})) as readonly [bigint, number, number];
  const now = Math.floor(Date.now() / 1000);
  if (allowed < swapIn || expiration < now + 600) {
    // Only this swap's amount, for an hour: no Permit2 grant outlives the trade by much.
    prep.push({to: permit2, data: encodeFunctionData({abi: PERMIT2_ABI, functionName: 'approve', args: [sellToken, router, swapIn, now + 3600]})});
  }
  if (prep.length) {
    const {hash} = await sendWalletCalls({account: o.account, network, calls: prep});
    const r = await client.waitForTransactionReceipt({hash, timeout: 180_000});
    if (r.status !== 'success') throw new Error('The approval failed on chain');
  }

  // 2. The route, asked for only now: it carries a deadline, and the approvals above take a while.
  const stable = await isStable(network, sellToken);
  const q = await fetchUniversalRoute({network, tokenIn: sellToken, tokenOut: o.buyToken, amountIn: stable ? amountIn : swapIn, slippageBps: o.slippageBps});
  if (!q) throw new Error('No route to price this pair');
  const [commands, inputs, deadline] = decodeAbiParameters([{type: 'bytes'}, {type: 'bytes[]'}, {type: 'uint256'}], sliceHex(q.route, 4));
  const swap = await sendWalletCalls({
    account: o.account,
    network,
    calls: [{to: router, data: encodeFunctionData({abi: ROUTER_ABI, functionName: 'execute', args: [commands, [...inputs], deadline]})}],
  });

  // 3. Bitty's fee, from the input the swap left, once the swap has landed.
  if (fee > BigInt(0)) {
    void client
      .waitForTransactionReceipt({hash: swap.hash, timeout: 300_000})
      .then((r) =>
        r.status === 'success'
          ? sendWalletCalls({account: o.account, network, calls: [{to: sellToken, data: encodeFunctionData({abi: erc20Abi, functionName: 'transfer', args: [feeTo, fee]})}]})
          : null,
      )
      .catch(() => {});
  }
  return swap;
}

/** The fee vault CoW pays a partner fee to: what the vault's own CoW adapter names (core/cow). */
const COW_FEE_RECIPIENT = FEE_RECIPIENTS[0];

/** Place a CoW limit order from the wallet: sell `sellAmount` for at least `buyAmount`, until `validSeconds` from now. */
export async function walletLimitOrder(o: {
  account: Signer;
  network: Network;
  wallet: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  validSeconds: number;
}): Promise<string> {
  const {network, wallet} = o;
  const base = cowApiBase(network);
  // The relayer needs the token and an allowance before CoW will accept the order.
  const prep: WalletCall[] = [
    ...(await wrapShortfall(network, wallet, o.sellToken, o.sellAmount)),
    ...(await standingApprovalIfNeeded(network, wallet, o.sellToken, COW_VAULT_RELAYER, o.sellAmount)),
  ];
  if (prep.length) {
    const {hash} = await sendWalletCalls({account: o.account, network, calls: prep});
    const r = await publicClientFor(network).waitForTransactionReceipt({hash, timeout: 180_000});
    if (r.status !== 'success') throw new Error('The approval failed on chain');
  }
  const app = buildLimitAppData(COW_FEE_RECIPIENT);
  await fetch(`${base}/app_data/${app.hash}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({fullAppData: app.fullAppData})}).catch(() => {});
  const order = {
    sellToken: o.sellToken,
    buyToken: o.buyToken,
    receiver: wallet,
    sellAmount: o.sellAmount,
    buyAmount: o.buyAmount,
    validTo: Math.floor(Date.now() / 1000) + o.validSeconds,
    appData: app.hash,
    feeAmount: BigInt(0),
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  } as const;
  const signature = await o.account.signTypedData({
    domain: {name: 'Gnosis Protocol', version: 'v2', chainId: CHAIN_ID[network], verifyingContract: GPV2_SETTLEMENT},
    types: ORDER_712_TYPES,
    primaryType: 'Order',
    message: order,
  });
  const res = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      ...order,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      feeAmount: '0',
      appData: app.fullAppData,
      appDataHash: app.hash,
      signingScheme: 'eip712',
      signature,
      from: wallet,
    }),
  });
  if (!res.ok) throw new Error(`CoW rejected: ${await res.text()}`);
  return (await res.json()) as string;
}

/** Cancel the wallet's CoW orders: a signed cancellation CoW honours at once, no transaction. */
export async function walletCancelOrders(o: {account: Signer; network: Network; uids: Hex[]}): Promise<void> {
  const signature = await o.account.signTypedData({
    domain: {name: 'Gnosis Protocol', version: 'v2', chainId: CHAIN_ID[o.network], verifyingContract: GPV2_SETTLEMENT},
    types: {OrderCancellations: [{name: 'orderUids', type: 'bytes[]'}]},
    primaryType: 'OrderCancellations',
    message: {orderUids: o.uids},
  });
  const res = await fetch(`${cowApiBase(o.network)}/orders`, {
    method: 'DELETE',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({orderUids: o.uids, signature, signingScheme: 'eip712'}),
  });
  if (!res.ok) throw new Error(`CoW refused the cancellation: ${await res.text()}`);
}

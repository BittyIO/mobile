/**
 * Transfers from the WALLET (core/account-mode): the key's own address sends the coin or token
 * itself and pays its own network fee, in ETH / BNB / TRX. No vault, no relayer, no relay fee.
 *
 * EVM: a plain value transfer, or the token's `transfer`, through vault/direct `sendFromOwner` —
 * the same signing, nonce and gas-check path the owner-pays fee mode already uses.
 *
 * Tron: a TRC-20 `transfer` is a contract call, so it takes the same path (a TriggerSmartContract
 * from the key). A TRX transfer is not a contract call at all — it is Tron's own TransferContract,
 * which burns bandwidth and no energy — so it is encoded and signed here (tron/tx `kind: 'trx'`).
 */
import {encodeFunctionData, erc20Abi, type Address, type Hex, type LocalAccount} from 'viem';
import {isTronNetwork, publicClientFor, type Network} from '@/core/chain';
import {OwnerGasShort, ownerEthBalance, planOwnerTx, sendFromOwner, type OwnerTxPlan} from '@/vault/direct';

/** What a wallet can send: the chain's coin, or a token by its contract. */
export type WalletAsset = {symbol: string; address: Address | 'native'; decimals: number};

export type WalletTransfer = {
  network: Network;
  from: Address;
  to: Address;
  asset: WalletAsset;
  amount: bigint;
  /** Tron: a note on the transaction, which Tron charges its memo fee for. */
  memo?: string;
};

/**
 * What a note adds to a Tron transaction, in sun: the chain's memo fee (1 TRX), plus its bytes of
 * bandwidth (1,000 sun a byte, worst case). 0 without a note.
 */
export async function memoCost(network: Network, memo?: string): Promise<bigint> {
  if (!memo || !isTronNetwork(network)) return BigInt(0);
  const {memoFeeSun} = require('@/tron/client') as typeof import('@/tron/client');
  const {memoBytes} = require('@/tron/tx') as typeof import('@/tron/tx');
  const fee = await memoFeeSun(network as import('@/tron/config').TronChain);
  return fee + BigInt(memoBytes(memo).length + 3) * BigInt(1_000);
}

/** The transaction a transfer is: where it goes, with what calldata and value. */
function txOf(t: WalletTransfer): {to: Address; data: Hex; value: bigint} {
  if (t.asset.address === 'native') return {to: t.to, data: '0x', value: t.amount};
  return {to: t.asset.address, data: encodeFunctionData({abi: erc20Abi, functionName: 'transfer', args: [t.to, t.amount]}), value: BigInt(0)};
}

/**
 * A TRX transfer's bandwidth, in sun: ~270 bytes of transaction at 1,000 sun a byte once the day's
 * free bandwidth is spent, plus the 1 TRX Tron burns to create a recipient that is not an account
 * yet. Charged as the worst case — what the wallet must hold — though the free allowance usually
 * covers the bandwidth.
 */
async function planTrx(t: WalletTransfer): Promise<OwnerTxPlan> {
  const {accountExists} = require('@/tron/client') as typeof import('@/tron/client');
  const {evmToTron} = require('@/tron/address') as typeof import('@/tron/address');
  const exists = await accountExists(t.network as import('@/tron/config').TronChain, evmToTron(t.to)).catch(() => true);
  const l1Fee = BigInt(270_000) + (exists ? BigInt(0) : BigInt(1_100_000));
  return {gas: BigInt(0), maxFeePerGas: BigInt(0), maxPriorityFeePerGas: BigInt(0), l1Fee, cost: l1Fee};
}

/**
 * The fee this transfer will take, worst case, in the chain's coin (wei / sun): what {sendWalletTransfer}
 * checks the wallet holds on top of what it sends. Throws when the transfer would revert.
 */
export async function planWalletTransfer(t: WalletTransfer): Promise<OwnerTxPlan> {
  const [plan, memo] = await Promise.all([
    isTronNetwork(t.network) && t.asset.address === 'native' ? planTrx(t) : planOwnerTx({network: t.network, from: t.from, ...txOf(t)}),
    memoCost(t.network, t.memo),
  ]);
  // The note is charged beside the energy, like bandwidth.
  return memo > BigInt(0) ? {...plan, l1Fee: plan.l1Fee + memo, cost: plan.cost + memo} : plan;
}

/**
 * The most of the chain's coin the wallet can send: its balance less the fee of sending it. Asked
 * of a transfer of the whole balance, then a sixth more fee kept back, since the price moves
 * between the quote and the send.
 */
export async function maxNativeSend(network: Network, from: Address, to: Address, memo?: string): Promise<bigint> {
  const have = await ownerEthBalance(network, from);
  const asset: WalletAsset = {symbol: '', address: 'native', decimals: 18};
  const plan = await planWalletTransfer({network, from, to, asset, amount: BigInt(0), memo}).catch(() => null);
  if (!plan) return BigInt(0);
  const keep = plan.cost + plan.cost / BigInt(6);
  return have > keep ? have - keep : BigInt(0);
}

/** Send it. Returns once broadcast; the caller's toast follows it to its receipt. */
export async function sendWalletTransfer(
  o: WalletTransfer & {
    account: LocalAccount;
    plan?: OwnerTxPlan;
    /** Rented energy (tron/usdt-gas): the quote, and the coin the fee is paid in. */
    rented?: {quote: import('@/tron/usdt-gas').UsdtGasQuote; feeIn: import('@/tron/usdt-gas').FeeCoin};
  },
): Promise<{hash: Hex}> {
  // Rented energy (tron/usdt-gas): Bitty's server rents it and is paid in TRX or USDT.
  if (o.rented && isTronNetwork(o.network) && o.asset.address !== 'native') {
    const {sendWithUsdtGas} = require('@/tron/usdt-gas') as typeof import('@/tron/usdt-gas');
    return sendWithUsdtGas({
      net: o.network as import('@/tron/config').TronChain,
      account: o.account,
      from: o.from,
      to: o.to,
      token: o.asset.address,
      amount: o.amount,
      quote: o.rented.quote,
      feeIn: o.rented.feeIn,
    });
  }
  if (isTronNetwork(o.network) && o.asset.address === 'native') {
    const plan = o.plan ?? (await planWalletTransfer(o));
    const have = await ownerEthBalance(o.network, o.from);
    if (have < plan.cost + o.amount) throw new OwnerGasShort(o.from, plan.cost + o.amount, have, o.network);
    return sendTrx(o);
  }
  return sendFromOwner({account: o.account, network: o.network, ...txOf(o), plan: o.plan, memo: o.memo});
}

/** A TRX TransferContract, signed over its transaction id with the wallet key. */
async function sendTrx(o: WalletTransfer & {account: LocalAccount}): Promise<{hash: Hex}> {
  if (!o.account.sign) throw new Error('This key cannot sign a Tron transaction');
  const {evmToTron} = require('@/tron/address') as typeof import('@/tron/address');
  const {broadcast, refBlock} = require('@/tron/client') as typeof import('@/tron/client');
  const {encodeRaw, encodeSigned, txIdOf} = require('@/tron/tx') as typeof import('@/tron/tx');
  const net = o.network as import('@/tron/config').TronChain;
  const raw = encodeRaw({kind: 'trx', from: evmToTron(o.from), to: evmToTron(o.to), amountSun: o.amount}, await refBlock(net), {memo: o.memo});
  const txID = txIdOf(raw);
  const signature = await o.account.sign({hash: `0x${txID}`});
  const id = await broadcast(net, encodeSigned(raw, signature.replace(/^0x/, '')), txID);
  return {hash: `0x${id}`};
}

/** The wallet's balance of `asset`, raw. */
export function walletBalanceOf(network: Network, from: Address, asset: WalletAsset): Promise<bigint> {
  if (asset.address === 'native') return ownerEthBalance(network, from);
  return publicClientFor(network).readContract({address: asset.address, abi: erc20Abi, functionName: 'balanceOf', args: [from]}) as Promise<bigint>;
}

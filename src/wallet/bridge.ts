/**
 * The bridge from a WALLET (core/account-mode): the same Across crossing the vault makes through its
 * adapter (vault/bridge), made by the key itself, to the same key's address on the other network.
 *
 * The routes and the quote are the vault's: the guard's routes (which tokens cross, what arrives,
 * the most a crossing may cost) and Across's quote checked against them (`quoteBridge`). What the
 * adapter does on the vault's behalf, the wallet does in its own transactions:
 *  1. Bitty's fee (`BRIDGE_FEE_BPS`, 0.2%) to the adapter's own fee recipient — the address the
 *     vault's bridge pays, read from the adapter so Tron's (its own) is right too;
 *  2. for the chain's coin, any of it the wallet holds wrapped is unwrapped first (balances show the
 *     coin and its wrapped token as one figure); for a token, the SpokePool's allowance;
 *  3. the deposit into Across's SpokePool, depositor and recipient both the wallet, so an unfilled
 *     deposit is refunded to it here.
 * Each step lands before the next is sent (wallet/calls).
 */
import {encodeFunctionData, erc20Abi, pad, parseAbi, type Address, type Hex} from 'viem';
import {isTronNetwork, NATIVE, publicClientFor, type Network} from '@/core/chain';
import {knownAssets} from '@/core/assets';
import {ownerEthBalance} from '@/vault/direct';
import type {Signer} from '@/wallet/signer';
import type {BridgeInfo, BridgeQuote, BridgeRoute} from '@/vault/bridge';
import {approvalIfNeeded, sendWalletCalls, type WalletCall} from './calls';

const SPOKE_DEPOSIT_ABI = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable',
]);
const FEE_ABI = parseAbi(['function feeRecipient() view returns (address)']);
const WETH_ABI = parseAbi(['function withdraw(uint256 wad)']);

const b32 = (a: Address): Hex => pad(a, {size: 32});

/** Where Bitty's fee goes: the adapter's recipient, as a vault's bridge pays it. */
export function bridgeFeeRecipient(network: Network, adapter: Address): Promise<Address> {
  return publicClientFor(network).readContract({address: adapter, abi: FEE_ABI, functionName: 'feeRecipient'}) as Promise<Address>;
}

/** The wallet's wrapped coin (WETH, WBNB) by its listed address, for an unwrap. */
const wrappedOf = (network: Network) => knownAssets(network).find((a) => a.symbol === NATIVE[network].wrapped);

/** Every transaction the wallet sends for this bridge, in order. */
export async function walletBridgeCalls(o: {
  network: Network;
  info: BridgeInfo;
  route: BridgeRoute;
  quote: BridgeQuote;
  wallet: Address;
  /** Who is paid on the other side: the wallet's own address there unless another is named. */
  recipient?: Address;
}): Promise<WalletCall[]> {
  const {network, info, route, quote, wallet} = o;
  const deposit = quote.amount - quote.fee;
  const feeTo = await bridgeFeeRecipient(network, info.adapter);
  const calls: WalletCall[] = [];
  if (route.native) {
    // The coin as balances show it is the coin plus its wrapped token: unwrap whatever the coin alone is short.
    const have = await ownerEthBalance(network, wallet);
    const short = quote.amount > have ? quote.amount - have : BigInt(0);
    const w = wrappedOf(network);
    if (short > BigInt(0) && w) calls.push({to: w.address, data: encodeFunctionData({abi: WETH_ABI, functionName: 'withdraw', args: [short]})});
    if (quote.fee > BigInt(0)) calls.push({to: feeTo, value: quote.fee});
  } else {
    if (quote.fee > BigInt(0)) calls.push({to: route.asset.address, data: encodeFunctionData({abi: erc20Abi, functionName: 'transfer', args: [feeTo, quote.fee]})});
    calls.push(...(await approvalIfNeeded(network, wallet, route.asset.address, info.spokePool, deposit)));
  }
  const a = quote.across;
  calls.push({
    to: info.spokePool,
    value: route.native ? deposit : BigInt(0),
    data: encodeFunctionData({
      abi: SPOKE_DEPOSIT_ABI,
      functionName: 'deposit',
      args: [
        b32(wallet),
        b32(o.recipient ?? wallet),
        b32(route.inputToken),
        b32(a.outputToken),
        deposit,
        a.outputAmount,
        a.destinationChainId,
        b32(a.exclusiveRelayer),
        a.quoteTimestamp,
        a.fillDeadline,
        a.exclusivityParameter,
        '0x',
      ],
    }),
  });
  return calls;
}

/** Bridge from the wallet: every step, in order. Resolves with the deposit's hash. */
export async function bridgeFromWallet(o: {
  account: Signer;
  network: Network;
  info: BridgeInfo;
  route: BridgeRoute;
  quote: BridgeQuote;
  wallet: Address;
  recipient?: Address;
}): Promise<{hash: Hex}> {
  const calls = await walletBridgeCalls(o);
  return sendWalletCalls({account: o.account, network: o.network, calls});
}

/**
 * What the chain's coin pays for a wallet bridge, worst case, in wei / sun: the fee transfer, an
 * approval and the deposit. Gas units by experience on EVM (Across's deposit is ~120k); on Tron, the
 * energy of a USDT transfer, approval and deposit at the burn price, with nothing frozen.
 */
export async function walletBridgeCost(network: Network, native: boolean): Promise<bigint> {
  const client = publicClientFor(network);
  if (isTronNetwork(network)) {
    // ~65k energy for the fee transfer, ~45k the approval, ~130k the deposit, at 210 sun an energy unit.
    return BigInt(240_000 * 210 + 1_000_000);
  }
  const fees = await client.estimateFeesPerGas();
  const units = native ? BigInt(200_000) : BigInt(260_000);
  return units * (fees.maxFeePerGas ?? BigInt(0));
}

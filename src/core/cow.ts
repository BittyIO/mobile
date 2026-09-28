/**
 * CoW Protocol constants + EIP-712 shapes for gasless limit orders, ported from web
 * lib/cow-offchain + lib/cow-api. A limit order is off-chain: the manager (= owner) signs a GPv2
 * Order; the signature is wrapped into the eip1271 payload the vault's intent clone verifies; the
 * order is POSTed to the CoW orderbook. Nothing on-chain, no gas — it simply settles or expires
 * against the vault's live balance.
 */
import {keccak256, stringToHex, type AbiParameter} from 'viem';
import {CHAIN_ID, type Network} from '@/core/chain';

// GPv2Settlement — the EIP-712 verifying contract for CoW orders. Same address on every chain.
export const GPV2_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;

// GPv2Order enum values as their keccak256(string) constants (the bytes32 form the clone decodes).
export const KIND_SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775' as const;
export const KIND_BUY = '0x6ed88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc' as const;
export const BALANCE_ERC20 = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9' as const;

const COW_API: Record<number, string> = {
  1: 'https://api.cow.fi/mainnet/api/v1',
  11155111: 'https://api.cow.fi/sepolia/api/v1',
  8453: 'https://api.cow.fi/base/api/v1',
};

/** Whether CoW (limit / TWAP orders) exists on this network. */
export const cowSupported = (network: Network): boolean => !!COW_API[CHAIN_ID[network]];

export function cowApiBase(network: Network): string {
  const url = COW_API[CHAIN_ID[network]];
  if (!url) throw new Error(`CoW not supported on ${network}`);
  return url;
}

// EIP-712 Order type (CoW canonical). kind / *TokenBalance are strings here — EIP-712 hashes them.
export const ORDER_712_TYPES = {
  Order: [
    {name: 'sellToken', type: 'address'},
    {name: 'buyToken', type: 'address'},
    {name: 'receiver', type: 'address'},
    {name: 'sellAmount', type: 'uint256'},
    {name: 'buyAmount', type: 'uint256'},
    {name: 'validTo', type: 'uint32'},
    {name: 'appData', type: 'bytes32'},
    {name: 'feeAmount', type: 'uint256'},
    {name: 'kind', type: 'string'},
    {name: 'partiallyFillable', type: 'bool'},
    {name: 'sellTokenBalance', type: 'string'},
    {name: 'buyTokenBalance', type: 'string'},
  ],
} as const;

// GPv2Order.Data tuple for abi.encode — the bytes32 form the clone abi.decodes. Field order MUST match.
export const ORDER_TUPLE: AbiParameter = {
  type: 'tuple',
  components: [
    {name: 'sellToken', type: 'address'},
    {name: 'buyToken', type: 'address'},
    {name: 'receiver', type: 'address'},
    {name: 'sellAmount', type: 'uint256'},
    {name: 'buyAmount', type: 'uint256'},
    {name: 'validTo', type: 'uint32'},
    {name: 'appData', type: 'bytes32'},
    {name: 'feeAmount', type: 'uint256'},
    {name: 'kind', type: 'bytes32'},
    {name: 'partiallyFillable', type: 'bool'},
    {name: 'sellTokenBalance', type: 'bytes32'},
    {name: 'buyTokenBalance', type: 'bytes32'},
  ],
};

// EIP-712 type for a whole TWAP schedule — signed ONCE; the clone reconstructs each part from it.
export const TWAP_712_TYPES = {
  TwapOrder: [
    {name: 'sellToken', type: 'address'},
    {name: 'buyToken', type: 'address'},
    {name: 'sellAmountPerPart', type: 'uint256'},
    {name: 'buyAmountPerPart', type: 'uint256'},
    {name: 'startTime', type: 'uint256'},
    {name: 'partDuration', type: 'uint256'},
    {name: 'numParts', type: 'uint256'},
  ],
} as const;

// TwapOrder tuple for abi.encode into each part's eip1271 payload. Field order matches the struct.
export const TWAP_TUPLE: AbiParameter = {
  type: 'tuple',
  components: [
    {name: 'sellToken', type: 'address'},
    {name: 'buyToken', type: 'address'},
    {name: 'sellAmountPerPart', type: 'uint256'},
    {name: 'buyAmountPerPart', type: 'uint256'},
    {name: 'startTime', type: 'uint256'},
    {name: 'partDuration', type: 'uint256'},
    {name: 'numParts', type: 'uint256'},
  ],
};

// The fee-bearing appData a limit order carries — byte-identical to the contract's APP_DATA document,
// so keccak256(fullAppData) == the intent clone's APP_DATA(). Registering it lets solvers resolve the
// 0.2% partner fee; the contract requires exactly this appData, so the fee can't be stripped.
const FEE_RECIPIENT = '0x12EE2de7BF086388B1D560eb95e7191Edfab9823';
export function buildLimitAppData(): {hash: `0x${string}`; fullAppData: string} {
  const fullAppData =
    '{"appCode":"BittyVault",' +
    `"metadata":{"partnerFee":{"bps":20,"recipient":"${FEE_RECIPIENT}"}},` +
    '"version":"1.3.0"}';
  return {hash: keccak256(stringToHex(fullAppData)), fullAppData};
}

// A TWAP's appData is salted by its start time (the on-chain block timestamp), carried in an
// "environment" field — byte-identical to the contract's twapFullAppData(salt) or hashes won't match.
export function buildTwapAppData(salt: bigint): {hash: `0x${string}`; fullAppData: string} {
  const fullAppData =
    `{"appCode":"BittyVault","environment":"${salt.toString()}",` +
    `"metadata":{"partnerFee":{"bps":20,"recipient":"${FEE_RECIPIENT}"}},` +
    '"version":"1.3.0"}';
  return {hash: keccak256(stringToHex(fullAppData)), fullAppData};
}

export const COW_PARTNER_FEE_BPS = 20; // 0.2%

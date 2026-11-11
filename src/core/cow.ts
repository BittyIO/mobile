/**
 * CoW Protocol constants + EIP-712 shapes for gasless limit orders, ported from web
 * lib/cow-offchain + lib/cow-api. A limit order is off-chain: the manager (= owner) signs a GPv2
 * Order; the signature is wrapped into the eip1271 payload the vault's intent clone verifies; the
 * order is POSTed to the CoW orderbook. Nothing on-chain, no gas — it simply settles or expires
 * against the vault's live balance.
 */
import {encodeAbiParameters, keccak256, parseAbi, stringToHex, type AbiParameter, type Address, type Hex} from 'viem';
import {CHAIN_ID, publicClientFor, type Network} from '@/core/chain';

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
  42161: 'https://api.cow.fi/arbitrum_one/api/v1',
  56: 'https://api.cow.fi/bnb/api/v1',
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

/**
 * What a signer signs for a limit order on adapter 1.0.4 and later: the CoW order nested whole in a
 * VaultOrder naming the vault, under Bitty's own domain.
 *
 * A bare CoW order digest signed by a key is ALSO a valid CoW order owned by that key, so the bytes
 * that authorised a vault order could fill from the signer's own wallet — an EIP-7702 account's
 * especially. Wrapped this way CoW has nothing it can settle, and the signature is bound to one vault.
 * Older clones still read the bare order: see {VAULT_ORDER_SINCE}.
 */
export const VAULT_ORDER_712_TYPES = {
  VaultOrder: [
    {name: 'vault', type: 'address'},
    {name: 'order', type: 'Order'},
  ],
  Order: ORDER_712_TYPES.Order,
} as const;
export const vaultOrderDomain = (chainId: number) => ({name: 'Bitty Vault Order', version: '1', chainId}) as const;
/** The adapter build (1.0.4) from which a clone checks a VaultOrder rather than the bare order. */
export const VAULT_ORDER_SINCE = 1_000_004n;

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

/**
 * EIP-712 type for a whole TWAP schedule — signed ONCE; the clone reconstructs each part from it.
 * Bound to one vault: the adapter's TWAP_TYPE_HASH starts with `address vault` (the clone's owner),
 * so a schedule signed for one vault cannot be replayed on another.
 *
 * The vault is NOT in the TWAP_TUPLE payload: the clone supplies its own when it re-hashes.
 */
export const TWAP_712_TYPES = {
  TwapOrder: [
    {name: 'vault', type: 'address'},
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
// The recipient is part of those bytes and differs by adapter build, so it is read from the vault's own
// clone ({cowFeeRecipient}) rather than assumed: the 1.0.0 adapter pays the fee Safe, and 1.0.1 the
// fee Safe's vault — and a vault may sit on either.
const FEE_SAFE = '0x5837C8F4963F694C59e53445C070acb266187bF1';
const FEE_VAULT = '0xF0E7f6998B362BD15CF819C7EBfcaCe8865FECA0';
const defaultRecipient = () => FEE_SAFE;

/** Every partner-fee recipient an adapter build has used; what a fee appData can name. */
export const FEE_RECIPIENTS = [FEE_VAULT, FEE_SAFE];

/**
 * The signer's part of an eip1271 payload, as the intent clone reads it.
 *
 * A key's 65 bytes go in bare and the clone recovers the signer, as it always has. A contract
 * wallet's signature recovers nothing useful — a 1-of-1 Safe's is also 65 bytes, and recovers the
 * Safe's OWNER rather than the Safe — so it goes in as abi.encode(signer, signature) and the clone
 * checks it with ERC-1271 against that address. Only adapter 1.0.2 and later read the wrapped form;
 * an older clone rejects it and CoW refuses the order.
 */
export const orderSignerSig = (signer: {address: Address; isContract?: boolean}, sig: Hex): Hex =>
  signer.isContract ? encodeAbiParameters([{type: 'address'}, {type: 'bytes'}], [signer.address, sig]) : sig;

const COW_FEE_ABI = parseAbi([
  'function getClone(address protocol) view returns (address)',
  'function PARTNER_FEE_RECIPIENT() view returns (address)',
  'function protocolVersion() view returns (uint256)',
]);

/** The build of the CoW code that will check the vault's orders (its clone, else the adapter). */
export async function cowAdapterVersion(network: Network, vault: Address, intentProtocol: Address): Promise<bigint> {
  const at = await cowAdapterFor(network, vault, intentProtocol);
  return publicClientFor(network).readContract({address: at, abi: COW_FEE_ABI, functionName: 'protocolVersion'});
}

/**
 * The partner-fee recipient the vault's CoW clone requires — the one its code was built with. Read
 * after {prepareIntent} has made the clone; before that (or on an RPC failure) the fee Safe is the
 * best guess, and a wrong one fails as an unauthorised order rather than silently.
 */
export async function cowFeeRecipient(network: Network, vault: Address, intentProtocol: Address): Promise<string> {
  try {
    const at = await cowAdapterFor(network, vault, intentProtocol);
    return await publicClientFor(network).readContract({address: at, abi: COW_FEE_ABI, functionName: 'PARTNER_FEE_RECIPIENT'});
  } catch {
    return defaultRecipient();
  }
}

/**
 * The CoW adapter code a vault's orders are checked by: its clone of `intentProtocol` once it has
 * one, else the adapter itself — the code the clone will be made from.
 */
export async function cowAdapterFor(network: Network, vault: Address, intentProtocol: Address): Promise<Address> {
  const clone = await publicClientFor(network).readContract({address: vault, abi: COW_FEE_ABI, functionName: 'getClone', args: [intentProtocol]});
  return /^0x0+$/.test(clone) ? intentProtocol : clone;
}

export function buildLimitAppData(recipient: string = defaultRecipient()): {hash: `0x${string}`; fullAppData: string} {
  const fullAppData =
    '{"appCode":"BittyVault",' +
    `"metadata":{"partnerFee":{"bps":20,"recipient":"${recipient}"}},` +
    '"version":"1.3.0"}';
  return {hash: keccak256(stringToHex(fullAppData)), fullAppData};
}

/**
 * Every plain limit-order appData any adapter build uses, lower-cased. A TWAP part carries a salted one,
 * so this is how history tells the two apart whichever adapter placed the order.
 */
export const LIMIT_APP_DATA_HASHES = new Set(
  [FEE_SAFE, FEE_VAULT].map((r) => buildLimitAppData(r).hash.toLowerCase()),
);

// A TWAP's appData is salted by its start time (the on-chain block timestamp), carried in an
// "environment" field — byte-identical to the contract's twapFullAppData(salt) or hashes won't match.
export function buildTwapAppData(
  salt: bigint,
  recipient: string = defaultRecipient(),
): {hash: `0x${string}`; fullAppData: string} {
  const fullAppData =
    `{"appCode":"BittyVault","environment":"${salt.toString()}",` +
    `"metadata":{"partnerFee":{"bps":20,"recipient":"${recipient}"}},` +
    '"version":"1.3.0"}';
  return {hash: keccak256(stringToHex(fullAppData)), fullAppData};
}

export const COW_PARTNER_FEE_BPS = 20; // 0.2%

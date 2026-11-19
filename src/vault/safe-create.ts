/**
 * Create a Safe from the app: owners and threshold chosen here, deployed by a key on this phone (the
 * Safe owner's imported key, which sends the transaction and pays its gas). No Safe{Wallet} needed.
 *
 * It is the canonical Safe 1.4.1 — the same factory, singleton and fallback handler Safe{Wallet}
 * uses, at the same addresses on every network Bitty supports — so the Safe is a standard one any
 * Safe tool can open later. The singleton is SafeL2 on every network (see singletonFor). The address is worked out before anything is sent, from this chain's own factory code.
 */
import {
  concat,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';

export const SAFE_141 = {
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  safe: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  safeL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
} as const;

const FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function proxyCreationCode() pure returns (bytes)',
]);
const SETUP_ABI = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);

/**
 * SafeL2 on every network, Ethereum and Sepolia too: the singleton Safe{Wallet} deployed with there
 * (seen on a Sepolia Safe it created), and one singleton everywhere means the same owners, threshold
 * and salt give the same address on every network Bitty supports.
 */
const singletonFor = (_network: Network): Address => SAFE_141.safeL2;

export type NewSafe = {address: Address; factory: Address; data: Hex};

// The factory's proxy code, per network and factory: read once, it never changes.
const creationCode = new Map<string, Promise<Hex>>();
const proxyCode = (network: Network, factory: Address): Promise<Hex> => {
  const k = `${network}:${factory.toLowerCase()}`;
  let p = creationCode.get(k);
  if (!p) {
    p = publicClientFor(network).readContract({address: factory, abi: FACTORY_ABI, functionName: 'proxyCreationCode'});
    p.catch(() => creationCode.delete(k));
    creationCode.set(k, p);
  }
  return p;
};

/** The CREATE2 address a `createProxyWithNonce` lands on, from this chain's own factory code. */
export async function predictSafe(network: Network, factory: Address, singleton: Address, initializer: Hex, saltNonce: bigint): Promise<Address> {
  const code = await proxyCode(network, factory);
  const salt = keccak256(concat([keccak256(initializer), pad(toHex(saltNonce), {size: 32})]));
  return getContractAddress({opcode: 'CREATE2', from: factory, salt, bytecode: concat([code, pad(singleton, {size: 32})])});
}

/**
 * The deploy for a new Safe of `owners` needing `threshold` signatures, and the address it will
 * have — known before anything is sent, so the page shows it as the owners are entered.
 *
 * The salt counts up from 0 past any Safe already there: the same owners and threshold give the
 * same address each time it is worked out (on every network, as the contracts are the same), and a
 * second Safe for them takes the next free one.
 */
export async function planNewSafe(o: {network: Network; owners: Address[]; threshold: number}): Promise<NewSafe> {
  const owners = o.owners.map((a) => getAddress(a));
  const initializer = encodeFunctionData({
    abi: SETUP_ABI,
    functionName: 'setup',
    args: [owners, BigInt(o.threshold), zeroAddress, '0x', SAFE_141.fallbackHandler, zeroAddress, BigInt(0), zeroAddress],
  });
  const singleton = singletonFor(o.network);
  const client = publicClientFor(o.network);
  let saltNonce = BigInt(0);
  let address = await predictSafe(o.network, SAFE_141.factory, singleton, initializer, saltNonce);
  for (let i = 0; i < 20; i++) {
    const code = await client.getCode({address});
    if (!code || code === '0x') break;
    saltNonce += BigInt(1);
    address = await predictSafe(o.network, SAFE_141.factory, singleton, initializer, saltNonce);
  }
  return {
    address,
    factory: SAFE_141.factory,
    data: encodeFunctionData({abi: FACTORY_ABI, functionName: 'createProxyWithNonce', args: [singleton, initializer, saltNonce]}),
  };
}

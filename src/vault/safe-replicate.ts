/**
 * Put a Safe that exists on one network onto another, at the same address.
 *
 * A Safe is a CREATE2 proxy: its address is fixed by the factory, the singleton, the setup call it
 * was initialised with (owners, threshold, fallback handler, modules) and a salt nonce. Replay that
 * exact `createProxyWithNonce` on a chain where the same factory and singleton are deployed — the
 * canonical Safe deployments are, at the same addresses, on every chain Bitty supports — and the
 * proxy lands at the same address with the same owners. That is what lets a vault the Safe owns be
 * activated and signed for on a network the Safe was never used on.
 *
 * Nothing is guessed. The creation is read from the network the Safe is on: its `SafeSetup` event
 * (emitted by the proxy itself, so it is found without scanning the factory) names the transaction,
 * the transaction carries the factory call, and the receipt names the factory. Before anything is
 * offered, the address that call would create HERE is computed from this chain's own factory code
 * and must equal the Safe's; otherwise it is refused.
 */
import {decodeFunctionData, encodeFunctionData, keccak256, parseAbi, parseAbiItem, toHex, type Address, type Hex} from 'viem';
import {apiUrl, isTronNetwork, publicClientFor, type Network} from '@/core/chain';
import {predictSafe} from './safe-create';
import {NETWORKS} from '@/core/network-store';

const FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function proxyCreationCode() pure returns (bytes)',
]);
const SAFE_SETUP = parseAbiItem('event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)');
/** ProxyCreation from 1.3.0 (unindexed) and 1.4.1 (proxy indexed): the same signature either way. */
const PROXY_CREATION_TOPIC = keccak256(toHex('ProxyCreation(address,address)'));
const CREATE_SELECTOR = '1688f0b9'; // createProxyWithNonce(address,bytes,uint256)

export type SafeDeploy = {
  /** The network the Safe was found on and its creation read from. */
  source: Network;
  factory: Address;
  /** The `createProxyWithNonce` call to send on the target network. */
  data: Hex;
};

export class SafeReplicateError extends Error {
  constructor(readonly reason: 'not-found' | 'unknown-creation' | 'mismatch') {
    super(reason);
  }
}

const hasCode = (network: Network, address: Address) =>
  publicClientFor(network)
    .getCode({address})
    .then((c) => !!c && c !== '0x')
    .catch(() => false);

/** The factory call inside `input`: the transaction's own, or one embedded in a batch around it. */
function findCreateCall(input: Hex): {singleton: Address; initializer: Hex; saltNonce: bigint} | null {
  const hex = input.slice(2).toLowerCase();
  for (let at = hex.indexOf(CREATE_SELECTOR); at >= 0; at = hex.indexOf(CREATE_SELECTOR, at + 1)) {
    if (at % 2 !== 0) continue;
    try {
      const d = decodeFunctionData({abi: FACTORY_ABI, data: `0x${hex.slice(at)}`});
      if (d.functionName !== 'createProxyWithNonce') continue;
      const [singleton, initializer, saltNonce] = d.args as readonly [Address, Hex, bigint];
      return {singleton, initializer, saltNonce};
    } catch {
      // a byte run that only looks like the selector
    }
  }
  return null;
}

type Creation = {factory: Address; singleton: Address; initializer: Hex; saltNonce: bigint};

/**
 * How `safe` was created on `network`: asked of the server (web /api/ethereum/safe/:safe/creation),
 * which reads it through an archive node, else read here — finding the setup event is a log query
 * from block 0, which most public endpoints this app uses refuse.
 */
async function creationOn(network: Network, safe: Address): Promise<Creation | null> {
  try {
    const res = await fetch(apiUrl(`/api/ethereum/safe/${safe}/creation`, network));
    const json = (await res.json().catch(() => null)) as {ok?: boolean; creation?: {factory: Address; singleton: Address; initializer: Hex; saltNonce: string}} | null;
    if (json?.ok && json.creation) return {...json.creation, saltNonce: BigInt(json.creation.saltNonce)};
  } catch {
    // unreachable: try the chain directly
  }
  return creationFromChain(network, safe);
}

/** {creationOn}, read from the chain through this phone's own endpoints. Null when it cannot be told. */
async function creationFromChain(network: Network, safe: Address): Promise<Creation | null> {
  const client = publicClientFor(network);
  const logs = await client.getLogs({address: safe, event: SAFE_SETUP, fromBlock: BigInt(0), toBlock: 'latest'}).catch(() => []);
  const hash = logs[0]?.transactionHash;
  if (!hash) return null;
  const [tx, receipt] = await Promise.all([client.getTransaction({hash}), client.getTransactionReceipt({hash})]);
  const call = findCreateCall(tx.input);
  if (!call) return null;
  // The factory is whoever logged ProxyCreation in that transaction.
  const factory = receipt.logs.find((l) => l.topics[0]?.toLowerCase() === PROXY_CREATION_TOPIC.toLowerCase())?.address;
  if (!factory) return null;
  return {factory: factory as Address, ...call};
}

/**
 * The deploy that puts `safe` on `target` at the same address, worked out from a network it is on.
 * Throws {SafeReplicateError}: `not-found` (on no network Bitty supports), `unknown-creation` (its
 * creation cannot be read), `mismatch` (that call would not land at the same address here).
 */
export async function planSafeDeploy(safe: Address, target: Network): Promise<SafeDeploy> {
  const others = NETWORKS.filter((n) => n !== target && !isTronNetwork(n));
  const found = await Promise.all(others.map((n) => hasCode(n, safe)));
  const sources = others.filter((_, i) => found[i]);
  if (sources.length === 0) throw new SafeReplicateError('not-found');

  for (const source of sources) {
    const c = await creationOn(source, safe).catch(() => null);
    if (!c) continue;
    // The same factory and singleton have to be here, and the call has to land on the same address.
    if (!(await hasCode(target, c.factory)) || !(await hasCode(target, c.singleton))) throw new SafeReplicateError('mismatch');
    const predicted = await predictSafe(target, c.factory, c.singleton, c.initializer, c.saltNonce);
    if (predicted.toLowerCase() !== safe.toLowerCase()) throw new SafeReplicateError('mismatch');
    return {
      source,
      factory: c.factory,
      data: encodeFunctionData({abi: FACTORY_ABI, functionName: 'createProxyWithNonce', args: [c.singleton, c.initializer, c.saltNonce]}),
    };
  }
  throw new SafeReplicateError('unknown-creation');
}

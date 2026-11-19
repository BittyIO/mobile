/**
 * Change a multisig's owners and threshold from the app: add an owner, remove one, or change how
 * many must sign. No Safe{Wallet} needed.
 *
 * Each change is a Safe transaction the Safe makes to itself (`addOwnerWithThreshold`,
 * `removeOwner`, `changeThreshold`), valid once `threshold` owners have signed its EIP-712 `SafeTx`
 * hash. The owners' keys imported on this phone sign it here; once there are enough, one of them
 * sends `execTransaction` and pays the network fee. A change that needs an owner whose key is not on
 * this phone is refused before anything is signed (see {planOwnerChange}).
 */
import {decodeFunctionData, encodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {importedKeys, unlockImported} from '@/wallet/keyring';
import {sendFromOwner} from './direct';
import {addSafeSignature, listSafeMessages, proposeSafeMessage, type SafeMessageStatus} from './safe';

const SAFE_ABI = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function changeThreshold(uint256 _threshold)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
]);
const EXECUTION_SUCCESS = keccak256(toHex('ExecutionSuccess(bytes32,uint256)')).toLowerCase();
/** The head of a Safe's owner list: the "previous owner" of its first owner. */
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;

const SAFE_TX_TYPES = {
  SafeTx: [
    {name: 'to', type: 'address'},
    {name: 'value', type: 'uint256'},
    {name: 'data', type: 'bytes'},
    {name: 'operation', type: 'uint8'},
    {name: 'safeTxGas', type: 'uint256'},
    {name: 'baseGas', type: 'uint256'},
    {name: 'gasPrice', type: 'uint256'},
    {name: 'gasToken', type: 'address'},
    {name: 'refundReceiver', type: 'address'},
    {name: 'nonce', type: 'uint256'},
  ],
} as const;

export type SafeState = {owners: Address[]; threshold: number; nonce: bigint};

export type OwnerChange =
  | {kind: 'add'; owner: Address; threshold: number}
  | {kind: 'remove'; owner: Address; threshold: number}
  | {kind: 'threshold'; threshold: number};

/** The Safe's owners, threshold and nonce, read from the chain now (not the server's cached copy). */
export async function readSafeState(network: Network, safe: Address): Promise<SafeState> {
  const client = publicClientFor(network);
  const [owners, threshold, nonce] = await Promise.all([
    client.readContract({address: safe, abi: SAFE_ABI, functionName: 'getOwners'}),
    client.readContract({address: safe, abi: SAFE_ABI, functionName: 'getThreshold'}),
    client.readContract({address: safe, abi: SAFE_ABI, functionName: 'nonce'}),
  ]);
  return {owners: owners.map((o) => getAddress(o)), threshold: Number(threshold), nonce};
}

/** The owners whose keys are imported on this phone, in the Safe's own order. */
export function ownersOnPhone(owners: Address[]): Address[] {
  const here = new Set(importedKeys().map((a) => a.toLowerCase()));
  return owners.filter((o) => here.has(o.toLowerCase()));
}

/** The call the Safe makes to itself for `change`. */
export function ownerChangeData(state: SafeState, change: OwnerChange): Hex {
  switch (change.kind) {
    case 'add':
      return encodeFunctionData({abi: SAFE_ABI, functionName: 'addOwnerWithThreshold', args: [getAddress(change.owner), BigInt(change.threshold)]});
    case 'remove': {
      // The Safe keeps its owners as a linked list: removing one names the owner before it.
      const i = state.owners.findIndex((o) => o.toLowerCase() === change.owner.toLowerCase());
      if (i < 0) throw new Error('not an owner');
      const prev = i === 0 ? SENTINEL : state.owners[i - 1];
      return encodeFunctionData({abi: SAFE_ABI, functionName: 'removeOwner', args: [prev, state.owners[i], BigInt(change.threshold)]});
    }
    case 'threshold':
      return encodeFunctionData({abi: SAFE_ABI, functionName: 'changeThreshold', args: [BigInt(change.threshold)]});
  }
}

export class OwnerChangeError extends Error {
  constructor(readonly reason: 'not-enough-keys' | 'bad-threshold' | 'already-owner' | 'last-owner', readonly need = 0, readonly have = 0) {
    super(reason);
  }
}

/** Whether `change` is one the Safe accepts and this phone can sign alone. Throws {OwnerChangeError}. */
export function checkOwnerChange(state: SafeState, change: OwnerChange): void {
  const after = change.kind === 'add' ? state.owners.length + 1 : change.kind === 'remove' ? state.owners.length - 1 : state.owners.length;
  if (change.kind === 'add' && state.owners.some((o) => o.toLowerCase() === change.owner.toLowerCase())) throw new OwnerChangeError('already-owner');
  if (change.kind === 'remove' && state.owners.length <= 1) throw new OwnerChangeError('last-owner');
  if (change.threshold < 1 || change.threshold > after) throw new OwnerChangeError('bad-threshold');
  // One owner key here is enough to start a change; the other owners sign theirs where they are.
  const have = ownersOnPhone(state.owners).length;
  if (have < 1) throw new OwnerChangeError('not-enough-keys', 1, have);
}

/** The Safe transaction for `data` at `nonce`: a call the Safe makes to itself, nothing else. */
function safeTxFor(chainId: number, safe: Address, data: Hex, nonce: bigint) {
  return {
    domain: {chainId, verifyingContract: safe},
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx' as const,
    message: {
      to: safe,
      value: BigInt(0),
      data,
      operation: 0,
      safeTxGas: BigInt(0),
      baseGas: BigInt(0),
      gasPrice: BigInt(0),
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce,
    },
  };
}

/** Unlock these imported owner keys, one Face ID each. Null if any prompt was cancelled. */
async function unlockAll(keys: Address[]): Promise<PrivateKeyAccount[] | null> {
  const out: PrivateKeyAccount[] = [];
  for (const a of keys) {
    const acc = await unlockImported(a);
    if (!acc) return null;
    out.push(acc);
  }
  return out;
}

/** `payer` first when it is among `keys`: it signs, and it is the one that sends. */
const payerFirst = (keys: Address[], payer?: Address) =>
  payer ? [...keys.filter((a) => a.toLowerCase() === payer.toLowerCase()), ...keys.filter((a) => a.toLowerCase() !== payer.toLowerCase())] : keys;

/** Send execTransaction for `data` with the combined `signatures`, from `sender`; waits and checks it ran. */
async function execute(network: Network, safe: Address, data: Hex, signatures: Hex, sender: PrivateKeyAccount): Promise<Hex> {
  const client = publicClientFor(network);
  const exec = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [safe, BigInt(0), data, 0, BigInt(0), BigInt(0), BigInt(0), zeroAddress, zeroAddress, signatures],
  });
  const {hash} = await sendFromOwner({account: sender, network, to: safe, data: exec});
  const receipt = await client.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') throw new Error(`Multisig change reverted (${hash})`);
  // A Safe whose inner call fails still mines (and still uses up its nonce): it logs
  // ExecutionFailure instead of ExecutionSuccess.
  const ok = receipt.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0]?.toLowerCase() === EXECUTION_SUCCESS);
  if (!ok) throw new Error(`Multisig change did not run (${hash})`);
  return hash;
}

export type OwnerChangeResult = {kind: 'done'; hash: Hex} | {kind: 'pending'; status: SafeMessageStatus};

/**
 * Make `change`. The owners' keys on this phone sign it (Face ID each, at most `threshold` of them).
 * With enough of them it is executed at once, sent and paid for by `payer` (one of those keys) or
 * else the first; otherwise it is filed for the other owners, who sign it on their own phones from
 * this same page, and it runs once one of them brings it to the threshold. Null if a Face ID prompt
 * was cancelled; throws what the send throws (OwnerGasShort: the payer needs gas).
 */
export async function applyOwnerChange(o: {network: Network; safe: Address; change: OwnerChange; payer?: Address}): Promise<OwnerChangeResult | null> {
  const state = await readSafeState(o.network, o.safe);
  checkOwnerChange(state, o.change);
  const data = ownerChangeData(state, o.change);
  const chainId = await publicClientFor(o.network).getChainId();
  const td = safeTxFor(chainId, o.safe, data, state.nonce);

  const local = payerFirst(ownersOnPhone(state.owners), o.payer).slice(0, state.threshold);
  const accounts = await unlockAll(local);
  if (!accounts) return null;
  const sigs = await Promise.all(accounts.map(async (acc) => ({owner: acc.address, sig: await acc.signTypedData(td)})));

  if (sigs.length >= state.threshold) {
    // The Safe wants its signatures ordered by owner address, ascending.
    const sorted = [...sigs].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
    const signatures = `0x${sorted.map((s) => s.sig.slice(2)).join('')}` as Hex;
    return {kind: 'done', hash: await execute(o.network, o.safe, data, signatures, accounts[0])};
  }
  let status = await proposeSafeMessage(o.network, o.safe, td, sigs[0].sig);
  for (const s of sigs.slice(1)) status = await addSafeSignature(o.network, status.messageHash, s.sig);
  return {kind: 'pending', status};
}

/** A filed Safe transaction, as one of the three changes, read from its own calldata. Null for any other. */
export function describeOwnerChange(status: SafeMessageStatus): OwnerChange | null {
  if (status.primaryType !== 'SafeTx') return null;
  try {
    const d = decodeFunctionData({abi: SAFE_ABI, data: status.typedData.message.data as Hex});
    if (d.functionName === 'addOwnerWithThreshold') return {kind: 'add', owner: getAddress(d.args[0]), threshold: Number(d.args[1])};
    if (d.functionName === 'removeOwner') return {kind: 'remove', owner: getAddress(d.args[1]), threshold: Number(d.args[2])};
    if (d.functionName === 'changeThreshold') return {kind: 'threshold', threshold: Number(d.args[0])};
  } catch {
    // not one of ours
  }
  return null;
}

/** The changes to `safe` filed and waiting for owners, newest first. */
export async function pendingOwnerChanges(network: Network, safe: Address): Promise<SafeMessageStatus[]> {
  return (await listSafeMessages(network, safe)).filter((m) => m.primaryType === 'SafeTx' && describeOwnerChange(m));
}

/**
 * The typed data of a filed change, rebuilt here from its parts — never the server's own hash — and
 * checked to be a call the Safe makes to itself to change its owners (what was shown is what is
 * signed). Throws if the server's id does not match what it hashes to here.
 */
function rebuild(status: SafeMessageStatus) {
  const m = status.typedData.message;
  const td = safeTxFor(Number(status.typedData.domain.chainId), status.safe, m.data as Hex, BigInt(String(m.nonce)));
  if (String(m.to).toLowerCase() !== status.safe.toLowerCase() || String(m.value) !== '0' || String(m.operation) !== '0') throw new Error('Not a change to this multisig');
  if (!describeOwnerChange(status)) throw new Error('Not an owner change');
  if (hashTypedData(td).toLowerCase() !== status.messageHash.toLowerCase()) throw new Error('message-mismatch');
  return td;
}

/**
 * Sign a filed change with the owners' keys on this phone that have not signed it yet (Face ID
 * each), and if that brings it to the threshold, execute it from `payer` (or the first of them).
 */
export async function signOwnerChange(o: {network: Network; status: SafeMessageStatus; payer?: Address}): Promise<OwnerChangeResult | null> {
  const td = rebuild(o.status);
  const state = await readSafeState(o.network, o.status.safe);
  const signed = new Set(o.status.signers.map((a) => a.toLowerCase()));
  const need = Math.max(0, state.threshold - o.status.signers.length);
  const mine = payerFirst(ownersOnPhone(state.owners).filter((a) => !signed.has(a.toLowerCase())), o.payer).slice(0, need);
  let status = o.status;
  if (mine.length) {
    const accounts = await unlockAll(mine);
    if (!accounts) return null;
    for (const acc of accounts) status = await addSafeSignature(o.network, status.messageHash, await acc.signTypedData(td));
  }
  if (!status.ready || !status.signature) return {kind: 'pending', status};
  return executeOwnerChange({network: o.network, status, payer: o.payer});
}

/** Execute a filed change that has all its signatures, sent and paid for by an owner key on this phone. */
export async function executeOwnerChange(o: {network: Network; status: SafeMessageStatus; payer?: Address}): Promise<OwnerChangeResult | null> {
  const td = rebuild(o.status);
  if (!o.status.signature) throw new Error('Not signed by enough owners yet');
  const state = await readSafeState(o.network, o.status.safe);
  const sender = payerFirst(ownersOnPhone(state.owners), o.payer)[0] ?? o.payer;
  if (!sender) throw new OwnerChangeError('not-enough-keys', 1, 0);
  const [acc] = (await unlockAll([sender])) ?? [];
  if (!acc) return null;
  return {kind: 'done', hash: await execute(o.network, o.status.safe, td.message.data, o.status.signature, acc)};
}

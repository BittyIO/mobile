/**
 * What a transaction did, decoded from its calldata on this device — for Tron, where the Bitty
 * server does not index the vault and its history comes from TronGrid's token transfers alone. On
 * the EVM chains the server decodes the same way (web api/ethereum/vaults/txActions) and sends the
 * result with the transfers feed; this is that decoder, so the two name calls alike.
 *
 * Without it a Tron row was only its transfers: the activation and an added payee, which move
 * nothing but the relay fee, both read as a send.
 */
import {decodeFunctionData, parseAbi, toFunctionSelector, type Hex} from 'viem';
import {MMKV} from 'react-native-mmkv';
import {publicClientFor, type Network} from '@/core/chain';
import {vaultFunctionName} from './vault-abi';
import type {VaultAction} from './transactions';

const FORWARDER_REQUEST = '(address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature)';
// A vault's first transaction is the factory activation, which can carry the owner's first
// operations as a batch of vault calls.
const FACTORY_ABI = parseAbi([
  'function activateVault(bool restrictToOwnAllowList, bytes[] calls)',
  'function activateVaultByAsset(address owner, address asset, uint256 amount, bool restrictToOwnAllowList, bytes[] calls, uint256 deadline, bytes signature)',
]);
const FORWARDER_ABI = parseAbi([
  `function executeWithFee(${FORWARDER_REQUEST} request, address stableCoinAddress, uint256 fee)`,
  `function executeBatchWithFee(${FORWARDER_REQUEST}[] requests, address vault, address stableCoinAddress, uint256 fee)`,
  `function execute(${FORWARDER_REQUEST} request)`,
]);

// The vault calls worth naming, with the argument names the history screens read (vault/tx-actions)
// — kept in step with the server's list.
const VAULT_ABI = parseAbi([
  'function multicall(bytes[] data)',
  // Renamed in vault v1.0.4; the old name still decodes earlier transactions.
  'function approveIntentRelayer(address intent, address token)',
  'function approveIntentSpender(address intent, address token)',
  'function cancelIntentOrders(address intent, bytes[] uids)',
  'function cancelIntentOrder(address intent, bytes uid)',
  'function updateProtocols(address[] add, address[] remove)',
  'function updateAssets(address[] add, address[] remove)',
  'function upgradeProtocol(address protocol, address newImplementation)',
  'function setAssetManager(address assetManager, uint64 expiresAt, uint32 permissions)',
  'function setAutoYieldTrigger(address trigger)',
  'function setAutoYielding((address asset, address protocol) route)',
  'function setAutoYieldings((address asset, address protocol)[] routes)',
  // Sweeps take an amount from v1.0.2; the one-argument forms decode earlier transactions.
  'function autoYield(address asset)',
  'function autoYields(address[] assets)',
  'function autoYield(address asset, uint256 amount)',
  'function autoYields(address[] assets, uint256[] amounts)',
  'function setStableCoinAsGas(address[] assets, uint64 dailyLimit, uint64 maxFeePerOp)',
  'function disableStableCoinAsGas()',
  // The same two under the names the vault uses from v1.0.2, when WETH joined the fee coins. Missing,
  // a fee-coin or cap change was stored by selector and shown as a bare 'Transaction'; a row stored
  // that way is re-decoded on its next read (see actionsForTxs).
  'function setTokenAsGas(address[] assets, uint64 dailyLimit, uint64 maxFeePerOp)',
  'function disableTokenAsGas()',
  'function wrapNative()',
  'function marketSell(address ammProtocol, address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmountMin, bytes path)',
  'function marketBuy(address ammProtocol, address sellToken, uint256 sellAmountMax, address buyToken, uint256 buyAmount, bytes reversedPath)',
  'function deposit(address depositProtocol, address assetAddress, uint256 amount)',
  'function withdraw(address withdrawProtocol, address assetAddress, uint256 amount)',
  'function withdraws(address[] protocols, address[] assets, uint256[] amounts)',
  'function claimWithdrawal(address withdrawProtocol, uint256 id)',
  'function claimWithdrawals(address withdrawProtocol, uint256[] ids)',
  'function send(address recipient, address asset, uint256 amount, address[] withdrawProtocols, uint256[] withdrawAmounts)',
  'function batchSend(address recipient, address[] assets, uint256[] amounts, address[][] withdrawProtocols, uint256[][] withdrawAmounts)',
  'function sendAndAddWhitelistedRecipient(address recipient, address asset, uint256 amount, address[] withdrawProtocols, uint256[] withdrawAmounts)',
  'function batchSendAndAddWhitelistedRecipient(address recipient, address[] assets, uint256[] amounts, address[][] withdrawProtocols, uint256[][] withdrawAmounts)',
  'function sendToWhitelistedRecipient(uint256 id, address asset, uint256 amount, address[] withdrawProtocols, uint256[] withdrawAmounts)',
  'function addWhitelistedRecipient(address recipient)',
  'function removeWhitelistedRecipients(uint256[] ids)',
  'function payRelayerFee(address asset, uint256 amount)',
  'function upgrade(address newImpl)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
  'function settleOwnershipTransfer()',
  'function cancelOwnershipTransfer()',
  'function renounceOwnership()',
  'function useBittyAllowList(bool use)',
  'function updateRisk((uint256 timelock, uint256 sendDailyAllowance, uint256 marketTradeDailyLossAllowance) riskSettings)',
  'function emergencyLock()',
  'function unlock()',
  'function foreverLock(uint256 escapeRecipientId)',
  // Before 1.0.9 an NFT could go to any address; from 1.0.9 only to a payable whitelisted recipient,
  // named by its id. Both stay, so history from older vaults still decodes.
  'function retrieve721(address contractAddress, uint256 tokenId, address to)',
  'function retrieve721(address contractAddress, uint256 tokenId, uint256 recipientId)',
]);

const HEX_ARG = /^0x[0-9a-fA-F]*$/;

function flatten(v: unknown): string | string[] {
  if (Array.isArray(v)) return v.map((x) => String(flatten(x)));
  if (typeof v === 'object' && v !== null) return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  const s = String(v);
  return HEX_ARG.test(s) && s.length === 42 ? s.toLowerCase() : s;
}

// By selector, not name: overloads (autoYield, retrieve721) each keep their own argument names.
const ARG_NAMES = new Map<string, readonly string[]>(
  VAULT_ABI.filter((f) => f.type === 'function').map((f) => [toFunctionSelector(f), f.inputs.map((i, n) => i.name || `arg${n}`)]),
);

function decodeVaultCall(data: Hex, depth = 0): VaultAction[] {
  if (depth > 3 || data.length < 10) return [];
  try {
    const {functionName, args} = decodeFunctionData({abi: VAULT_ABI, data});
    if (functionName === 'multicall') return (args[0] as readonly Hex[]).flatMap((d) => decodeVaultCall(d, depth + 1));
    const names = ARG_NAMES.get(data.slice(0, 10).toLowerCase()) ?? [];
    const out: Record<string, string | string[]> = {};
    ((args ?? []) as readonly unknown[]).forEach((a, i) => {
      out[names[i] ?? `arg${i}`] = flatten(a);
    });
    return [{name: functionName, args: out}];
  } catch {
    // A vault call this list does not name: the vault's own ABI may still know what it is called.
    return [{name: vaultFunctionName(data) ?? data.slice(0, 10).toLowerCase(), args: {}}];
  }
}

/**
 * The vault calls a transaction's calldata made on `vault`: a relayed request addressed to it, the
 * factory activating it (with the operations that rode on the activation), or the vault called
 * directly. Empty when it made none.
 */
export function decodeVaultActions(input: Hex, to: string | null, vault: string): VaultAction[] {
  const v = vault.toLowerCase();
  try {
    const {functionName, args} = decodeFunctionData({abi: FORWARDER_ABI, data: input});
    const requests = (functionName === 'executeBatchWithFee' ? args[0] : [args[0]]) as readonly {to: string; data: Hex}[];
    return requests.filter((r) => r.to.toLowerCase() === v).flatMap((r) => decodeVaultCall(r.data));
  } catch {
    // Not relayed.
  }
  try {
    const {functionName, args} = decodeFunctionData({abi: FACTORY_ABI, data: input});
    const calls = (functionName === 'activateVault' ? args[1] : args[4]) as readonly Hex[];
    return [{name: 'activateVault', args: {}}, ...calls.flatMap((d) => decodeVaultCall(d, 1))];
  } catch {
    // Not an activation.
  }
  return to?.toLowerCase() === v ? decodeVaultCall(input) : [];
}

// A mined transaction's calldata never changes, so what it decodes to is kept for good.
const store = new MMKV({id: 'bitty.tx-actions'});

/** The vault calls in each of these transactions, read from the chain (each once, then kept). */
export async function vaultActionsFor(hashes: string[], vault: string, network: Network): Promise<Map<string, VaultAction[]>> {
  const out = new Map<string, VaultAction[]>();
  const client = publicClientFor(network);
  const todo: string[] = [];
  for (const h of hashes) {
    const kept = store.getString(`${network}:${vault.toLowerCase()}:${h.toLowerCase()}`);
    if (kept) out.set(h, JSON.parse(kept) as VaultAction[]);
    else todo.push(h);
  }
  // A few at a time: a public node turns a burst of fifty into rate-limit errors.
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(
      todo.slice(i, i + 5).map(async (h) => {
        const tx = await client.getTransaction({hash: h as Hex}).catch(() => null);
        if (!tx) return;
        const actions = decodeVaultActions(tx.input, tx.to ?? null, vault);
        out.set(h, actions);
        store.set(`${network}:${vault.toLowerCase()}:${h.toLowerCase()}`, JSON.stringify(actions));
      }),
    );
  }
  return out;
}

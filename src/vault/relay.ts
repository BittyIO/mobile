/**
 * Gasless meta-transaction: build an EIP-712 ForwardRequest, sign it with the on-device embedded keyring
 * (Face ID), and hand it to the relayer. Ported from web `relayWrite`.
 *
 * The owner only ever signs — the relayer executes and the fee is paid from the vault in a stable coin —
 * so this whole flow is one biometric approval + one HTTP POST, no gas. `account.signTypedData` runs
 * locally on the device key (see wallet/store `signer()`).
 *
 * Failure surfaces as a thrown error the UI shows — a declined signature or relay means the op can't
 * proceed and the user is told why.
 */
import {encodeFunctionData, type Abi, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiUrl, CHAIN_ID, publicClientFor, type Network} from '@/core/chain';
import {FORWARDER_ABI, FORWARD_REQUEST_TYPES, VAULT_FWD_ABI, VAULT_MULTICALL_ABI} from '@/core/abi';
import {isActivated, activateVault} from './activate';

/** One vault call, unencoded — used to compose a multicall. */
export type VaultCall = {abi: Abi; functionName: string; args?: readonly unknown[]};

const encodeCall = (c: VaultCall): Hex =>
  encodeFunctionData({abi: c.abi, functionName: c.functionName, args: c.args} as Parameters<typeof encodeFunctionData>[0]);

// Generous inner gas — the forwarder passes this to the inner call; an under-estimate reverts the relay.
const INNER_GAS = BigInt(1_000_000);
// Signed and submitted seconds apart — only has to survive the round trip.
const DEADLINE_SECONDS = 600;

export type RelayResult = {hash: Hex};

const isZeroAddr = (a?: string) => !a || /^0x0*$/i.test(a);

/**
 * Read the vault's trustedForwarder, tolerating a just-deployed vault whose code isn't yet visible on
 * the RPC node we hit (public RPCs are load-balanced, so a read right after activation can land on a
 * lagging node and come back "0x"/"no data"). Retries briefly before giving up.
 */
async function readForwarder(
  client: ReturnType<typeof publicClientFor>,
  vault: Address,
): Promise<Address> {
  for (let i = 0; i < 6; i++) {
    try {
      const fwd = (await client.readContract({
        address: vault,
        abi: VAULT_FWD_ABI,
        functionName: 'trustedForwarder',
      })) as Address;
      if (!isZeroAddr(fwd)) return fwd;
    } catch {
      // "returned no data (0x)" — the vault's code isn't visible on this node yet; retry.
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Vault not ready yet — it may still be deploying. Try again in a moment.');
}

/**
 * Relay a single pre-encoded vault call. On a not-yet-activated vault the op rides on activation as its
 * `activationCalls` batch (deploy + init + op in one signed call); otherwise it's a signed ForwardRequest
 * to the relayer. Shared by {@link relayVaultWrite} and {@link relayVaultMulticall}.
 */
async function relayEncoded(opts: {
  account: Signer;
  vault: Address;
  network: Network;
  data: Hex; // what the forwarder calls on the vault
  activationCalls: readonly Hex[]; // what runs during init if the vault isn't activated yet
  stableCoin: Address;
}): Promise<RelayResult> {
  const {account, vault, network} = opts;
  const client = publicClientFor(network);

  // Activate-and-call: a relayed write needs the vault's trustedForwarder, which only exists once the
  // vault is deployed. If this is the owner's FIRST on-chain action, the op(s) ride on activation as the
  // `calls` batch, so deploy + init + the op all happen in one signed, gasless call. The relayer pays the
  // activation fee FROM the vault's own stable coin, so the vault must already hold some.
  if (!(await isActivated(vault, network))) {
    let activationHash: Hex;
    try {
      ({hash: activationHash} = await activateVault({
        account,
        network,
        stableCoin: opts.stableCoin,
        allowlistEnabled: false, // unrestricted by default; the owner can narrow later in Manage.
        calls: opts.activationCalls, // the requested operation(s), executed during the vault's init
      }));
    } catch (e) {
      const detail = (e as Error)?.message ?? String(e);
      throw new Error(
        'Your vault needs to be activated first; the network fee is paid from the stablecoin in the vault. ' +
          'Send some USDC to your vault address (Overview → Receive), then try again.\n\n(' +
          detail +
          ')',
      );
    }
    await client.waitForTransactionReceipt({hash: activationHash});
    return {hash: activationHash}; // the operation ran as part of activation — nothing else to relay
  }

  const forwarder = await readForwarder(client, vault);

  const nonce = (await client.readContract({
    address: forwarder,
    abi: FORWARDER_ABI,
    functionName: 'nonceFor',
    args: [account.address, vault],
  })) as bigint;

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const signature = await account.signTypedData({
    domain: {
      name: 'BittyV1VaultForwarder',
      version: '1',
      chainId: CHAIN_ID[network],
      verifyingContract: forwarder,
    },
    types: FORWARD_REQUEST_TYPES,
    primaryType: 'ForwardRequest',
    message: {
      from: account.address,
      to: vault,
      value: BigInt(0),
      gas: INNER_GAS,
      nonce,
      deadline,
      data: opts.data,
    },
  });

  const res = await fetch(apiUrl('/api/ethereum/vaults/relay', network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      request: {
        from: account.address,
        to: vault,
        value: '0',
        gas: INNER_GAS.toString(),
        deadline,
        data: opts.data,
        signature,
      },
      stableCoinAddress: opts.stableCoin,
    }),
  });

  const json = (await res.json().catch(() => null)) as
    | {ok?: boolean; hash?: Hex; fallback?: boolean; reason?: string; error?: string}
    | null;

  if (json?.ok && json.hash) return {hash: json.hash};
  throw new Error(relayError(json, res.status));
}

/**
 * The relayer's machine-readable reason, turned into something a person can act on.
 *
 * These reached the user verbatim, so a trade that emptied its own fee coin reported
 * "fee-leg-failed" and looked like a bug in the swap. Each of these says what the vault has to
 * change, because none of them is retryable as-is.
 */
function relayError(json: {reason?: string; error?: string} | null, status: number): string {
  switch (json?.reason) {
    case 'fee-leg-failed':
      // The operation itself simulates fine; only the charge that follows it does not.
      return 'The operation would leave no stable coin in the vault to pay the network fee. Lower the amount or keep a small balance aside.';
    case 'insufficient-liquid-balance':
      return 'No stable coin in the vault can cover the network fee. Withdraw some from a yield or lending position first.';
    case 'budget-exhausted':
      return "The vault's daily network-fee budget is used up. It resets 24 hours after the first charge.";
    case 'gasless-off':
      return 'Relaying is turned off for this vault. Turn a fee coin back on in Settings.';
    case 'simulation-failed':
      // The call itself reverts, so retrying it unchanged cannot work. Nothing was signed or sent.
      return 'The vault refused this operation, so nothing was sent. Check that the assets are on the allow list and that trading is not paused.';
    default:
      return json?.reason ?? json?.error ?? `Relay failed (${status})`;
  }
}

export async function relayVaultWrite(opts: {
  account: Signer;
  vault: Address;
  network: Network;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** The stable coin the relayer should charge its fee in (a hint — it will try others if needed). */
  stableCoin: Address;
}): Promise<RelayResult> {
  const data = encodeCall({abi: opts.abi, functionName: opts.functionName, args: opts.args});
  return relayEncoded({
    account: opts.account,
    vault: opts.vault,
    network: opts.network,
    data,
    activationCalls: [data],
    stableCoin: opts.stableCoin,
  });
}

/**
 * Relay several vault calls as ONE transaction (one signature, one relay) via vault.multicall — e.g. a
 * one-time adapter registration bundled with the operation that needs it, so nothing waits mid-way. On a
 * not-yet-activated vault the calls run individually during init (no nested multicall needed).
 */
export async function relayVaultMulticall(opts: {
  account: Signer;
  vault: Address;
  network: Network;
  calls: VaultCall[];
  stableCoin: Address;
}): Promise<RelayResult> {
  const datas = opts.calls.map(encodeCall);
  const data = encodeCall({abi: VAULT_MULTICALL_ABI, functionName: 'multicall', args: [datas]});
  return relayEncoded({
    account: opts.account,
    vault: opts.vault,
    network: opts.network,
    data,
    activationCalls: datas,
    stableCoin: opts.stableCoin,
  });
}

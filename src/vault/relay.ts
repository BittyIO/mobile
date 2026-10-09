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
import {encodeFunctionData, type Abi, type Address, type Hex, type PublicClient} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiUrl, CHAIN_ID, publicClientFor, type Network} from '@/core/chain';
import {FORWARDER_ABI, FORWARD_REQUEST_TYPES, VAULT_FWD_ABI, VAULT_MULTICALL_ABI} from '@/core/abi';
import {isActivated, activateVault} from './activate';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';

/** One vault call, unencoded — used to compose a multicall. */
export type VaultCall = {abi: Abi; functionName: string; args?: readonly unknown[]};

const encodeCall = (c: VaultCall): Hex =>
  encodeFunctionData({abi: c.abi, functionName: c.functionName, args: c.args} as Parameters<typeof encodeFunctionData>[0]);

/**
 * The floor for the inner call's gas, and the ceiling on what will be asked for.
 *
 * The forwarder hands `request.gas` to the inner call and the signature covers it, so it cannot be
 * raised after the fact: too little and the call runs out of gas, `_execute` returns false, and the
 * whole relay reverts with `FailedInnerCall`.
 *
 * It used to be this floor and nothing else — one flat million for every operation. That is ample
 * for a trade on a vault that has traded before and NOT ample for the first one, because the first
 * operation through any adapter deploys the vault's clone of it: measured on a fresh Sepolia vault,
 * registering the CoW adapter is 1,080,030 gas and the register-plus-approve multicall a limit
 * order actually sends is 1,212,920. The same multicall on a vault whose clone exists is 112,726.
 * So every vault's first limit order and first market trade reverted, both of them, for ever, while
 * an identically configured vault that had got through it once worked perfectly — which is as
 * confusing a failure as this codebase has produced.
 *
 * The ceiling is a sanity bound, not a budget: unused gas is not charged (the fee is priced from
 * post-refund gas — see `billedGas` in the relayer), so asking for more costs the user nothing and
 * only has to stay under the block limit.
 */
const INNER_GAS_MIN = BigInt(1_000_000);
const INNER_GAS_MAX = BigInt(8_000_000);

/**
 * What to ask for: the measured cost of this exact call plus a third, floored and capped.
 *
 * Estimated as a DIRECT call from the owner, which is what the vault sees anyway — the forwarder
 * appends the owner as the ERC-2771 sender, so the code path and its storage writes are the same.
 * The margin covers that suffix, the forwarder's own `req.gas / 63` griefing reserve, and any state
 * that moves between signing and inclusion.
 *
 * Falls back to the floor when the estimate fails. An estimate that cannot run usually means the
 * call itself reverts, and the relayer will say so in terms the user can act on; guessing low here
 * would turn that into the gas failure this whole constant exists to avoid.
 */
async function innerGasFor(client: PublicClient, from: Address, vault: Address, data: Hex): Promise<bigint> {
  try {
    const used = await client.estimateGas({account: from, to: vault, data});
    const want = (used * BigInt(4)) / BigInt(3);
    return want < INNER_GAS_MIN ? INNER_GAS_MIN : want > INNER_GAS_MAX ? INNER_GAS_MAX : want;
  } catch {
    return INNER_GAS_MIN;
  }
}
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
  const innerGas = await innerGasFor(client, account.address, vault, opts.data);

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
      gas: innerGas,
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
        gas: innerGas.toString(),
        deadline,
        data: opts.data,
        signature,
      },
      stableCoinAddress: opts.stableCoin,
    }),
  });

  const json = (await res.json().catch(() => null)) as
    | {ok?: boolean; hash?: Hex; fallback?: boolean; reason?: string; error?: string; code?: string}
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
function relayError(json: {reason?: string; error?: string; code?: string} | null, status: number): string {
  // Read, not subscribed: this is not a component, and the language cannot change mid-throw.
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(useLanguage.getState().language, key, params);
  switch (json?.reason) {
    /**
     * The operation simulates fine and only the charge that follows it does not.
     *
     * This used to say the vault would be left with no stablecoin to pay with, and told the user
     * to lower the amount. That was a GUESS at the cause dressed as a fact, and the wrong one: the
     * relayer has already checked the balance covers the fee before it gets here, so a vault with
     * twenty dollars and a two dollar order hit this and was told to spend less. What is actually
     * known is that the charge could not settle and nothing was sent — so that is what it says,
     * and the revert reason goes with it rather than being swallowed.
     */
    case 'fee-leg-failed':
      return withCode(t('mobile.actions.relay_fee_leg'), json.reason, json.code);
    case 'insufficient-liquid-balance':
      return withCode(t('mobile.actions.relay_no_liquid'), json.reason, json.code);
    case 'budget-exhausted':
      return withCode(t('mobile.actions.relay_budget'), json.reason, json.code);
    case 'gasless-off':
      return withCode(t('mobile.actions.relay_gasless_off'), json.reason, json.code);
    case 'simulation-failed':
      // The call itself reverts, so retrying it unchanged cannot work. Nothing was signed or sent.
      return withCode(t('mobile.actions.relay_refused'), json.reason, json.code);
    default:
      return json?.reason
        ? t('mobile.actions.relay_failed', {reason: json.reason})
        : json?.error ?? `Relay failed (${status})`;
  }
}

/**
 * Which refusal it was, and the contract's own objection, after the sentence.
 *
 * A refusal nobody can act on is worth nothing without them: "the charge could not settle" names a
 * symptom, the reason slug names the branch that produced it, and the revert names the cause. The
 * slug is here because the five mapped sentences are not distinguishable once translated — two of
 * them read almost the same in a hurry — and the first question about any of these is always which
 * one actually fired.
 *
 * `code` is the decoded revert and never `detail`, which is viem's error string and carries the
 * indexer RPC URL and its API key.
 */
function withCode(message: string, reason?: string, code?: string): string {
  const tail = [reason, code].filter(Boolean).join(' · ');
  return tail ? `${message}\n\n${tail.slice(0, 140)}` : message;
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

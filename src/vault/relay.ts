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
import {Alert} from 'react-native';
import {decodeFunctionData, encodeFunctionData, type Abi, type Address, type Hex, type PublicClient} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiUrl, CHAIN_ID, publicClientFor, type Network} from '@/core/chain';
import {FORWARDER_ABI, FORWARD_REQUEST_TYPES, VAULT_FWD_ABI, VAULT_MULTICALL_ABI, VAULT_OWNERSHIP_ABI, VAULT_RISK_ABI} from '@/core/abi';
import {rotationOn} from '@/wallet/rotation-store';
import {ActivationCallReverted, ActivationFeeTooHigh, ConnectionLost, RelayerUnfunded, isActivated, activateVault, activateVaultDirect, revertData} from './activate';
import {displayAddress} from '@/core/address';
import {formatNative, OwnerGasShort, ownerEthBalance, sendFromOwner} from './direct';
import {feePayerFor, type FeePayer} from '@/core/fee-payer-store';
import {feeCoinOrder} from '@/core/prefs';
import {knownAssets} from '@/core/assets';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';
import {SafeSignaturePending} from './safe';
import {assertCanWrite, nameRevert} from './vault-abi';
import {lendingPoolRevert} from './lending-reserve';
import {assertVaultAccepts} from './presend';
import {upgradeSent, withAutoUpgrades} from './auto-upgrade';
import {REVERT_REASON} from './capabilities';
import {fetchAttempts} from './attempts';

/** One vault call, unencoded — used to compose a multicall. */
export type VaultCall = {abi: Abi; functionName: string; args?: readonly unknown[]};

const encodeCall = (c: VaultCall): Hex =>
  encodeFunctionData({abi: c.abi, functionName: c.functionName, args: c.args} as Parameters<typeof encodeFunctionData>[0]);

/** What the forwarder will call on the vault for these calls: the one call, or a multicall of them. */
export function encodeVaultCalls(calls: VaultCall[]): Hex {
  return calls.length === 1
    ? encodeCall(calls[0])
    : encodeCall({abi: VAULT_MULTICALL_ABI, functionName: 'multicall', args: [calls.map(encodeCall)]});
}

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
// Signed and submitted seconds apart — only has to survive the round trip. A signer whose signature
// takes longer to collect (a multi-owner Safe) says how long, and gets that instead.
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
/**
 * The fee coin to ask the relayer for: the one the owner put first on the Network fee page, or the
 * caller's own. Only a preference — the server tries it first and falls back to the vault's other
 * fee coins — so a coin this vault cannot pay in (WETH on an older build) costs nothing.
 */
function feeHint(network: Network, vault: Address, fallback: Address): Address {
  const first = feeCoinOrder(network, vault)[0]?.toUpperCase();
  const asset = first ? knownAssets(network).find((a) => a.symbol.toUpperCase() === first) : undefined;
  return (asset?.address as Address | undefined) ?? fallback;
}

type EncodedWrite = {
  account: Signer;
  vault: Address;
  network: Network;
  data: Hex; // what the forwarder calls on the vault
  activationCalls: readonly Hex[]; // what runs during init if the vault isn't activated yet
  stableCoin: Address;
  /** Who pays the network fee for THIS write, over the vault's setting: a fallback the user accepted. */
  payer?: FeePayer;
  /** Bill `stableCoin` as given, not the owner's first fee coin: see {relayVaultWrite}'s `pinFee`. */
  pinFee?: boolean;
  /** Do not hand the vault to a fresh key with this write: see {relayVaultWrite}'s `noRotate`. */
  noRotate?: boolean;
  /** Adapters this write serves without naming them: see {relayVaultWrite}'s `uses`. */
  uses?: readonly Address[];
};

/**
 * The vault refused to pay the relayer — no fee coin it can charge, its budget spent, relaying off.
 * Nothing was sent. The one class of relay failure the owner's own ETH can get past.
 */
export class VaultFeeRefused extends Error {}

/** The vault cannot pay because gas is over its per-operation cap (see activate's {ActivationFeeTooHigh}). */
class GasTooHigh extends VaultFeeRefused {}

/** Only a key can send its own transactions; a Safe's vault always pays through the relayer. */
const ownerCanPay = (account: Signer) => !!account.signTransaction && !account.isContract;

/**
 * Ask whether to pay this one write the other way, now that the chosen way cannot. Never switched
 * without asking: the two ways spend from two different places, and the setting stays as it is.
 */
function offerOtherPayer(title: string, message: string, accept: string): Promise<boolean> {
  const t = (key: string) => translate(useLanguage.getState().language, key);
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      {text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false)},
      {text: accept, onPress: () => resolve(true)},
    ], {cancelable: true, onDismiss: () => resolve(false)}),
  );
}

/**
 * Writes to one vault from one key, one at a time.
 *
 * The forwarder takes a single nonce sequence per (signer, vault) and a request is signed for the
 * nonce it read — so two operations started together (a deposit while a trade is still mining) both
 * signed the SAME nonce, and only one of them could ever land; the other failed at the relayer or on
 * chain. The owner-paid path has the same problem with the owner's own account nonce.
 *
 * So a write waits for the one before it to be MINED before it reads a nonce and signs. The caller
 * still gets its hash as soon as its own write is submitted; it is the next write that waits. A
 * receipt that never comes frees the queue after {SETTLE_TIMEOUT_MS}, so one stuck transaction
 * cannot block the vault for good.
 */
const writeQueue = new Map<string, Promise<void>>();
const SETTLE_TIMEOUT_MS = 120_000;

async function relayEncoded(opts: EncodedWrite): Promise<RelayResult> {
  const key = `${opts.network}:${opts.account.address.toLowerCase()}:${opts.vault.toLowerCase()}`;
  const before = writeQueue.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const turn = before.then(() => done);
  writeQueue.set(key, turn);
  void turn.then(() => {
    if (writeQueue.get(key) === turn) writeQueue.delete(key);
  });
  await before;
  try {
    const res = await relayEncodedNow(opts);
    publicClientFor(opts.network)
      .waitForTransactionReceipt({hash: res.hash, timeout: SETTLE_TIMEOUT_MS})
      .catch(() => {})
      .finally(release);
    return res;
  } catch (e) {
    release();
    throw e;
  }
}

/**
 * One vault write, paid the way the vault is set to pay — or, if that way cannot, the other way,
 * when the user says so. See core/fee-payer-store. Called through {relayEncoded}'s queue.
 */
async function relayEncodedNow(given: EncodedWrite): Promise<RelayResult> {
  const t = (key: string) => translate(useLanguage.getState().language, key);
  const {account, network, vault} = given;
  // Every vault write passes here, so this is where a vault on a release newer than this build is
  // stopped — before a signature is asked for.
  await assertCanWrite(vault, network);
  // A lock made since the screen last looked: say so before anything is signed or paid for.
  const lockLevel = await assertVaultAccepts(vault, network, given.activationCalls);
  // The vault's and its protocols' upgrades ride in front, when Auto upgrade is on. Once: a retry
  // with the other payer passes here again with them already in, and finds the batch an upgrade.
  const auto = await withAutoUpgrades({vault, network, from: account.address, data: given.data, lockLevel, uses: given.uses});
  if (auto.upgraded) {
    given = {...given, data: auto.data};
    upgradeSent(vault, network);
  }
  const opts = await withHandover(given);
  if (lockLevel === 2 && ownerCanPay(account)) return viaOwnerLockedForever(opts);
  /**
   * On quantum-safe keys the vault always pays. The key that signs is a one-time key with no ETH
   * of its own, and ETH sent to it would be left behind at an address the vault has moved on from.
   */
  const rotating = rotationOn(network, vault);
  const payer = opts.payer ?? (ownerCanPay(account) && !rotating ? feePayerFor(network, vault) : 'vault');
  const asked = opts.payer !== undefined;

  if (payer === 'owner') {
    try {
      return await viaOwner(opts);
    } catch (e) {
      if (!asked && e instanceof OwnerGasShort && (await offerOtherPayer(t('mobile.fees.fallback_vault_title'), e.message, t('mobile.fees.fallback_vault_button')))) {
        return relayEncodedNow({...opts, payer: 'vault'});
      }
      throw e;
    }
  }
  try {
    return await viaRelayer(opts);
  } catch (e) {
    if (
      !asked &&
      !rotating &&
      e instanceof VaultFeeRefused &&
      ownerCanPay(account) &&
      (await ownerEthBalance(network, account.address).catch(() => BigInt(0))) > BigInt(0) &&
      (await offerOtherPayer(t('mobile.fees.fallback_owner_title'), e.message, t('mobile.fees.fallback_owner_button')))
    ) {
      return relayEncodedNow({...opts, payer: 'owner'});
    }
    // Activation over the cap, and no ETH to offer instead: say where it could come from.
    if (e instanceof GasTooHigh && ownerCanPay(account) && !rotating) {
      throw new Error(`${e.message}\n\n${t('mobile.fees.gas_high_fund_owner')}`);
    }
    throw e;
  }
}

/**
 * A vault locked forever refuses to pay the relayer (payRelayerFee), so every write from then on is
 * paid from the owner key's own ETH — whatever the fee setting says, and on quantum-safe keys too:
 * the lock refuses the handover to a fresh key as well, so the key that signs now stays the owner
 * and ETH sent to it is not left behind. Asking which way to pay would offer a way that cannot work,
 * so the one that can is taken, and a key with too little ETH is told exactly where to send it.
 */
async function viaOwnerLockedForever(opts: EncodedWrite): Promise<RelayResult> {
  try {
    return await viaOwner(opts);
  } catch (e) {
    if (!(e instanceof OwnerGasShort)) throw e;
    throw new Error(
      translate(useLanguage.getState().language, 'mobile.vault.forever_owner_pays', {
        need: formatNative(opts.network, e.need),
        owner: displayAddress(opts.network, e.owner),
      }),
    );
  }
}

/**
 * The write with the vault's handover to a fresh key appended, when the signer planned one (see
 * wallet/rotation): one transaction, so the key that signs it is no longer the one the vault is
 * waiting on by the time anyone can read its signature.
 *
 * A write that is already a multicall gets the handover as its last call; any other becomes a
 * multicall of the two. Tried on the chain first, and left off when the pair would revert where the
 * write alone would not — the operation is what the user asked for, and the handover can ride on
 * the next one. When the write fails on its own as well, it goes as it is, so its own error is the
 * one the user sees.
 */
async function withHandover(opts: EncodedWrite): Promise<EncodedWrite> {
  const to = !opts.noRotate && opts.account.rotation && 'to' in opts.account.rotation ? opts.account.rotation.to : undefined;
  if (!to) return opts;
  const client = publicClientFor(opts.network);
  // Asked again here, after the write queue: a write started alongside this one may have queued a
  // handover since the signer looked, and queueing a second would start the wait over.
  const waiting = await client
    .readContract({address: opts.vault, abi: VAULT_RISK_ABI, functionName: 'pendingChanges'})
    .then((p) => p.newOwnerReadyAt > 0n)
    .catch(() => false);
  if (waiting) return {...opts, noRotate: true};
  const handover = encodeCall({abi: VAULT_OWNERSHIP_ABI, functionName: 'transferOwnership', args: [to]});
  let calls: readonly Hex[] = [opts.data];
  try {
    const d = decodeFunctionData({abi: VAULT_MULTICALL_ABI, data: opts.data});
    if (d.functionName === 'multicall') calls = d.args[0];
  } catch {
    // Not a multicall: the write is one call.
  }
  const data = encodeCall({abi: VAULT_MULTICALL_ABI, functionName: 'multicall', args: [[...calls, handover]]});
  const ok = await client
    .estimateGas({account: opts.account.address, to: opts.vault, data})
    .then(() => true, () => false);
  return ok ? {...opts, data, noRotate: true} : {...opts, noRotate: true};
}

/**
 * The owner pays: the same calldata, sent straight to the vault from the owner key. On a vault not
 * activated yet the operation rides on the factory's plain `activateVault`, as it rides on the
 * signed activation through the relayer.
 */
async function viaOwner(opts: EncodedWrite): Promise<RelayResult> {
  const {account, vault, network} = opts;
  if (!(await isActivated(vault, network))) {
    const {hash} = await activateVaultDirect({account, network, allowlistEnabled: false, calls: opts.activationCalls});
    await publicClientFor(network).waitForTransactionReceipt({hash});
    return {hash};
  }
  return sendFromOwner({account, network, to: vault, data: opts.data});
}

async function viaRelayer(opts: EncodedWrite): Promise<RelayResult> {
  const {account, vault, network} = opts;
  const client = publicClientFor(network);

  // Activate-and-call: a relayed write needs the vault's trustedForwarder, which only exists once the
  // vault is deployed. If this is the owner's FIRST on-chain action, the op(s) ride on activation as the
  // `calls` batch, so deploy + init + the op all happen in one signed, gasless call. The relayer takes
  // the activation fee FROM the vault — its stable coin, or its ETH from v1.0.3 — so it must hold some.
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
      // Not a failure: the activation is waiting for the Safe's co-owners, and finishes from there.
      if (e instanceof SafeSignaturePending) throw e;
      // The answer was lost, not refused: it may have activated, so no "fund your vault" advice.
      if (e instanceof ConnectionLost) throw e;
      // The operation itself fails: paying another way or funding the vault would not change that.
      if (e instanceof ActivationCallReverted) throw e;
      // Gas is over what a vault may pay: funding it would not help, the owner's ETH would.
      if (e instanceof ActivationFeeTooHigh) throw new GasTooHigh(e.message);
      // Our relayer is out of gas money: the owner's own ETH still works, so it is offered.
      if (e instanceof RelayerUnfunded) throw new VaultFeeRefused(e.message);
      const detail = (e as Error)?.message ?? String(e);
      throw new VaultFeeRefused(
        'Your vault needs to be activated first; the network fee is paid from a stablecoin (USDT, USDC…) or ETH in the vault. ' +
          'Send some to your vault address (Overview → Receive), then try again.\n\n(' +
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

  const deadline = Math.floor(Date.now() / 1000) + (account.approvalWindowSeconds ?? DEADLINE_SECONDS);
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

  return submitForwardRequest({
    network,
    request: {from: account.address, to: vault, value: '0', gas: innerGas.toString(), deadline, data: opts.data, signature},
    stableCoin: opts.stableCoin,
    pinFee: opts.pinFee,
  });
}

/**
 * Hand a signed ForwardRequest to the relayer. Split from {relayEncoded} so a request whose
 * signature was collected later — a multi-owner Safe's (see ./safe-finish) — is submitted the same
 * way, with the same fee coin preference and the same refusal messages.
 */
export async function submitForwardRequest(o: {
  network: Network;
  request: {from: Address; to: Address; value: string; gas: string; deadline: number; data: Hex; signature: Hex};
  stableCoin: Address;
  pinFee?: boolean;
}): Promise<RelayResult> {
  const sentAt = Math.floor(Date.now() / 1000);
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/ethereum/vaults/relay', o.network), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        request: o.request,
        stableCoinAddress: o.pinFee ? o.stableCoin : feeHint(o.network, o.request.to, o.stableCoin),
      }),
    });
  } catch {
    // The connection dropped — "Network request failed". The relayer may well have sent it anyway.
    return recoverLostRelay(o.network, o.request, sentAt);
  }

  const json = (await res.json().catch(() => null)) as
    | {ok?: boolean; hash?: Hex; fallback?: boolean; reason?: string; error?: string; code?: string}
    | null;

  if (json?.ok && json.hash) return {hash: json.hash};
  // A 200 whose body never arrived whole: the same lost answer as a dropped connection.
  if (res.ok && !json) return recoverLostRelay(o.network, o.request, sentAt);
  if (json?.reason === 'simulation-failed') json.code = (await innerRevert(o.network, o.request)) ?? json.code;
  const message = relayError(json, res.status);
  throw FEE_REFUSALS.has(json?.reason ?? '') ? new VaultFeeRefused(message) : new Error(message);
}

/**
 * The relayer's answer was lost on the way back, but the request may have been sent.
 *
 * Mobile networks drop a POST mid-flight — a cell handover, the app backgrounded for a moment —
 * and fetch then rejects with a bare, untranslated "Network request failed" even though the
 * relayer has already submitted the transaction. Reporting that as a failure invites the user to
 * try again and do it twice. So ask the relayer's own record of attempts (written before it
 * answers) for a transaction sent since, and accept one only if it carries THIS request's
 * signature, which nothing else can. Only when none shows up within ~30 s is it reported, in the
 * user's language, as unknown rather than failed.
 */
async function recoverLostRelay(
  network: Network,
  request: {to: Address; signature: Hex},
  sentAt: number,
): Promise<RelayResult> {
  const client = publicClientFor(network);
  const sig = request.signature.slice(2).toLowerCase();
  const checked = new Set<string>();
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 3000));
    const attempts = await fetchAttempts(request.to, network);
    for (const a of attempts) {
      // Generous on time — the server's clock is not the phone's; the signature is the real test.
      if (!a.txHash || a.at < sentAt - 300 || checked.has(a.txHash)) continue;
      checked.add(a.txHash);
      const tx = await client.getTransaction({hash: a.txHash as Hex}).catch(() => null);
      if (!tx) {
        checked.delete(a.txHash); // not visible to our node yet: look again next round
        continue;
      }
      if (tx.input.toLowerCase().includes(sig)) return {hash: a.txHash as Hex};
    }
  }
  throw new ConnectionLost();
}

/**
 * Why the vault itself refused, asked of the chain from the owner.
 *
 * The forwarder reverts `FailedInnerCall` for whatever the vault objected to, so the relayer's
 * `code` named the forwarder and never the vault: a sale the vault stopped for its price
 * (MarketTradePriceTooLow) read as the generic "the vault refused this operation". The same call
 * from the owner reverts with the vault's own error. Undefined when it does not revert here.
 */
async function innerRevert(network: Network, request: {from: Address; to: Address; data: Hex}): Promise<string | undefined> {
  try {
    await publicClientFor(network).call({account: request.from, to: request.to, data: request.data});
    return undefined;
  } catch (e) {
    return revertData(e)?.slice(0, 10);
  }
}

/** The relayer's reasons that mean the vault could not pay — not that the operation itself fails. */
const FEE_REFUSALS = new Set(['fee-leg-failed', 'insufficient-liquid-balance', 'budget-exhausted', 'stable-coin-as-gas-off', 'relayer-unfunded']);

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
    case 'relayer-unfunded':
      return t('mobile.fees.relayer_unfunded');
    case 'stable-coin-as-gas-off':
      return withCode(t('mobile.actions.relay_stable_coin_as_gas_off'), json.reason, json.code);
    case 'simulation-failed': {
      // The call itself reverts, so retrying it unchanged cannot work. Nothing was signed or sent.
      // When it is the vault refusing, say what it objected to, in the words the screens use.
      const name = json.code ? nameRevert(json.code) : undefined;
      if (name && REVERT_REASON[name]) return `${t(`vault.gate.${REVERT_REASON[name]}`)}\n\n${name}`;
      // Or the lending pool behind an adapter refused it (a frozen or paused reserve, a full cap):
      // not the vault's doing, so not the vault's "check the allow list" sentence either.
      const pool = lendingPoolRevert(json.code);
      if (pool) return t(pool);
      return withCode(t('mobile.actions.relay_refused'), json.reason, json.code);
    }
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
  // A revert the server could not name arrives as its bare selector; a vault ABI this device has
  // (shipped, or downloaded for a newer release) may know it.
  const tail = [reason, code ? nameRevert(code) : code].filter(Boolean).join(' · ');
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
  /**
   * Send `stableCoin` as the hint even when the owner's fee-coin order puts another coin first.
   *
   * For a write that SPENDS the owner's first coin: the relayer checks the hinted coin's balance
   * before the call and charges it after, so hinting the coin the call is about to spend down passes
   * the check and fails the charge (`fee-leg-failed`). A caller that has worked out which coin will
   * still be there afterwards — the one it held the fee float back in — pins that one.
   */
  pinFee?: boolean;
  /**
   * Keep the vault with the key that signs this write, on quantum-safe keys.
   *
   * For the setup in front of a limit or recurring order: the order is signed next by the same key,
   * and the vault checks that signature against its owner whenever the order fills, so handing the
   * vault on here would stop the order filling once the timelock ran.
   */
  noRotate?: boolean;
  /**
   * Adapters the operation this write prepares for will run on, though no call here names them.
   *
   * The setup in front of a CoW order allowlists its tokens, and the order itself is signed off
   * chain: nothing in the batch mentions the CoW adapter, so its due upgrade was left behind and
   * the order went out on the old build. Named here, the upgrade rides in front (see vault/auto-upgrade).
   */
  uses?: readonly Address[];
}): Promise<RelayResult> {
  const data = encodeCall({abi: opts.abi, functionName: opts.functionName, args: opts.args});
  return relayEncoded({
    account: opts.account,
    vault: opts.vault,
    network: opts.network,
    data,
    activationCalls: [data],
    stableCoin: opts.stableCoin,
    pinFee: opts.pinFee,
    noRotate: opts.noRotate,
    uses: opts.uses,
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
  /** See {relayVaultWrite}. */
  pinFee?: boolean;
  /** See {relayVaultWrite}. */
  noRotate?: boolean;
  /** See {relayVaultWrite}. */
  uses?: readonly Address[];
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
    pinFee: opts.pinFee,
    noRotate: opts.noRotate,
    uses: opts.uses,
  });
}

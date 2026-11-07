/**
 * Gasless TWAP via CoW, ported from web placeGaslessTwap. The manager signs the whole schedule ONCE
 * (a TwapOrder); part 0 is posted now; the schedule + that single signature are persisted to the
 * server, whose cron posts parts 1..N-1 at each window. Every part is a fill-or-kill sell order valid
 * only during its slot. No on-chain tx.
 */
import {encodeAbiParameters, parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiFetch, apiUrl, CHAIN_ID, type Network} from '@/core/chain';
import {
  BALANCE_ERC20,
  COW_PARTNER_FEE_BPS,
  GPV2_SETTLEMENT,
  KIND_SELL,
  ORDER_TUPLE,
  TWAP_712_TYPES,
  TWAP_TUPLE,
  buildTwapAppData,
  cowApiBase,
  cowFeeRecipient,
  orderSignerSig,
} from '@/core/cow';
import {VAULT_INTENT_ABI} from '@/core/abi';
import {assetMeta} from '@/core/assets';
import {relayVaultWrite} from './relay';

const FEE_BPS = BigInt(COW_PARTNER_FEE_BPS);

/**
 * Place a TWAP: sell `totalSell` of `sellToken` over `parts` slices, `partDuration` seconds apart, for
 * at least `totalMinBuy` of `buyToken` overall. Returns the number of parts scheduled.
 */
export async function placeTwap(o: {
  account: Signer;
  vault: Address;
  network: Network;
  intentProtocol: Address; // the CoW adapter; its clone decides the fee recipient
  sellToken: Address;
  buyToken: Address;
  totalSell: string; // human
  totalMinBuy: string; // human
  parts: number;
  partDuration: number; // seconds per slice
}): Promise<number> {
  const chainId = CHAIN_ID[o.network];
  const startTime = Math.floor(Date.now() / 1000);
  const recipient = await cowFeeRecipient(o.network, o.vault, o.intentProtocol);
  const {hash: appData, fullAppData} = buildTwapAppData(BigInt(startTime), recipient);

  const sellDec = assetMeta(o.network, o.sellToken).decimals;
  const buyDec = assetMeta(o.network, o.buyToken).decimals;
  const partsBig = BigInt(o.parts);
  const sellAmountPerPart = parseUnits(o.totalSell, sellDec) / partsBig;
  // Per-part min, discounted for the 0.2% partner fee.
  let buyAmountPerPart = parseUnits(o.totalMinBuy, buyDec) / partsBig;
  buyAmountPerPart = buyAmountPerPart - (buyAmountPerPart * FEE_BPS) / BigInt(10000);

  const twap: TwapParams = {
    sellToken: o.sellToken,
    buyToken: o.buyToken,
    sellAmountPerPart,
    buyAmountPerPart,
    startTime: BigInt(startTime),
    partDuration: BigInt(o.partDuration),
    numParts: partsBig,
  };

  // Register the fee document first (idempotent): every part's order names it, and for a
  // multi-owner Safe the schedule is posted by whichever owner's signature completes it, later.
  await fetch(`${cowApiBase(o.network)}/app_data/${appData}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({fullAppData}),
  }).catch(() => {});

  // ONE signature authorizes every part, bound to the vault. A Safe owner's may first have to be
  // completed by co-owners (vault/safe SafeSignaturePending).
  const domain = {name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: GPV2_SETTLEMENT} as const;
  const managerSig = await o.account.signTypedData({domain, types: TWAP_712_TYPES, primaryType: 'TwapOrder', message: {vault: o.vault, ...twap}});

  return postTwapSchedule({network: o.network, vault: o.vault, twap, appData, signerSig: orderSignerSig(o.account, managerSig)});
}

/** A TWAP schedule as signed: every part is these amounts, one part per `partDuration`. */
export type TwapParams = {
  sellToken: Address;
  buyToken: Address;
  sellAmountPerPart: bigint;
  buyAmountPerPart: bigint;
  startTime: bigint;
  partDuration: bigint;
  numParts: bigint;
};

/**
 * Post a signed schedule's current part to CoW and register the schedule so the server posts the
 * rest. `signerSig` is the owner's schedule signature as the clone reads it (core/cow
 * `orderSignerSig`). Split from {placeTwap} so a schedule whose Safe signature was collected later
 * is posted the same way.
 *
 * The part posted is the one whose slot is open NOW — part 0 when posted at once. A schedule
 * finished by co-owners later than that has already lost the slots that closed meanwhile: a part's
 * order expires with its slot, and posting one that has would only be refused. Returns the parts
 * still to run.
 */
export async function postTwapSchedule(o: {
  network: Network;
  vault: Address;
  twap: TwapParams;
  appData: Hex;
  signerSig: Hex;
}): Promise<number> {
  const {twap} = o;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const part = now <= twap.startTime ? BigInt(0) : (now - twap.startTime) / twap.partDuration;
  if (part >= twap.numParts) throw new Error('The schedule has ended; every part\'s time has passed.');

  // Part `part`: eip1271 payload = abi.encode(order, twap, partIndex, managerSig).
  const validTo = Number(twap.startTime + (part + BigInt(1)) * twap.partDuration);
  const order = {
    sellToken: twap.sellToken,
    buyToken: twap.buyToken,
    receiver: o.vault,
    sellAmount: twap.sellAmountPerPart,
    buyAmount: twap.buyAmountPerPart,
    validTo,
    appData: o.appData,
    feeAmount: BigInt(0),
    kind: KIND_SELL,
    partiallyFillable: false,
    sellTokenBalance: BALANCE_ERC20,
    buyTokenBalance: BALANCE_ERC20,
  };
  const payload = encodeAbiParameters(
    [ORDER_TUPLE, TWAP_TUPLE, {type: 'uint256'}, {type: 'bytes'}],
    [order, twap, part, o.signerSig],
  );

  const res = await fetch(`${cowApiBase(o.network)}/orders`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      sellToken: twap.sellToken,
      buyToken: twap.buyToken,
      receiver: o.vault,
      sellAmount: twap.sellAmountPerPart.toString(),
      buyAmount: twap.buyAmountPerPart.toString(),
      validTo,
      appData: o.appData,
      feeAmount: '0',
      kind: 'sell',
      partiallyFillable: false,
      signingScheme: 'eip1271',
      signature: payload,
      from: o.vault,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    }),
  });
  if (!res.ok) throw new Error(`CoW rejected part ${part}: ${await res.text()}`);

  // Persist the schedule + the single signature so the server cron posts the parts after this one.
  await fetch(apiUrl('/api/ethereum/vaults/twap', o.network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      vaultAddress: o.vault,
      side: 'sell',
      sellToken: twap.sellToken,
      buyToken: twap.buyToken,
      sellAmountPerPart: twap.sellAmountPerPart.toString(),
      buyAmountMinPerPart: twap.buyAmountPerPart.toString(),
      startTime: Number(twap.startTime),
      partDuration: Number(twap.partDuration),
      span: 0,
      parts: Number(twap.numParts),
      appData: o.appData,
      signature: o.signerSig,
    }),
  }).catch(() => {});

  return Number(twap.numParts - part);
}

export type TwapSchedule = {
  appData: string;
  side: string;
  status: string; // 'active' | 'finished' | 'cancelled'
  startTime: number;
  partDuration: number;
  parts: number;
  lastPostedPart: number;
  windowEnd: number;
  twapId: string;
};

/** The vault's TWAP schedules (all statuses) from the server. Used to list + cancel. */
export async function fetchTwapSchedules(vault: Address, network: Network): Promise<TwapSchedule[]> {
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/twap/${vault}`, network));
    if (!res.ok) return [];
    const j = (await res.json()) as {data?: TwapSchedule[]};
    return j.data ?? [];
  } catch {
    return [];
  }
}

/**
 * Cancel a TWAP schedule: invalidate its currently-open part order(s) on-chain (gasless) so nothing
 * more settles, then tell the server cron to stop posting future parts. `openPartUids` are the open CoW
 * orders whose appData matches the schedule (the caller filters these from the live order list).
 */
export async function cancelTwap(o: {
  account: Signer;
  vault: Address;
  network: Network;
  intentProtocol: Address;
  appData: string;
  openPartUids: Hex[];
  stableCoin: Address;
}): Promise<void> {
  if (o.openPartUids.length > 0) {
    await relayVaultWrite({
      account: o.account,
      vault: o.vault,
      network: o.network,
      abi: VAULT_INTENT_ABI,
      functionName: 'cancelIntentOrders',
      args: [o.intentProtocol, o.openPartUids],
      stableCoin: o.stableCoin,
    });
  }
  // Stop the cron from posting the not-yet-posted parts (idempotent).
  await fetch(apiUrl(`/api/ethereum/vaults/twap/${o.vault}?appData=${o.appData}`, o.network), {
    method: 'DELETE',
  }).catch(() => {});
}

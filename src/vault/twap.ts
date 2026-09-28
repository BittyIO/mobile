/**
 * Gasless TWAP via CoW, ported from web placeGaslessTwap. The manager signs the whole schedule ONCE
 * (a TwapOrder); part 0 is posted now; the schedule + that single signature are persisted to the
 * server, whose cron posts parts 1..N-1 at each window. Every part is a fill-or-kill sell order valid
 * only during its slot. No on-chain tx.
 */
import {encodeAbiParameters, parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import {apiUrl, CHAIN_ID, type Network} from '@/core/chain';
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
  sellToken: Address;
  buyToken: Address;
  totalSell: string; // human
  totalMinBuy: string; // human
  parts: number;
  partDuration: number; // seconds per slice
}): Promise<number> {
  const chainId = CHAIN_ID[o.network];
  const startTime = Math.floor(Date.now() / 1000);
  const {hash: appData, fullAppData} = buildTwapAppData(BigInt(startTime));

  const sellDec = assetMeta(o.network, o.sellToken).decimals;
  const buyDec = assetMeta(o.network, o.buyToken).decimals;
  const partsBig = BigInt(o.parts);
  const sellAmountPerPart = parseUnits(o.totalSell, sellDec) / partsBig;
  // Per-part min, discounted for the 0.2% partner fee.
  let buyAmountPerPart = parseUnits(o.totalMinBuy, buyDec) / partsBig;
  buyAmountPerPart = buyAmountPerPart - (buyAmountPerPart * FEE_BPS) / BigInt(10000);

  const twap = {
    sellToken: o.sellToken,
    buyToken: o.buyToken,
    sellAmountPerPart,
    buyAmountPerPart,
    startTime: BigInt(startTime),
    partDuration: BigInt(o.partDuration),
    numParts: partsBig,
  };

  // ONE signature authorizes every part.
  const managerSig = await o.account.signTypedData({
    domain: {name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: GPV2_SETTLEMENT},
    types: TWAP_712_TYPES,
    primaryType: 'TwapOrder',
    message: twap,
  });

  const base = cowApiBase(o.network);
  await fetch(`${base}/app_data/${appData}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({fullAppData}),
  }).catch(() => {});

  // Part 0: eip1271 payload = abi.encode(order, twap, partIndex=0, managerSig).
  const validTo = startTime + 1 * o.partDuration;
  const order = {
    sellToken: o.sellToken,
    buyToken: o.buyToken,
    receiver: o.vault,
    sellAmount: sellAmountPerPart,
    buyAmount: buyAmountPerPart,
    validTo,
    appData,
    feeAmount: BigInt(0),
    kind: KIND_SELL,
    partiallyFillable: false,
    sellTokenBalance: BALANCE_ERC20,
    buyTokenBalance: BALANCE_ERC20,
  };
  const payload = encodeAbiParameters(
    [ORDER_TUPLE, TWAP_TUPLE, {type: 'uint256'}, {type: 'bytes'}],
    [order, twap, BigInt(0), managerSig],
  );

  const res = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      receiver: o.vault,
      sellAmount: sellAmountPerPart.toString(),
      buyAmount: buyAmountPerPart.toString(),
      validTo,
      appData,
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
  if (!res.ok) throw new Error(`CoW rejected part 0: ${await res.text()}`);

  // Persist the schedule + the single signature so the server cron posts parts 1..N-1.
  await fetch(apiUrl('/api/ethereum/vaults/twap', o.network), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      vaultAddress: o.vault,
      side: 'sell',
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      sellAmountPerPart: sellAmountPerPart.toString(),
      buyAmountMinPerPart: buyAmountPerPart.toString(),
      startTime,
      partDuration: o.partDuration,
      span: 0,
      parts: o.parts,
      appData,
      signature: managerSig,
    }),
  }).catch(() => {});

  return o.parts;
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
    const res = await fetch(apiUrl(`/api/ethereum/vaults/twap/${vault}`, network));
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

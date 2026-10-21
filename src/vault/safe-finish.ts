/**
 * Finish an operation a multi-owner Safe has finished signing.
 *
 * When this device signs for a Safe whose threshold it cannot meet alone, the operation stops at the
 * signature (vault/safe `SafeSignaturePending`). Everything needed to complete it is in the payload
 * the Bitty API kept — the forwarder request, activation or CoW order exactly as signed — so any
 * owner, on any device, finishes it from there once the Safe's signature is complete: the same
 * submit step the single-signature flow ends in, with the Safe's combined signature.
 */
import type {Address, Hex} from 'viem';
import type {Network} from '@/core/chain';
import {knownAssets} from '@/core/assets';
import {FEE_RECIPIENTS, buildTwapAppData, cowApiBase, orderSignerSig} from '@/core/cow';
import {submitForwardRequest} from './relay';
import {submitActivation} from './activate';
import {postLimitOrder} from './limit';
import {postTwapSchedule} from './twap';
import {ownerVaultAddress} from './read';
import type {SafeMessageStatus} from './safe';

export type FinishResult =
  | {kind: 'tx'; hash: Hex}
  | {kind: 'order'; uid: string}
  | {kind: 'twap'; parts: number};

const str = (v: unknown) => String(v);
const big = (v: unknown) => BigInt(str(v));

/**
 * The TWAP schedule's fee appData. It is not part of the signed schedule — it is derived from the
 * start time and the adapter's fee recipient — so it is found the way it was made: one candidate
 * per recipient any adapter build uses, and the one CoW already holds (it was registered before the
 * schedule was signed).
 */
async function twapAppData(network: Network, startTime: bigint): Promise<Hex> {
  for (const recipient of FEE_RECIPIENTS) {
    const {hash} = buildTwapAppData(startTime, recipient);
    const res = await fetch(`${cowApiBase(network)}/app_data/${hash}`).catch(() => null);
    if (res?.ok) return hash;
  }
  throw new Error("Could not find this schedule's fee document on CoW. Place the TWAP again.");
}

export async function finishSafeMessage(network: Network, status: SafeMessageStatus): Promise<FinishResult> {
  if (!status.ready || !status.signature) throw new Error('The Safe has not finished signing this yet.');
  const signature = status.signature;
  const {domain, message: m} = status.typedData;

  switch (status.primaryType) {
    case 'ForwardRequest': {
      const stable = knownAssets(network).find((a) => a.kind === 'stable');
      const {hash} = await submitForwardRequest({
        network,
        request: {
          from: m.from as Address,
          to: m.to as Address,
          value: str(m.value),
          gas: str(m.gas),
          deadline: Number(m.deadline),
          data: m.data as Hex,
          signature,
        },
        // A preference only: the relayer tries the vault's other fee coins too.
        stableCoin: (stable?.address ?? m.to) as Address,
      });
      return {kind: 'tx', hash};
    }
    case 'Activation': {
      const {hash} = await submitActivation({
        network,
        factory: domain.verifyingContract,
        owner: m.owner as Address,
        stableCoin: m.stableCoinAddress as Address,
        feeAmount: big(m.feeAmount),
        // v1.0.0 signs it as restrictToOwnAllowList, v1.0.3 as allowlistEnabled.
        allowlistEnabled: Boolean(m.restrictToOwnAllowList ?? m.allowlistEnabled),
        calls: (m.calls ?? []) as Hex[],
        deadline: m.deadline === undefined ? undefined : big(m.deadline),
        signature,
      });
      return {kind: 'tx', hash};
    }
    case 'Order': {
      const uid = await postLimitOrder({
        network,
        order: {
          sellToken: m.sellToken as Address,
          buyToken: m.buyToken as Address,
          receiver: m.receiver as Address,
          sellAmount: big(m.sellAmount),
          buyAmount: big(m.buyAmount),
          validTo: Number(m.validTo),
          appData: m.appData as Hex,
          kind: m.kind === 'buy' ? 'buy' : 'sell',
        },
        signerSig: orderSignerSig({address: status.safe, isContract: true}, signature),
      });
      return {kind: 'order', uid};
    }
    case 'TwapOrder': {
      const twap = {
        sellToken: m.sellToken as Address,
        buyToken: m.buyToken as Address,
        sellAmountPerPart: big(m.sellAmountPerPart),
        buyAmountPerPart: big(m.buyAmountPerPart),
        startTime: big(m.startTime),
        partDuration: big(m.partDuration),
        numParts: big(m.numParts),
      };
      const parts = await postTwapSchedule({
        network,
        // Named in the schedule when the adapter binds it; otherwise it is the Safe's own vault.
        vault: (m.vault as Address | undefined) ?? ownerVaultAddress(status.safe, network),
        twap,
        appData: await twapAppData(network, twap.startTime),
        signerSig: orderSignerSig({address: status.safe, isContract: true}, signature),
      });
      return {kind: 'twap', parts};
    }
    default:
      throw new Error(`${status.primaryType} cannot be finished from the app.`);
  }
}

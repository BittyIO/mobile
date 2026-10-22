/**
 * The network fee paid by the OWNER: the phone sends the transaction itself, from the owner address,
 * and pays the gas in that address's own ETH. The other way to the same place as ./relay.
 *
 * Nothing about the vault changes. It accepts a call from its owner directly exactly as it accepts
 * one the forwarder relays for them — `_msgSender()` is the owner either way — and the factory has a
 * plain `activateVault` that deploys the caller's vault with no signature and no fee. So the calldata
 * is the same as a relay's; only who carries it differs, and there is no relay fee.
 *
 * Every send is checked against the owner's balance BEFORE it is signed, so "not enough ETH" is said
 * in words, with the address to fund, rather than as a node's "insufficient funds" after Face ID.
 */
import {formatEther, type Address, type Hex} from 'viem';
import {publicActionsL2} from 'viem/op-stack';
import type {Signer} from '@/wallet/signer';
import {CHAIN_ID, publicClientFor, type Network} from '@/core/chain';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';
import {fmtNum} from '@/core/format';

export type OwnerTxPlan = {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Base's L1 data fee, which the sender pays on top of gas. 0 elsewhere. */
  l1Fee: bigint;
  /** The most this can cost in ETH: gas at the max fee, plus the L1 fee. What is charged is less. */
  cost: bigint;
};

/**
 * ETH in the app's own amount format (core/format `fmtNum`), so a fee reads like every balance:
 * an L2 transaction's few millionths of an ETH as "0.0₅287", its zeros counted in a subscript
 * rather than spelled out. Draw it through components/Amount to drop the subscript below the line.
 */
export function formatEth(wei: bigint): string {
  return fmtNum(Number(formatEther(wei)));
}

/** The owner wallet cannot cover this transaction. Thrown before anything is signed. */
export class OwnerGasShort extends Error {
  constructor(
    readonly owner: Address,
    readonly need: bigint,
    readonly have: bigint,
  ) {
    super(
      translate(useLanguage.getState().language, 'mobile.fees.owner_short', {
        need: formatEth(need),
        have: formatEth(have),
        owner,
      }),
    );
  }
}

/**
 * What sending this will take: gas with the same third of margin a relay asks for (see relay
 * `innerGasFor` — the first operation through an adapter deploys its clone and estimates low), at
 * the network's current fees.
 *
 * Throws when the estimate does: a direct call that cannot be estimated reverts, and saying so here
 * costs nothing, where sending it would burn the gas.
 */
export async function planOwnerTx(o: {network: Network; from: Address; to: Address; data?: Hex; value?: bigint}): Promise<OwnerTxPlan> {
  const client = publicClientFor(o.network);
  const tx = {account: o.from, to: o.to, data: o.data ?? ('0x' as Hex), value: o.value ?? BigInt(0)};
  const [used, fees] = await Promise.all([client.estimateGas(tx), client.estimateFeesPerGas()]);
  const gas = (used * BigInt(4)) / BigInt(3);
  // Base charges the sender for posting the transaction to L1 as well. Arbitrum and Robinhood Chain
  // fold theirs into the gas estimate; Ethereum has none.
  const l1Fee =
    o.network === 'base'
      ? await client
          .extend(publicActionsL2())
          .estimateL1Fee({...tx, chain: undefined})
          .catch(() => BigInt(0))
      : BigInt(0);
  return {
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    l1Fee,
    cost: gas * fees.maxFeePerGas + l1Fee,
  };
}

/** The owner's ETH on `network` — what owner-paid fees come out of. */
export function ownerEthBalance(network: Network, owner: Address): Promise<bigint> {
  return publicClientFor(network).getBalance({address: owner});
}

/**
 * Send one transaction from the owner key, paying its own gas. Returns once it is broadcast, as a
 * relay does; the caller's toast follows it to its receipt (see components/Toast `showTx`).
 */
export async function sendFromOwner(o: {
  account: Signer;
  network: Network;
  to: Address;
  data?: Hex;
  value?: bigint;
  plan?: OwnerTxPlan;
}): Promise<{hash: Hex}> {
  if (!o.account.signTransaction || o.account.isContract) {
    throw new Error(translate(useLanguage.getState().language, 'mobile.fees.owner_cannot_send'));
  }
  const client = publicClientFor(o.network);
  const value = o.value ?? BigInt(0);
  const plan = o.plan ?? (await planOwnerTx({network: o.network, from: o.account.address, to: o.to, data: o.data, value}));
  const have = await ownerEthBalance(o.network, o.account.address);
  if (have < plan.cost + value) throw new OwnerGasShort(o.account.address, plan.cost + value, have);

  // 'pending', so two writes in quick succession queue one after the other rather than collide.
  const nonce = await client.getTransactionCount({address: o.account.address, blockTag: 'pending'});
  const serializedTransaction = await o.account.signTransaction({
    type: 'eip1559',
    chainId: CHAIN_ID[o.network],
    nonce,
    to: o.to,
    data: o.data ?? '0x',
    value,
    gas: plan.gas,
    maxFeePerGas: plan.maxFeePerGas,
    maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
  });
  const hash = await client.sendRawTransaction({serializedTransaction});
  return {hash};
}

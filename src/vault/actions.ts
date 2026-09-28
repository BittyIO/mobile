/**
 * Typed vault actions on top of the gasless relay. Each takes a human amount + the asset's decimals and
 * relays the corresponding vault call, signed in-app. Returns the relayed tx hash.
 */
import {parseUnits, type Address, type Hex} from 'viem';
import type {Signer} from '@/wallet/signer';
import type {Network} from '@/core/chain';
import {VAULT_DEFI_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';

type Base = {
  account: Signer;
  vault: Address;
  network: Network;
  protocol: Address;
  asset: Address;
  amount: string; // human units, e.g. "100.5"
  decimals: number;
  stableCoin: Address;
};

/** Stake/supply `amount` of `asset` into `protocol` (Sky, Aave, Lido). */
export async function depositToProtocol(o: Base): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_DEFI_ABI,
    functionName: 'deposit',
    args: [o.protocol, o.asset, parseUnits(o.amount, o.decimals)],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Withdraw `amount` of `asset` from `protocol` (unstake folds into withdraw on v1.0.x). */
export async function withdrawFromProtocol(o: Base): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_DEFI_ABI,
    functionName: 'withdraw',
    args: [o.protocol, o.asset, parseUnits(o.amount, o.decimals)],
    stableCoin: o.stableCoin,
  });
  return hash;
}

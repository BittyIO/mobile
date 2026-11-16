/**
 * Staking from the Tron wallet: Tron's own Stake 2.0, on the wallet's TRX.
 *
 * Staked TRX is frozen for ENERGY, which the wallet's own contract calls (a USDT payment, a swap)
 * spend instead of burning TRX. It pays no yield, as the Nile vault's TRX stake does not. Unstaking
 * is Tron's: the TRX unlocks 14 days after it is asked for (on mainnet) and is then claimed back
 * into the balance. All of it is read from the account itself; nothing here needs an index.
 */
import {accountEnergy, chainParams, stakeAccount, type TronEnergy, type TronStakeAccount} from './client';
import {withTronKey} from './sign';
import {SUN_PER_TRX, type TronNet} from './config';

/** Tron's smallest stake, 1 TRX. */
export const MIN_STAKE_SUN = SUN_PER_TRX;
/** Tron keeps at most 32 unstakes waiting at once per account. */
export const MAX_UNSTAKING = 32;

export type TronStakeState = TronStakeAccount & {
  energy: TronEnergy;
  /** Unstaked TRX whose wait is over, ready to claim. */
  claimableSun: bigint;
  /** The unstake wait on this network, in days. */
  unstakeDays: number;
};

export async function readTronStake(net: TronNet, address: string): Promise<TronStakeState> {
  const [acct, energy, params] = await Promise.all([stakeAccount(net, address), accountEnergy(net, address), chainParams(net)]);
  const now = Date.now();
  return {
    ...acct,
    energy,
    claimableSun: acct.unstaking.filter((u) => u.unlockAt <= now).reduce((n, u) => n + u.amountSun, 0n),
    // getUnfreezeDelayDays is the network's own setting; 14 on mainnet today.
    unstakeDays: params.getUnfreezeDelayDays || 14,
  };
}

export type StakeAction = {kind: 'stake' | 'unstake'; amountSun: bigint} | {kind: 'claim'};

/** One Stake 2.0 transaction, behind Face ID. Resolves once it is in a block. */
export async function runStakeAction(net: TronNet, from: string, a: StakeAction): Promise<string> {
  return withTronKey(net, from, async (signer) => {
    const id = await signer.send(
      a.kind === 'claim' ? {kind: 'withdrawUnfrozen', from} : {kind: a.kind === 'stake' ? 'freeze' : 'unfreeze', from, amountSun: a.amountSun},
    );
    if (!(await signer.settle(id))) throw new Error('The Tron network refused it.');
    return id;
  });
}

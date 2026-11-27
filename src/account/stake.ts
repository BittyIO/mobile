import {encodeFunctionData, parseAbi, type Address} from 'viem';
import type {AccountCall} from './relay';

/**
 * Staking the Tron smart wallet's own TRX for energy (BittyAccount stakeTrx / delegateEnergy /
 * unstakeTrx / withdrawUnstaked, TRON's Stake 2.0 run from the account). The TRX never leaves the
 * account: it is frozen there and comes back there. The account sends no transactions itself, so
 * its energy is lent to the owner key, at once (the contract allows the owner or a payee without
 * waiting), where the general wallet's own sends use it instead of burning TRX.
 */
const ABI = parseAbi([
  'function stakeTrx(uint256 amount)',
  'function unstakeTrx(uint256 amount)',
  'function withdrawUnstaked() returns (uint256)',
  'function delegateEnergy(address receiver, uint256 amount)',
  'function undelegateEnergy(address receiver, uint256 amount)',
]);

const self = (account: Address, functionName: string, args: readonly unknown[] = []): AccountCall => ({
  to: account,
  value: BigInt(0),
  data: encodeFunctionData({abi: ABI, functionName: functionName as never, args: args as never}),
});

/** Stake `sun` and lend its energy to the owner key, in one batch. */
export const stakeCalls = (account: Address, owner: Address, sun: bigint) => [self(account, 'stakeTrx', [sun]), self(account, 'delegateEnergy', [owner, sun])];

/** Unstake `sun`: first take back as much of it as is lent to the owner key, then start the unstake. */
export function unstakeCalls(account: Address, owner: Address, sun: bigint, delegatedSun: bigint): AccountCall[] {
  const back = sun < delegatedSun ? sun : delegatedSun;
  return [...(back > BigInt(0) ? [self(account, 'undelegateEnergy', [owner, back])] : []), self(account, 'unstakeTrx', [sun])];
}

/** Take every unstake whose delay has passed back into the account. */
export const withdrawCalls = (account: Address) => [self(account, 'withdrawUnstaked')];

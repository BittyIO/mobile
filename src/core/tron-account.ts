import {concat, encodeAbiParameters, getAddress, keccak256, type Address, type Hex} from 'viem';
import type {Network} from '@/core/chain';

/**
 * The Tron smart wallet: a BittyAccount (contracts repo vault, src/account), one per owner key at a
 * fixed address made by its BittyAccountFactory, there before it exists: it can receive first and is
 * created by its first relayed send (the factory's createAndExecute). It replaces the BittyVault on
 * Tron, which the app no longer offers there (core/active-vault).
 */
export const TRON_ACCOUNT: Partial<Record<Network, {factory: Address; implementation: Address}>> = {
  // THfRaBZ9mkbQABvCConjcuGWnV3jaGvTU1, deployed 2026-11-27 (tx 6d1c1533…3b62); its implementation
  // takes USDT's false-on-success return (usdtFalseIsSuccess), read back from the chain the same day.
  // It replaced TYa84mWSLMNGPqmyT2ceBKxneHgeJgi363, whose accounts could not send Nile's USDT.
  'tron-nile': {factory: '0x54640345ca4748D591923b924f84Bb48C9Bc30D2', implementation: '0x59Ad2936bb6868413AB1D7b1B61CcF5c72FEA796'},
};

/** Whether `network` has the Tron smart wallet (a factory deployed). */
export const hasTronAccount = (network: Network): boolean => !!TRON_ACCOUNT[network];

/** The EIP-1167 clone of `implementation`, as the factory deploys it: its init code's hash. */
function cloneCodeHash(implementation: Address): Hex {
  return keccak256(concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3']));
}

/**
 * `owner`'s account number `index` on `network`, created or not: the factory's predictAccount, worked
 * out here (CREATE2 with Tron's 0x41 prefix, salt keccak256(abi.encode(owner, index))). Null where
 * the network has no factory.
 */
export function tronAccountAddress(network: Network, owner: Address, index = 0): Address | null {
  const d = TRON_ACCOUNT[network];
  if (!d) return null;
  const salt = keccak256(encodeAbiParameters([{type: 'address'}, {type: 'uint256'}], [owner, BigInt(index)]));
  const h = keccak256(concat(['0x41', d.factory, salt, cloneCodeHash(d.implementation)]));
  return getAddress(`0x${h.slice(-40)}`);
}

import {parseAbi} from 'viem';

/** The escrow deal's terms, as both contracts encode them (contracts repo escrow/src/BittyEscrow.sol). */
const TERMS =
  '(address token, address a, address b, address c, uint128 amountA, uint128 amountB, uint64 endTime)';

/**
 * BittyEscrowFactory since escrow 3cb96a0 ("reuse escrow address"): every address owns escrow
 * accounts numbered 0, 1, 2, ...; a deal starts in one ({startDeal}), and once it is over and paid
 * out the next deal can start in the same account for about a quarter of the gas of a new one.
 */
export const escrowFactoryAbi = parseAbi([
  `function startDeal(uint256 n, ${TERMS} t) returns (address account, uint64 dealId)`,
  'function predictAccount(address owner, uint256 n) view returns (address)',
  'function freeAccount(address owner) view returns (uint256 n, address account)',
  'function accountCount(address owner) view returns (uint256)',
  'function implementation() view returns (address)',
  'function feeFor(address token, uint256 amount) view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function isEscrow(address escrow) view returns (bool)',
]);

/** An escrow account: one deal at a time, numbered by `dealId`; every call on a deal names it. */
export const escrowAbi = parseAbi([
  `function terms() view returns (${TERMS})`,
  'function dealId() view returns (uint64)',
  'function owner() view returns (address)',
  'function reusable() view returns (bool)',
  'function status() view returns (uint8)',
  'function outcome() view returns (uint8)',
  'function paidA() view returns (bool)',
  'function paidB() view returns (bool)',
  'function feeA() view returns (uint128)',
  'function feeB() view returns (uint128)',
  'function feeOwed() view returns (uint256)',
  'function votes() view returns ((uint8 a, uint8 b, uint8 c))',
  'function owed(address account) view returns (uint256)',
  'function deposit(uint64 id)',
  'function vote(uint64 id, uint8 o)',
  'function cancel(uint64 id)',
  'function finalize(uint64 id)',
  'function claim(address to) returns (uint256)',
  // The owner only (escrow c41ecb7): send out money that came in other than by deposit. Token 0 is
  // TRX; the deal's token only while the account is {reusable}.
  'function rescue(address token, address to, uint256 amount)',
]);

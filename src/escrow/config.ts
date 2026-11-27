import type {Address} from 'viem';
import type {Network} from '@/core/chain';

/**
 * Where the escrow factory (contracts repo `escrow`, BittyEscrowFactory) lives on each network the
 * app offers escrow on: the 20 bytes behind the T… address. A network missing here shows the escrow
 * page as "not available on this network yet".
 *
 * Fill in after `node escrow.mjs deploy --network nile` (escrow/deployments/tron-nile.json,
 * `BittyEscrowFactory`).
 */
export const ESCROW_FACTORY: Partial<Record<Network, Address>> = {
  // TCg49JYUb2n3G61oJnJteNJ8NfX5wtTAPP, deployed 2026-11-27 (escrow d9d06f8): reusable escrow
  // accounts, numbered per owner; the owner's `rescue` for money sent to one by mistake; a cancel
  // that would empty the account keeps one base unit; a side choosing to pay everything to the
  // other decides alone. Fee 0.2%, CREATE2 prefix 0x41, every deal has an arbiter. (Replaces
  // TUbLjox…, the same but both sides had to agree; TVvtrxg…, a cancel refunded everything;
  // TPGtAc8…, no rescue; TPrzJ7…, one contract per deal.)
  'tron-nile': '0x1da9E96dF44BeFb157e96C35f0Fa8b178A6c9913',
  // tron: '0x…',
};

/**
 * Factories replaced on a network. Their deals are not listed, but their escrows still exist: Send
 * checks against these too, so nobody pays one of them by plain transfer (see escrow `isEscrowAddress`).
 */
export const ESCROW_FACTORIES_RETIRED: Partial<Record<Network, Address[]>> = {
  'tron-nile': ['0xCC47b2846A72F0d403816d8FA31d05540F2dAEeB', '0xdaf28aA376F04948911D0dA47529521234BC17D7', '0x91F166465489e499a7e7Bb3AB90D22593c76E442', '0x9864A8A9298FeC2F3541950ee66013343242aE6A', '0x1270f55dEd8bbAd172bD323eB9D85aEB6c53a839', '0xE5C29CA4DD13894b693fC8A64B483900f1BbeFC4'],
};

/**
 * The networks the escrow is offered on, from the wallet: Nile only until a factory is deployed on
 * Tron mainnet (then add 'tron' here and its address above).
 */
export const ESCROW_NETWORKS: Network[] = ['tron-nile'];

/** The token every escrow on a network is in: its USDT (core/assets). */
export const ESCROW_TOKEN_SYMBOL = 'USDT';

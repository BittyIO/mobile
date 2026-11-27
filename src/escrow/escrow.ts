/**
 * Two-sided escrow deals from the WALLET (contracts repo `escrow`, since 3cb96a0): deals live in
 * escrow ACCOUNTS, contracts the factory makes for an owner (numbered 0, 1, 2, ...). Each holds one
 * deal at a time; once a deal is over and paid out, the owner's next deal starts in the same account
 * for about a quarter of the gas of a new one. So a deal is an account and its `dealId`.
 *
 *   - A and B each put in an amount (either may be zero, not both), in the network's USDT.
 *   - It settles to A, to B, or each gets their own amount back. Who decides is fixed at creation:
 *     C alone, A and B together, all three, or C or A and B.
 *   - An optional end time settles a funded deal with an outcome chosen at creation.
 *   - The fee, per side the larger of 0.1 USDT and the factory's rate (0.2% by default, at most 1%), is taken only when a deal settles.
 *   - Whoever is owed money withdraws it, to any address they name.
 *
 * Every write is the wallet's ordinary contract call (wallet/calls), so on Tron it goes out as a
 * TriggerSmartContract signed on this phone.
 */
import {MMKV} from 'react-native-mmkv';
import {encodeFunctionData, zeroAddress, type Address, type Hex} from 'viem';
import {isTronNetwork, publicClientFor, type Network} from '@/core/chain';
import {planOwnerTx} from '@/vault/direct';
import {ASSETS} from '@/core/assets';
import type {Signer} from '@/wallet/signer';
import {standingApprovalIfNeeded, sendWalletCalls, type WalletCall} from '@/wallet/calls';
import {escrowAbi, escrowFactoryAbi} from './abi';
import {ESCROW_FACTORIES_RETIRED, ESCROW_FACTORY, ESCROW_NETWORKS, ESCROW_TOKEN_SYMBOL} from './config';

export const OUTCOME = {None: 0, ToA: 1, ToB: 2, Refund: 3} as const;
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];
export const STATUS = {None: 0, Open: 1, Funded: 2, Settled: 3, Cancelled: 4} as const;

export type EscrowToken = {address: Address; symbol: string; decimals: number};

/** The factory on `network`, or null where escrow is not offered (yet). */
export function escrowFactory(network: Network): Address | null {
  return ESCROW_NETWORKS.includes(network) ? (ESCROW_FACTORY[network] ?? null) : null;
}

export function escrowToken(network: Network): EscrowToken | null {
  const a = ASSETS[network]?.find((x) => x.symbol === ESCROW_TOKEN_SYMBOL);
  return a ? {address: a.address as Address, symbol: a.symbol, decimals: a.decimals} : null;
}

// ---- the deals this phone knows about: made here, or opened by address ----

const store = new MMKV({id: 'bitty.escrows'});
const keyOf = (network: Network) => `deals.${network}`;

export function knownEscrows(network: Network): Address[] {
  try {
    return JSON.parse(store.getString(keyOf(network)) ?? '[]') as Address[];
  } catch {
    return [];
  }
}

export function rememberEscrow(network: Network, escrow: Address): void {
  const list = knownEscrows(network).filter((a) => a.toLowerCase() !== escrow.toLowerCase());
  store.set(keyOf(network), JSON.stringify([escrow, ...list].slice(0, 200)));
}

/**
 * Accounts this phone JOINED: their address typed, pasted or scanned here. With the wallet's own
 * accounts, the only ones History shows: a deal someone else started naming this wallet is never
 * offered, as that is how a scam would reach the user.
 */
const joinedKey = (network: Network) => `joined.${network}`;
export function joinedEscrows(network: Network): Address[] {
  try {
    return JSON.parse(store.getString(joinedKey(network)) ?? '[]') as Address[];
  } catch {
    return [];
  }
}
export function rememberJoined(network: Network, escrow: Address): void {
  const list = joinedEscrows(network).filter((a) => a.toLowerCase() !== escrow.toLowerCase());
  store.set(joinedKey(network), JSON.stringify([escrow, ...list].slice(0, 200)));
}

/** The wallet's own accounts as last read by {myAccounts} (no network call): its account `n` is [n]. */
export function cachedAccounts(network: Network, me: Address): Address[] {
  try {
    return JSON.parse(store.getString(`own.${network}.${me.toLowerCase()}`) ?? '[]') as Address[];
  } catch {
    return [];
  }
}

/** The wallet's own escrow accounts (it started a deal in each): 0 .. accountCount - 1. */
export async function myAccounts(network: Network, me: Address): Promise<Address[]> {
  const factory = escrowFactory(network);
  if (!factory) return [];
  const key = `own.${network}.${me.toLowerCase()}`;
  try {
    const client = publicClientFor(network);
    const count = Number(await client.readContract({address: factory, abi: escrowFactoryAbi, functionName: 'accountCount', args: [me]}));
    const list = await Promise.all(
      Array.from({length: count}, (_, n) => client.readContract({address: factory, abi: escrowFactoryAbi, functionName: 'predictAccount', args: [me, BigInt(n)]}) as Promise<Address>),
    );
    store.set(key, JSON.stringify(list));
    return list;
  } catch {
    // The read failed: the list as last read, so the wallet's own deals do not drop out.
    try {
      return JSON.parse(store.getString(key) ?? '[]') as Address[];
    } catch {
      return [];
    }
  }
}

export function forgetEscrow(network: Network, escrow: Address): void {
  store.set(keyOf(network), JSON.stringify(knownEscrows(network).filter((a) => a.toLowerCase() !== escrow.toLowerCase())));
}

/**
 * Every deal this phone has seen, as last read: an account's next deal replaces the last one on
 * chain, so this is how History keeps the old ones. Newest first; bigints as strings.
 */
const snapKey = (network: Network) => `snaps.${network}`;
export const dealKey = (escrow: Address, dealId: number) => `${escrow.toLowerCase()}#${dealId}`;

type Snap = Omit<Deal, 'amountA' | 'amountB' | 'feeA' | 'feeB'> & {amountA: string; amountB: string; feeA: string; feeB: string};

function readSnaps(network: Network): Snap[] {
  try {
    return JSON.parse(store.getString(snapKey(network)) ?? '[]') as Snap[];
  } catch {
    return [];
  }
}

/** Deals started on this phone and not read yet: their start time, for the first read to keep. */
const startedHere = new Map<string, number>();

const fromSnap = (x: Snap): Deal => ({...x, amountA: BigInt(x.amountA), amountB: BigInt(x.amountB), feeA: BigInt(x.feeA), feeB: BigInt(x.feeB)});

/** Keep `deal` as seen now: replaces the same deal's older copy, or goes first when new. */
export function rememberDeal(network: Network, deal: Deal): void {
  const k = dealKey(deal.address, deal.dealId);
  const here = startedHere.get(k);
  if (here && !deal.startedAt) deal = {...deal, startedAt: here};
  const snap: Snap = {...deal, amountA: String(deal.amountA), amountB: String(deal.amountB), feeA: String(deal.feeA), feeB: String(deal.feeB)};
  const list = readSnaps(network);
  const i = list.findIndex((x) => dealKey(x.address, x.dealId) === k);
  // A fresh read has no start date: keep the one already known.
  if (i >= 0) list[i] = {...snap, startedAt: snap.startedAt ?? list[i].startedAt};
  else list.unshift(snap);
  store.set(snapKey(network), JSON.stringify(list.slice(0, 500)));
}

/** Every deal seen on this phone, newest first, as last read. */
export function knownDeals(network: Network): Deal[] {
  return readSnaps(network).map(fromSnap);
}

/** One deal as last seen, or null. */
export function snapshotOf(network: Network, escrow: Address, dealId: number): Deal | null {
  const k = dealKey(escrow, dealId);
  const x = readSnaps(network).find((s) => dealKey(s.address, s.dealId) === k);
  return x ? fromSnap(x) : null;
}

/**
 * Every deal of this network's factory that `me` is A, B or C in, from the factory's DealStarted
 * events in TronGrid's index, so History survives a reinstall and shows deals someone else started
 * with this wallet. A, B and C are not indexed topics, so the events are paged through (newest
 * first, at most 1,000) and matched here. A deal not seen before is remembered from its event alone,
 * so an older deal in a reused account still shows (its outcome is then unknown). Empty off Tron.
 */
export async function discoverEscrows(network: Network, me: Address, mine: Address[]): Promise<Address[]> {
  const factory = escrowFactory(network);
  if (!factory || !isTronNetwork(network) || !mine.length) return [];
  // Only deals in the wallet's OWN accounts: one someone else started naming this wallet is not
  // offered (see joinedEscrows).
  const own = new Set(mine.map((a) => a.toLowerCase()));
  const {TRON_API} = require('@/tron/config') as typeof import('@/tron/config');
  const {evmToTron, tronToEvm} = require('@/tron/address') as typeof import('@/tron/address');
  const {tronGridGet} = require('@/vault/transactions') as typeof import('@/vault/transactions');
  // TronGrid gives event addresses as 0x hex (20 bytes); base58 is taken too.
  const hex = (x: string): Address => (x.startsWith('T') ? (tronToEvm(x) ?? zeroAddress) : (`0x${x.replace(/^0x/, '').slice(-40)}` as Address));
  const m = me.toLowerCase();
  const found: Address[] = [];
  let url: string | undefined = `${TRON_API[network]}/v1/contracts/${evmToTron(factory)}/events?event_name=DealStarted&limit=200`;
  for (let page = 0; url && page < 5; page++) {
    const res = await tronGridGet(url).catch(() => null);
    if (!res?.ok) break;
    const json = (await res.json()) as {data?: {result?: Record<string, string>}[]; meta?: {links?: {next?: string}}};
    for (const e of json.data ?? []) {
      const r = e.result ?? {};
      if (!r.account || ![r.a, r.b, r.c].some((x) => x && hex(x).toLowerCase() === m)) continue;
      const account = hex(r.account);
      if (!own.has(account.toLowerCase())) continue;
      const dealId = Number(r.dealId);
      const at = (e as {block_timestamp?: number}).block_timestamp;
      if (!found.some((f) => f.toLowerCase() === account.toLowerCase())) found.push(account);
      const known = snapshotOf(network, account, dealId);
      if (known && !known.startedAt && at) rememberDeal(network, {...known, startedAt: at});
      if (!known) {
        // Seen only in its event: the terms, and "over" when the account has moved on (read later).
        rememberDeal(network, {
          address: account, dealId, token: hex(r.token), a: hex(r.a), b: hex(r.b), c: hex(r.c),
          amountA: BigInt(r.amountA ?? 0), amountB: BigInt(r.amountB ?? 0), endTime: Number(r.endTime ?? 0),
          status: STATUS.None, outcome: OUTCOME.None, paidA: false, paidB: false,
          feeA: BigInt(r.feeA ?? 0), feeB: BigInt(r.feeB ?? 0), votes: {a: OUTCOME.None, b: OUTCOME.None, c: OUTCOME.None},
          startedAt: at,
        });
      }
    }
    url = json.meta?.links?.next;
  }
  return found;
}

/**
 * Start dates for remembered deals that have none (one joined by address, say): each such account's
 * own Started events in TronGrid's index, by deal number. Best effort; Tron only.
 */
export async function fillStartDates(network: Network): Promise<void> {
  if (!isTronNetwork(network)) return;
  const {TRON_API} = require('@/tron/config') as typeof import('@/tron/config');
  const {evmToTron} = require('@/tron/address') as typeof import('@/tron/address');
  const {tronGridGet} = require('@/vault/transactions') as typeof import('@/vault/transactions');
  const missing = knownDeals(network).filter((d) => !d.startedAt);
  const accounts = [...new Set(missing.map((d) => d.address.toLowerCase()))];
  for (const a of accounts) {
    const res = await tronGridGet(`${TRON_API[network]}/v1/contracts/${evmToTron(a as Address)}/events?event_name=Started&limit=200`).catch(() => null);
    if (!res?.ok) continue;
    const json = (await res.json()) as {data?: {block_timestamp?: number; result?: Record<string, string>}[]};
    for (const e of json.data ?? []) {
      const d = missing.find((m) => m.address.toLowerCase() === a && m.dealId === Number(e.result?.dealId));
      if (d && e.block_timestamp) rememberDeal(network, {...d, startedAt: e.block_timestamp});
    }
  }
}

/**
 * Whether `address` is an escrow of any Bitty factory on `network`, current or retired.
 *
 * An escrow only counts money that comes in through its own `deposit()`. USDT sent to it by plain
 * transfer is not anyone's deposit, and the contract has no way to give it back — B's 50 USDT on
 * Nile, 2026-11-26. So Send refuses such an address. False when it cannot tell (no factory, a read failing).
 */
export async function isEscrowAddress(network: Network, address: Address): Promise<boolean> {
  const factories = [escrowFactory(network), ...(ESCROW_FACTORIES_RETIRED[network] ?? [])].filter((f): f is Address => !!f);
  const client = publicClientFor(network);
  for (const f of factories) {
    const yes = await client.readContract({address: f, abi: escrowFactoryAbi, functionName: 'isEscrow', args: [address]}).catch(() => false);
    if (yes) return true;
  }
  return false;
}

// ---- reads ----

export type Deal = {
  /** The escrow account the deal is in. */
  address: Address;
  /** The deal's number in its account: 1 for its first. Every call on the deal names it. */
  dealId: number;
  token: Address;
  a: Address;
  b: Address;
  /** The arbiter, always set. */
  c: Address;
  amountA: bigint;
  amountB: bigint;
  /** Unix seconds, 0 for none: the deal cannot settle before it (a decision is still needed). */
  endTime: number;
  status: number;
  outcome: Outcome;
  paidA: boolean;
  paidB: boolean;
  feeA: bigint;
  feeB: bigint;
  votes: {a: Outcome; b: Outcome; c: Outcome};
  /** When the deal started (ms), from its start event; not read from the contract, so kept here. */
  startedAt?: number;
};

/** An account's current deal, read from it; throws when `escrow` is not one of this network's factory's. */
export async function readDeal(network: Network, escrow: Address): Promise<Deal> {
  const factory = escrowFactory(network);
  if (!factory) throw new Error('Escrow is not available on this network');
  const client = publicClientFor(network);
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({address: escrow, abi: escrowAbi, functionName: functionName as never, args: args as never}) as Promise<T>;
  const ok = (await client.readContract({address: factory, abi: escrowFactoryAbi, functionName: 'isEscrow', args: [escrow]})) as boolean;
  if (!ok) throw new Error('Not an escrow made by Bitty');
  const [t, dealId, status, outcome, paidA, paidB, feeA, feeB, votes] = await Promise.all([
    read<{token: Address; a: Address; b: Address; c: Address; amountA: bigint; amountB: bigint; endTime: bigint}>('terms'),
    read<bigint>('dealId'),
    read<number>('status'),
    read<number>('outcome'),
    read<boolean>('paidA'),
    read<boolean>('paidB'),
    read<bigint>('feeA'),
    read<bigint>('feeB'),
    read<{a: number; b: number; c: number}>('votes'),
  ]);
  if (Number(dealId) === 0) throw new Error('This escrow account has no deal yet');
  const deal: Deal = {
    address: escrow,
    dealId: Number(dealId),
    token: t.token,
    a: t.a,
    b: t.b,
    c: t.c,
    amountA: t.amountA,
    amountB: t.amountB,
    endTime: Number(t.endTime),
    status: Number(status),
    outcome: Number(outcome) as Outcome,
    paidA,
    paidB,
    feeA,
    feeB,
    votes: {a: Number(votes.a) as Outcome, b: Number(votes.b) as Outcome, c: Number(votes.c) as Outcome},
  };
  // Kept as seen: once the account takes its next deal, History still has this one.
  rememberDeal(network, deal);
  return deal;
}

export async function owedTo(network: Network, escrow: Address, account: Address): Promise<bigint> {
  return (await publicClientFor(network).readContract({address: escrow, abi: escrowAbi, functionName: 'owed', args: [account]})) as bigint;
}

/**
 * Money in escrow account `escrow` that is no deal's (sent by plain transfer, not deposit), which
 * its owner can send out with `rescue`: the deal's token only while the account is free (its deal
 * over and paid out), less the one base unit the account keeps so its next deposits stay cheap; TRX
 * at any time. `locked` is the token's stray amount the owner must wait for (a deal is still on).
 */
export type Stray = {owner: Address; token: bigint; trx: bigint; locked: boolean};

export async function strayIn(network: Network, deal: Deal): Promise<Stray> {
  const client = publicClientFor(network);
  const {erc20Abi} = require('viem') as typeof import('viem');
  const [owner, reusable, bal, trx, owedA, owedB, feeOwed] = await Promise.all([
    client.readContract({address: deal.address, abi: escrowAbi, functionName: 'owner'}) as Promise<Address>,
    client.readContract({address: deal.address, abi: escrowAbi, functionName: 'reusable'}) as Promise<boolean>,
    client.readContract({address: deal.token, abi: erc20Abi, functionName: 'balanceOf', args: [deal.address]}) as Promise<bigint>,
    client.getBalance({address: deal.address}).catch(() => BigInt(0)),
    owedTo(network, deal.address, deal.a),
    owedTo(network, deal.address, deal.b),
    client.readContract({address: deal.address, abi: escrowAbi, functionName: 'feeOwed'}) as Promise<bigint>,
  ]);
  const one = BigInt(1);
  if (reusable) return {owner, token: bal > one ? bal - one : BigInt(0), trx, locked: false};
  // A deal still holds money: what is beyond its deposits, owed amounts and fee waits for it to end.
  const deposited = (deal.paidA ? deal.amountA : BigInt(0)) + (deal.paidB ? deal.amountB : BigInt(0));
  const held = deal.status === STATUS.Open || deal.status === STATUS.Funded ? deposited : owedA + owedB + feeOwed;
  const extra = bal - held - one;
  return {owner, token: BigInt(0), trx, locked: extra > BigInt(0)};
}

/** The owner sends `amount` of `token` (null: TRX) that is no deal's, out of the account, to `to`. */
export async function rescueFrom(o: {account: Signer; network: Network; escrow: Address; token: Address | null; to: Address; amount: bigint}): Promise<{hash: Hex}> {
  const data = encodeFunctionData({abi: escrowAbi, functionName: 'rescue', args: [o.token ?? zeroAddress, o.to, o.amount]});
  return sendWalletCalls({account: o.account, network: o.network, calls: [{to: o.escrow, data}]});
}

/** The factory's fee rate for new deals, in basis points (20 = 0.2%; the owner can set 0–100). */
export async function feeBps(network: Network): Promise<number | null> {
  const factory = escrowFactory(network);
  if (!factory) return null;
  return Number(await publicClientFor(network).readContract({address: factory, abi: escrowFactoryAbi, functionName: 'feeBps'}));
}

export async function feeFor(network: Network, token: Address, amount: bigint): Promise<bigint> {
  const factory = escrowFactory(network);
  if (!factory || amount <= BigInt(0)) return BigInt(0);
  return (await publicClientFor(network).readContract({address: factory, abi: escrowFactoryAbi, functionName: 'feeFor', args: [token, amount]})) as bigint;
}

/** Who `me` is in `deal`. */
export function roleOf(deal: Deal, me: Address): 'a' | 'b' | 'c' | null {
  const m = me.toLowerCase();
  if (deal.a.toLowerCase() === m) return 'a';
  if (deal.b.toLowerCase() === m) return 'b';
  if (deal.c !== zeroAddress && deal.c.toLowerCase() === m) return 'c';
  return null;
}

export const ended = (deal: Deal, nowSec = Math.floor(Date.now() / 1000)) => deal.endTime !== 0 && nowSec >= deal.endTime;

/**
 * What A and B decide between them, or None, as the contract's `_decided` (escrow d9d06f8) before
 * it turns to C: a side choosing to give everything to the OTHER decides alone (the other can only
 * gain), unless both give everything away, which is no agreement; otherwise A and B agreeing.
 */
export function sidesDecided(deal: Deal): Outcome {
  const {a, b} = deal.votes;
  const aGives = a === OUTCOME.ToB;
  const bGives = b === OUTCOME.ToA;
  if (aGives !== bGives) return aGives ? OUTCOME.ToB : OUTCOME.ToA;
  if (a !== OUTCOME.None && a === b) return a;
  return OUTCOME.None;
}

/** The outcome the deal's votes decide, or None: the two sides' ({sidesDecided}), else the arbiter's. */
export function decided(deal: Deal): Outcome {
  const ab = sidesDecided(deal);
  return ab !== OUTCOME.None ? ab : deal.votes.c;
}

// ---- writes ----

export type NewDeal = {
  token: Address;
  b: Address;
  /** The arbiter: required, and neither A nor B. */
  c: Address;
  amountA: bigint;
  amountB: bigint;
  endTime: number;
};

type Terms = {token: Address; a: Address; b: Address; c: Address; amountA: bigint; amountB: bigint; endTime: bigint};

/** Energy to rent before a deal's transactions: the quote, and the energy they use. */
export type Rent = {quote: import('@/tron/energy-rental').RentQuote; need: number};

/** Tron: rent the energy and wait until it is on the account. Nothing is sent if it does not arrive. */
async function rentFirst(account: Signer, network: Network, rent: Rent): Promise<void> {
  if (!isTronNetwork(network)) return;
  const {evmToTron} = require('@/tron/address') as typeof import('@/tron/address');
  const {freeEnergy, rentEnergy, untilEnergy} = require('@/tron/energy-rental') as typeof import('@/tron/energy-rental');
  const net = network as import('@/tron/config').TronChain;
  const me = evmToTron(account.address);
  const before = await freeEnergy(net, me);
  await rentEnergy({net, account, wallet: me, quote: rent.quote});
  await untilEnergy(net, me, Math.min(rent.need, before + rent.quote.energy));
}

/** What `calls` from `me` would cost, each estimated as sent (the same parts as {estimateDeal}). */
export async function estimateCalls(network: Network, me: Address, calls: WalletCall[]): Promise<DealCost> {
  const price = await publicClientFor(network).getGasPrice();
  const parts = await Promise.all(calls.map((c) => planOwnerTx({network, from: me, to: c.to, data: c.data, value: c.value})));
  const sum = (f: (p: (typeof parts)[number]) => bigint) => parts.reduce((a, p) => a + f(p), BigInt(0));
  return {cost: sum((p) => p.cost), energy: sum((p) => (p.gas * BigInt(3)) / BigInt(4)), bandwidth: sum((p) => p.l1Fee), price, steps: parts.length};
}

/** The vote (choice) on deal `dealId`, as a call: for estimating it before it is sent. */
export const voteCall = (escrow: Address, dealId: number, outcome: Outcome): WalletCall => ({
  to: escrow,
  data: encodeFunctionData({abi: escrowAbi, functionName: 'vote', args: [BigInt(dealId), outcome]}),
});

/**
 * The energy a withdrawal right after a cancel may take: it cannot be simulated before the cancel
 * lands (nothing is owed yet). A USDT transfer out of the account to an address that holds some,
 * and the account's bookkeeping, with margin.
 */
const CLAIM_GAS = BigInt(70_000);

/**
 * What cancelling costs, and, when `withdraw`, taking the canceller's own deposit straight back
 * (budgeted at CLAIM_GAS): an account is only reused once everyone has withdrawn.
 */
export async function estimateCancel(network: Network, me: Address, deal: Deal, withdraw: boolean): Promise<DealCost> {
  const c = await estimateCalls(network, me, [cancelCall(deal.address, deal.dealId)]);
  if (!withdraw) return c;
  const data = encodeFunctionData({abi: escrowAbi, functionName: 'claim', args: [me]});
  const bandwidth = isTronNetwork(network) ? BigInt(((data.length - 2) / 2 + 300) * 1_000) : BigInt(0);
  return {cost: c.cost + CLAIM_GAS * c.price + bandwidth, energy: c.energy + CLAIM_GAS, bandwidth: c.bandwidth + bandwidth, price: c.price, steps: c.steps + 1};
}

/**
 * Cancel deal `dealId`, then, when `withdraw`, send the canceller's own deposit back to it at once,
 * once the cancel has landed: left owed, it would keep the account from being reused.
 */
export async function cancelDeal(o: {account: Signer; network: Network; deal: Deal; withdraw: boolean; rent?: Rent}): Promise<{hash: Hex}> {
  if (o.rent) await rentFirst(o.account, o.network, o.rent);
  const calls: WalletCall[] = [cancelCall(o.deal.address, o.deal.dealId)];
  if (o.withdraw) calls.push({to: o.deal.address, data: encodeFunctionData({abi: escrowAbi, functionName: 'claim', args: [o.account.address]})});
  return sendWalletCalls({account: o.account, network: o.network, calls, useFreeEnergy: !!o.rent});
}

/** Calling off deal `dealId` (open, not fully funded): for estimating it before it is sent. */
export const cancelCall = (escrow: Address, dealId: number): WalletCall => ({
  to: escrow,
  data: encodeFunctionData({abi: escrowAbi, functionName: 'cancel', args: [BigInt(dealId)]}),
});

/**
 * A new deal, ready to send: the account it starts in and the calls that start it. `reused` when
 * that account exists already (its last deal over and paid out): starting there costs about a
 * quarter of a new account's gas, and its deposits less too, as it already holds some of the token.
 */
export type PreparedDeal = {
  escrow: Address;
  n: bigint;
  dealId: number;
  reused: boolean;
  /**
   * The account holds some of the token already, so a deposit into it is the cheaper transfer. Not
   * quite the same as `reused`: since escrow 9c20ce3 a settled or cancelled deal leaves one base
   * unit behind, but an account of an older factory, or one whose only deal took no deposit, can
   * still be empty.
   */
  holds: boolean;
  calls: WalletCall[];
  deposits: boolean;
};

/**
 * The calls that start a deal with `me` as A, in `me`'s first free escrow account (the factory's
 * {freeAccount}: a reused one when any is free, else the next new one), and, when A puts something
 * in, approve and deposit it in the same go. Nothing is sent.
 */
export async function prepareDeal(o: {network: Network; me: Address; deal: NewDeal}): Promise<PreparedDeal> {
  const factory = escrowFactory(o.network);
  if (!factory) throw new Error('Escrow is not available on this network');
  const client = publicClientFor(o.network);
  const d = o.deal;
  const terms: Terms = {token: d.token, a: o.me, b: d.b, c: d.c, amountA: d.amountA, amountB: d.amountB, endTime: BigInt(d.endTime)};
  const [n, escrow] = (await client.readContract({address: factory, abi: escrowFactoryAbi, functionName: 'freeAccount', args: [o.me]})) as [bigint, Address];
  const reused = (await client.readContract({address: factory, abi: escrowFactoryAbi, functionName: 'isEscrow', args: [escrow]})) as boolean;
  const last = reused ? Number(await client.readContract({address: escrow, abi: escrowAbi, functionName: 'dealId'})) : 0;
  const {erc20Abi} = require('viem') as typeof import('viem');
  const holds = reused && ((await client.readContract({address: d.token, abi: erc20Abi, functionName: 'balanceOf', args: [escrow]})) as bigint) > BigInt(0);
  const dealId = last + 1;
  const calls: WalletCall[] = [{to: factory, data: encodeFunctionData({abi: escrowFactoryAbi, functionName: 'startDeal', args: [n, terms]})}];
  const deposits = d.amountA > BigInt(0);
  if (deposits) {
    calls.push(...(await standingApprovalIfNeeded(o.network, o.me, d.token, escrow, d.amountA)));
    calls.push({to: escrow, data: encodeFunctionData({abi: escrowAbi, functionName: 'deposit', args: [BigInt(dealId)]})});
  }
  return {escrow, n, dealId, reused, holds, calls, deposits};
}

/**
 * The energy a deposit into a deal not started yet may take (it cannot be estimated before the deal
 * exists): USDT's transferFrom and the account's bookkeeping, with margin. Into a new account, which
 * holds no USDT yet, the transfer costs about twice as much on Tron; a reused account always keeps
 * one base unit of USDT for exactly this reason.
 */
const DEPOSIT_GAS_NEW = BigInt(130_000);
const DEPOSIT_GAS_REUSED = BigInt(75_000);

/** What a prepared deal's transactions cost, all together. */
export type DealCost = {
  /** The most they may cost in the chain's coin (sun of TRX on Tron), margins included. */
  cost: bigint;
  /** The energy (gas) they are expected to use, without the margin: what a rental must cover. */
  energy: bigint;
  /** Bandwidth (Tron) or L1 fee, summed: charged whether or not the energy is rented. */
  bandwidth: bigint;
  /** The chain's price per unit of energy (sun) or gas (wei). */
  price: bigint;
  steps: number;
};

/**
 * What the prepared deal's transactions may cost: each call estimated as it would be sent, except
 * the deposit into a deal not started yet, budgeted at DEPOSIT_GAS_NEW / _REUSED. Throws when a call
 * that can be estimated would revert.
 */
export async function estimateDeal(o: {network: Network; me: Address; prepared: PreparedDeal}): Promise<DealCost> {
  const client = publicClientFor(o.network);
  const price = await client.getGasPrice();
  const parts = await Promise.all(
    o.prepared.calls.map(async (c) => {
      if (c.to.toLowerCase() === o.prepared.escrow.toLowerCase()) {
        const bandwidth = isTronNetwork(o.network) ? BigInt(((c.data?.length ?? 2) - 2) / 2 + 300) * BigInt(1_000) : BigInt(0);
        const gas = o.prepared.holds ? DEPOSIT_GAS_REUSED : DEPOSIT_GAS_NEW;
        return {cost: gas * price + bandwidth, energy: gas, bandwidth};
      }
      const p = await planOwnerTx({network: o.network, from: o.me, to: c.to, data: c.data, value: c.value});
      // planOwnerTx keeps a third of margin on the estimate (gas = used × 4/3).
      return {cost: p.cost, energy: (p.gas * BigInt(3)) / BigInt(4), bandwidth: p.l1Fee};
    }),
  );
  const sum = (k: 'cost' | 'energy' | 'bandwidth') => parts.reduce((a, x) => a + x[k], BigInt(0));
  return {cost: sum('cost'), energy: sum('energy'), bandwidth: sum('bandwidth'), price, steps: parts.length};
}

/**
 * Send a prepared deal from the wallet, step by step; remembers the escrow on this phone.
 *
 * The create goes first and alone. The deposit is only sent once the escrow's code can be read: a
 * node behind the load balancer can still answer for a block before the create, and to it the
 * escrow is an empty address — Nile then refuses the deposit's estimate as a TRX transfer of zero
 * ("JSON is not a valid request object" / "Amount must be greater than 0").
 */
export async function createDeal(o: {
  account: Signer;
  network: Network;
  prepared: PreparedDeal;
  onStep?: (i: number, n: number) => void;
  /**
   * Tron: rent the deal's energy first (tron/energy-rental), so its transactions spend it instead of
   * burning TRX. `need` is the energy they use; nothing is sent if the rental does not arrive.
   */
  rent?: Rent;
}): Promise<{escrow: Address; dealId: number; hash: Hex}> {
  const {escrow, calls} = o.prepared;
  // With rented energy, each step checks its fee against the energy now on the account.
  const useFreeEnergy = !!o.rent;
  if (o.rent) await rentFirst(o.account, o.network, o.rent);
  rememberEscrow(o.network, escrow);
  const n = calls.length;
  const [create, ...rest] = calls;
  const first = await sendWalletCalls({account: o.account, network: o.network, calls: [create], useFreeEnergy, onStep: (i) => o.onStep?.(i, n)});
  const dealId = o.prepared.dealId;
  // Started now: History shows the date before any index has the event.
  const known = snapshotOf(o.network, escrow, dealId);
  if (known) rememberDeal(o.network, {...known, startedAt: Date.now()});
  else startedHere.set(dealKey(escrow, dealId), Date.now());
  if (!rest.length) return {escrow, dealId, hash: first.hash};
  const client = publicClientFor(o.network);
  const r = await client.waitForTransactionReceipt({hash: first.hash, timeout: 180_000});
  if (r.status !== 'success') throw new Error(`Creating the escrow failed on chain (${first.hash})`);
  try {
    await untilStarted(o.network, escrow, o.prepared.dealId);
    const {hash} = await sendWalletCalls({account: o.account, network: o.network, calls: rest, useFreeEnergy, onStep: (i) => o.onStep?.(i + 1, n)});
    return {escrow, dealId, hash};
  } catch (e) {
    // The escrow exists; only the approval or the deposit did not go. Its page has Deposit.
    throw new DepositPendingError(escrow, dealId, String((e as Error)?.message ?? e));
  }
}

/** The deal was started, but the deposit after it failed: open its page, where Deposit is. */
export class DepositPendingError extends Error {
  constructor(
    readonly escrow: Address,
    readonly dealId: number,
    readonly reason: string,
  ) {
    super(`The escrow was created, but the deposit did not go through (${reason}). Open it and tap Deposit.`);
  }
}

/**
 * Wait (up to a minute) until the node the app reads from shows deal `dealId` in `escrow`: the
 * account's code (a new one) and its deal number. A node behind the load balancer can still answer
 * for a block before the start, and the deposit's estimate would then fail (WrongDeal).
 */
async function untilStarted(network: Network, escrow: Address, dealId: number): Promise<void> {
  const client = publicClientFor(network);
  for (let i = 0; i < 30; i++) {
    const id = await client.readContract({address: escrow, abi: escrowAbi, functionName: 'dealId'}).catch(() => undefined);
    if (id !== undefined && Number(id) >= dealId) return;
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error('The escrow was created, but the node does not show it yet. Open it from Escrow and deposit there.');
}

/**
 * What a deposit into `deal` from `me` costs: the approval when one is missing, then the deposit.
 * Before the approval lands the deposit cannot be simulated (the token would refuse it), so it is
 * then budgeted as at the deal's start: less when the account already holds some of the token.
 */
export async function estimateDeposit(network: Network, me: Address, deal: Deal): Promise<DealCost> {
  const role = roleOf(deal, me);
  const amount = role === 'a' ? deal.amountA : role === 'b' ? deal.amountB : null;
  if (amount === null) throw new Error('Only A or B deposits');
  const approve = await standingApprovalIfNeeded(network, me, deal.token, deal.address, amount);
  const deposit: WalletCall = {to: deal.address, data: encodeFunctionData({abi: escrowAbi, functionName: 'deposit', args: [BigInt(deal.dealId)]})};
  if (!approve.length) return estimateCalls(network, me, [deposit]);
  const client = publicClientFor(network);
  const {erc20Abi} = require('viem') as typeof import('viem');
  const [a, held, price] = await Promise.all([
    estimateCalls(network, me, approve),
    client.readContract({address: deal.token, abi: erc20Abi, functionName: 'balanceOf', args: [deal.address]}) as Promise<bigint>,
    client.getGasPrice(),
  ]);
  const gas = held > BigInt(0) ? DEPOSIT_GAS_REUSED : DEPOSIT_GAS_NEW;
  const bandwidth = isTronNetwork(network) ? BigInt(((deposit.data!.length - 2) / 2 + 300) * 1_000) : BigInt(0);
  return {cost: a.cost + gas * price + bandwidth, energy: a.energy + gas, bandwidth: a.bandwidth + bandwidth, price, steps: a.steps + 1};
}

/** A or B puts in their amount: the approval when it is missing, then the deposit. */
export async function depositToDeal(o: {account: Signer; network: Network; deal: Deal; onStep?: (i: number, n: number) => void; rent?: Rent}): Promise<{hash: Hex}> {
  if (o.rent) await rentFirst(o.account, o.network, o.rent);
  const me = o.account.address;
  const role = roleOf(o.deal, me);
  const amount = role === 'a' ? o.deal.amountA : role === 'b' ? o.deal.amountB : null;
  if (amount === null) throw new Error('Only A or B deposits');
  const calls: WalletCall[] = [
    ...(await standingApprovalIfNeeded(o.network, me, o.deal.token, o.deal.address, amount)),
    {to: o.deal.address, data: encodeFunctionData({abi: escrowAbi, functionName: 'deposit', args: [BigInt(o.deal.dealId)]})},
  ];
  return sendWalletCalls({account: o.account, network: o.network, calls, onStep: o.onStep, useFreeEnergy: !!o.rent});
}

type Action = {kind: 'vote'; outcome: Outcome} | {kind: 'cancel'} | {kind: 'finalize'} | {kind: 'claim'; to: Address};

/** A call on deal `dealId` of account `escrow`: it names the deal, so it can never land on the next one. */
export async function actOnDeal(o: {account: Signer; network: Network; escrow: Address; dealId: number; action: Action; rent?: Rent}): Promise<{hash: Hex}> {
  if (o.rent) await rentFirst(o.account, o.network, o.rent);
  const a = o.action;
  const id = BigInt(o.dealId);
  const data =
    a.kind === 'vote'
      ? encodeFunctionData({abi: escrowAbi, functionName: 'vote', args: [id, a.outcome]})
      : a.kind === 'claim'
        ? encodeFunctionData({abi: escrowAbi, functionName: 'claim', args: [a.to]})
        : encodeFunctionData({abi: escrowAbi, functionName: a.kind, args: [id]});
  return sendWalletCalls({account: o.account, network: o.network, calls: [{to: o.escrow, data}], useFreeEnergy: !!o.rent});
}

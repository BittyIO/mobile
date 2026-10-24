/**
 * Owner risk & controls — the vault's risk surface, plus the locks.
 *
 *  Risk is three numbers, none of which can be lifted:
 *   - timelock: seconds a LOOSENING of anything deferred waits out (tightening is immediate).
 *     1 to 30 days.
 *   - sendDailyAllowance: the ceiling on what regular sends may move per rolling day, in whole USD,
 *     1 to 10,000. Regular sends are held to stablecoins.
 *   - marketTradeDailyLossAllowance: what market trades may lose against oracle value per rolling
 *     day, in whole USD, 1 to 10,000 — a leaked key selling into a pool it set up loses value
 *     without sending anything. Kept apart from the send cap so neither uses up the other.
 *  From vault {ZERO_ALLOWANCE_SINCE} either allowance may also be 0, which turns regular sends or
 *  market trading off; an older vault refuses 0. A vault that never set one reads 1 day and 10,000
 *  (see {RISK_BOUNDS}); the contract refuses anything outside the bounds.
 *  Each setter writes only its field (the others go in as UNCHANGED = type(uint256).max).
 *
 *  The locks, which the risk numbers exist to serve:
 *   - emergencyLock(): freeze the risk surface where it stands. Instant, reversible. For the moment
 *     the owner believes the key is in someone else's hands: money then reaches only what was
 *     vetted before, and nothing can be reconfigured in either direction.
 *   - unlock(): release an emergency lock. Instant — a delayed release just locks the owner out.
 *   - foreverLock(escapeRecipientId): the same freeze with no way back, by any key, ever. The answer
 *     to a key that is gone rather than merely suspect. Afterwards a whitelisted recipient is the
 *     only way money leaves, so it names one the vault can pay right now and is refused without.
 *
 * All relayed & gasless, Face-ID-gated at signing.
 */
import type {Address, Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {useCallback, useState} from 'react';
import {useFocusEffect} from '@react-navigation/native';
import {VAULT_RISK_ABI, WHITELIST_STATUS} from '@/core/abi';
import {runningVaultVersion} from './vault-abi';
import {relayVaultWrite} from './relay';
import {fetchWhitelist} from './payments';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

/** Leave a RiskSettings field untouched. */
const UNCHANGED = (1n << 256n) - 1n; // type(uint256).max

/**
 * What the vault accepts for each risk number (MIN_RISK_TIMELOCK, MAX_RISK_TIMELOCK and the two
 * MAX_*_DAILY_*_ALLOWANCE constants in the vault).
 */
export const RISK_BOUNDS: Record<'timelock' | 'sendDailyAllowance' | 'marketTradeDailyLossAllowance', {min: bigint; max: bigint}> = {
  timelock: {min: 86_400n, max: 30n * 86_400n},
  sendDailyAllowance: {min: 1n, max: 10_000n},
  marketTradeDailyLossAllowance: {min: 1n, max: 10_000n},
};

/** The first vault release that accepts an allowance of 0 (regular sends or market trading off). */
export const ZERO_ALLOWANCE_SINCE = '1.0.5';

/** Whether a vault on `version` accepts an allowance of 0. */
export function allowsZeroAllowance(version: string | null): boolean {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = ZERO_ALLOWANCE_SINCE.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  return true;
}

export type RiskConfig = {
  /** False for an un-activated vault or a failed read: every number is then 0 and means nothing. */
  read: boolean;
  timelock: bigint; // seconds
  /** Whole USD regular sends may move per day; 0 = regular sends are off. */
  sendDailyAllowance: bigint;
  /** Whole USD market trades may lose against oracle value per day; 0 = market trading is off. */
  marketTradeDailyLossAllowance: bigint;
  /**
   * A loosening still waiting out the timelock: the value it will take and when (unix seconds).
   * A tightening never waits, so it never shows here.
   */
  pending: Partial<Record<RiskField, {value: bigint; at: bigint}>>;
};

/** 0 unlocked, 1 emergency locked, 2 locked for ever — the contract's own numbering. */
export type LockLevel = 0 | 1 | 2;

const zeroRisk = (): RiskConfig => ({read: false, timelock: 0n, sendDailyAllowance: 0n, marketTradeDailyLossAllowance: 0n, pending: {}});

/** The risk numbers in force. Zeros for an un-activated vault or a failed read. */
export async function getRiskConfig(vault: Address, network: Network): Promise<RiskConfig> {
  try {
    const client = publicClientFor(network);
    const [[timelock, sendDailyAllowance, marketTradeDailyLossAllowance], changes] = await Promise.all([
      client.readContract({address: vault, abi: VAULT_RISK_ABI, functionName: 'riskSettings'}),
      // The pending read is extra information, never a reason to show nothing.
      client.readContract({address: vault, abi: VAULT_RISK_ABI, functionName: 'pendingChanges'}).catch(() => null),
    ]);
    const pending: RiskConfig['pending'] = {};
    if (changes?.timelockAt) pending.timelock = {value: changes.timelock, at: changes.timelockAt};
    if (changes?.sendDailyAllowanceAt) pending.sendDailyAllowance = {value: changes.sendDailyAllowance, at: changes.sendDailyAllowanceAt};
    if (changes?.marketTradeDailyLossAllowanceAt)
      pending.marketTradeDailyLossAllowance = {value: changes.marketTradeDailyLossAllowance, at: changes.marketTradeDailyLossAllowanceAt};
    return {read: true, timelock, sendDailyAllowance, marketTradeDailyLossAllowance, pending};
  } catch {
    return zeroRisk();
  }
}

/**
 * What the owner has turned off by setting an allowance to 0: regular sends, market trading. Read
 * from the vault on every focus, so a change made on another device shows on return. Both false
 * until the read lands, or when it fails — the vault still refuses what is off.
 */
export function useAllowancesOff(vault: Address | null | undefined, network: Network) {
  const [off, setOff] = useState({sends: false, marketTrades: false});
  useFocusEffect(
    useCallback(() => {
      if (!vault) return setOff({sends: false, marketTrades: false});
      let live = true;
      getRiskConfig(vault, network).then((r) => {
        if (live && r.read) setOff({sends: r.sendDailyAllowance === 0n, marketTrades: r.marketTradeDailyLossAllowance === 0n});
      });
      return () => {
        live = false;
      };
    }, [vault, network]),
  );
  return off;
}

/** Whether the vault accepts an allowance of 0, from its running version. False until known. */
export function useAllowsZeroAllowance(vault: Address | null | undefined, network: Network): boolean {
  const [ok, setOk] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (!vault) return setOk(false);
      let live = true;
      runningVaultVersion(vault, network).then((v) => live && setOk(allowsZeroAllowance(v)));
      return () => {
        live = false;
      };
    }, [vault, network]),
  );
  return ok;
}

/** The lock level. 0 on a failed read — the screen then simply offers the unlocked controls. */
export async function getLockLevel(vault: Address, network: Network): Promise<LockLevel> {
  try {
    const client = publicClientFor(network);
    const level = (await client.readContract({
      address: vault,
      abi: VAULT_RISK_ABI,
      functionName: 'lockLevel',
    })) as number;
    return (level === 1 || level === 2 ? level : 0) as LockLevel;
  } catch {
    return 0;
  }
}

export type RiskField = 'timelock' | 'sendDailyAllowance' | 'marketTradeDailyLossAllowance';

/** New values for some risk fields; a field left out stays as it is. */
export type RiskChanges = Partial<Record<RiskField, bigint>>;

/**
 * Write every changed risk field in ONE transaction — one Face ID, one fee — leaving the rest
 * UNCHANGED. Tightenings apply at once and loosenings wait out the timelock, field by field, exactly
 * as separate writes would; batching changes nothing on chain but the count.
 */
export async function updateRiskSettings(o: {
  account: Acct;
  vault: Address;
  network: Network;
  changes: RiskChanges;
  stableCoin: Address;
}): Promise<Hex> {
  const v = (f: RiskField) => o.changes[f] ?? UNCHANGED;
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName: 'updateRisk',
    args: [
      {
        timelock: v('timelock'),
        sendDailyAllowance: v('sendDailyAllowance'),
        marketTradeDailyLossAllowance: v('marketTradeDailyLossAllowance'),
      },
    ],
    stableCoin: o.stableCoin,
  });
  return hash;
}

type LockArgs = {account: Acct; vault: Address; network: Network; stableCoin: Address};

const lockWrite = async (
  o: LockArgs,
  functionName: 'emergencyLock' | 'unlock' | 'foreverLock',
  args: readonly unknown[] = [],
): Promise<Hex> => {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName,
    args,
    stableCoin: o.stableCoin,
  });
  return hash;
};

/** Freeze the vault's risk surface where it stands. Instant and reversible. */
export const emergencyLock = (o: LockArgs) => lockWrite(o, 'emergencyLock');
/** Release an emergency lock. Refused once locked for ever. */
export const unlockVault = (o: LockArgs) => lockWrite(o, 'unlock');
/**
 * Freeze the vault's risk surface for good. There is no way back, by any key, ever.
 * `escapeRecipientId` is the whitelisted entry money can still leave through — see {fetchEscapeIds}.
 */
export const foreverLock = (o: LockArgs & {escapeRecipientId: string}) =>
  lockWrite(o, 'foreverLock', [BigInt(o.escapeRecipientId)]);

/** Wrap native ETH the vault holds into WETH. */
export async function wrapNative(o: {
  account: Acct;
  vault: Address;
  network: Network;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName: 'wrapNative',
    args: [],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Sweep an asset's idle balance into its configured auto-yield route now. */
export async function triggerAutoYield(o: {
  account: Acct;
  vault: Address;
  network: Network;
  asset: Address;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName: 'autoYield',
    args: [o.asset],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/**
 * One change the vault has been told to make and has not made yet — the thing a leaked key would
 * queue, and the owner has until `at` to notice and lock against.
 */
export type PendingChange =
  | {kind: RiskField | 'gasBudgetDaily' | 'maxFeePerOp'; value: bigint; at: bigint}
  | {kind: 'newOwner'; address: Address; at: bigint}
  | {kind: 'newAssetManager'; address: Address; perms: number; at: bigint}
  | {kind: 'whitelistAdd' | 'whitelistRemove'; address: Address; at: bigint; id: string};

/**
 * Everything in flight, soonest first: the vault's own `pendingChanges()` slot read, plus the address
 * book entries still maturing or queued for removal, which the contract leaves out of that read and
 * reports per entry. Empty on any failed read.
 */
export async function getPendingChanges(vault: Address, network: Network): Promise<PendingChange[]> {
  const [p, book] = await Promise.all([
    publicClientFor(network)
      .readContract({address: vault, abi: VAULT_RISK_ABI, functionName: 'pendingChanges'})
      .catch(() => null),
    fetchWhitelist(vault, network),
  ]);
  const out: PendingChange[] = [];
  if (p) {
    for (const k of ['timelock', 'sendDailyAllowance', 'marketTradeDailyLossAllowance', 'gasBudgetDaily', 'maxFeePerOp'] as const) {
      const at = p[`${k}At`];
      if (at) out.push({kind: k, value: p[k], at});
    }
    if (p.newOwnerReadyAt) out.push({kind: 'newOwner', address: p.newOwner, at: p.newOwnerReadyAt});
    if (p.newAssetManagerAt)
      out.push({kind: 'newAssetManager', address: p.newAssetManager, perms: p.newAssetManagerPerms, at: p.newAssetManagerAt});
  }
  for (const e of book) {
    if (e.status === WHITELIST_STATUS.pending && e.effectiveAt)
      out.push({kind: 'whitelistAdd', address: e.recipientAddress as Address, at: BigInt(e.effectiveAt), id: e.id});
    if (e.status === WHITELIST_STATUS.removalQueued && e.removeAt)
      out.push({kind: 'whitelistRemove', address: e.recipientAddress as Address, at: BigInt(e.removeAt), id: e.id});
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

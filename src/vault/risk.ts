/**
 * Owner risk & controls — the vault's risk surface, plus the locks.
 *
 *  Risk is three numbers on v1.0.0 (v1.0.3 had four):
 *   - timelock: seconds a LOOSENING of anything deferred waits out (tightening is immediate).
 *   - sendDailyAllowance: the ceiling on what regular sends may move per rolling day, in whole USD.
 *     0 = no cap; above 0, regular sends are held to stablecoins.
 *   - marketTradeDailyLossAllowance: what market trades may lose against oracle value per rolling
 *     day, in whole USD — a leaked key selling into a pool it set up loses value without sending
 *     anything. 0 = unprotected. Kept apart from the send cap so neither uses up the other.
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
 * The v1.0.3 generation keeps the old four-field `PaymentRisk` surface, with no locks and no
 * market-trade protection. Two numbers map onto it (`timelock` = `changeTimelock`, the send cap =
 * `maxSendValue`, in stablecoin tokens per `maxSendInterval`); `hasLocks` tells the screen what to
 * leave out. Which surface applies is the GENERATION's call, not the version's: a v1.0.0 vault
 * reports a lower version than a v1.0.3 one.
 *
 * All relayed & gasless, Face-ID-gated at signing.
 */
import type {Address, Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_RISK_ABI, VAULT_RISK_V103_ABI} from '@/core/abi';
import {isLegacy} from '@/core/vault-generation';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

/** Leave a RiskSettings field untouched. */
const UNCHANGED = (1n << 256n) - 1n; // type(uint256).max

export type RiskConfig = {
  timelock: bigint; // seconds
  /** Whole USD regular sends may move per day, 0 = no cap. On v1.0.3: stablecoin tokens per `window`. */
  sendDailyAllowance: bigint;
  /** Whole USD market trades may lose against oracle value per day, 0 = unprotected. Always 0 on v1.0.3. */
  marketTradeDailyLossAllowance: bigint;
  /** Seconds the send cap covers: a day on v1.0.0; v1.0.3's owner-set `maxSendInterval`. */
  window: bigint;
  /** v1.0.0: emergency / forever lock and the market-trade allowance exist. False on v1.0.3. */
  hasLocks: boolean;
  /**
   * A loosening still waiting out the timelock: the value it will take and when (unix seconds).
   * Only v1.0.0 reports these; a tightening never waits, so it never shows here.
   */
  pending: Partial<Record<RiskField, {value: bigint; at: bigint}>>;
};

const DAY = 86400n;

/** 0 unlocked, 1 emergency locked, 2 locked for ever — the contract's own numbering. */
export type LockLevel = 0 | 1 | 2;

/** Zeros, shaped for the generation — the screen decides what to render from `hasLocks`. */
const zeroRisk = (): RiskConfig => ({timelock: 0n, sendDailyAllowance: 0n, marketTradeDailyLossAllowance: 0n, window: DAY, hasLocks: !isLegacy(), pending: {}});

/** The risk numbers in force. Zeros for an un-activated vault or a failed read. */
export async function getRiskConfig(vault: Address, network: Network): Promise<RiskConfig> {
  try {
    const client = publicClientFor(network);
    if (isLegacy()) {
      const [, maxSendValue, changeTimelock, maxSendInterval] = await client.readContract({
        address: vault,
        abi: VAULT_RISK_V103_ABI,
        functionName: 'getRiskConfig',
      });
      return {
        timelock: changeTimelock,
        sendDailyAllowance: maxSendValue,
        marketTradeDailyLossAllowance: 0n,
        window: maxSendInterval,
        hasLocks: false, pending: {}};
    }
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
    return {timelock, sendDailyAllowance, marketTradeDailyLossAllowance, window: DAY, hasLocks: true, pending};
  } catch {
    return zeroRisk();
  }
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

/** Write a single risk field, leaving the others UNCHANGED. */
async function writeRiskField(o: {
  account: Acct;
  vault: Address;
  network: Network;
  field: RiskField;
  value: bigint;
  stableCoin: Address;
}): Promise<Hex> {
  if (isLegacy()) {
    if (o.field === 'marketTradeDailyLossAllowance') throw new Error('v1.0.3 vaults have no market-trade allowance');
    const {hash} = await relayVaultWrite({
      account: o.account,
      vault: o.vault,
      network: o.network,
      abi: VAULT_RISK_V103_ABI,
      functionName: 'updatePaymentRisk',
      args: [
        {
          newPaymentProtection: UNCHANGED,
          maxSendValue: o.field === 'sendDailyAllowance' ? o.value : UNCHANGED,
          maxSendInterval: UNCHANGED,
          changeTimelock: o.field === 'timelock' ? o.value : UNCHANGED,
        },
      ],
      stableCoin: o.stableCoin,
    });
    return hash;
  }
  const update = {
    timelock: o.field === 'timelock' ? o.value : UNCHANGED,
    sendDailyAllowance: o.field === 'sendDailyAllowance' ? o.value : UNCHANGED,
    marketTradeDailyLossAllowance: o.field === 'marketTradeDailyLossAllowance' ? o.value : UNCHANGED,
  };
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_RISK_ABI,
    functionName: 'updateRisk',
    args: [update],
    stableCoin: o.stableCoin,
  });
  return hash;
}

type FieldArgs = {account: Acct; vault: Address; network: Network; value: bigint; stableCoin: Address};

/** Delay (seconds) a loosening of any control must wait. Higher = safer, applies at once. */
export const setRiskTimelock = (o: FieldArgs) => writeRiskField({...o, field: 'timelock'});
/** Daily send ceiling in whole USD (0 = no cap). Lower = safer, applies at once. */
export const setSendDailyAllowance = (o: FieldArgs) => writeRiskField({...o, field: 'sendDailyAllowance'});
/** Daily market-trade loss ceiling in whole USD (0 = unprotected). v1.0.0 only. Lower = safer, applies at once. */
export const setMarketTradeDailyLossAllowance = (o: FieldArgs) => writeRiskField({...o, field: 'marketTradeDailyLossAllowance'});

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

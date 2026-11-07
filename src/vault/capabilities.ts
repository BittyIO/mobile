// What the vault will accept right now, asked BEFORE a transaction is built, so a screen can grey a
// control out and say why instead of letting the contract revert.
//
// The rules mirror the vault's own gates (BittyV1Vault, BittyV1VaultDeFiFacet, LockLib): the lock,
// who is asking, and the two risk allowances that can turn a feature off. The contract stays the
// authority — this is the same table read early, so a rule here that is looser than the vault only
// costs a revert, and one that is tighter wrongly blocks the user. Keep it exact.
//
// Kept free of imports, and written only in type syntax Node can strip, so the table test runs with
// plain `node --test` (test/capabilities.test.mjs). The same rules as web's src/lib/vault-capabilities.ts,
// line for line: change one, change the other, and the table test in each says whether they agree.

/** 0 unlocked, 1 the emergency lock (the owner can release it), 2 the forever lock. */
export type LockLevel = 0 | 1 | 2;

/** The vault's PERM_* bits, as an asset manager is granted them. */
export const PERM_YIELD = 1 << 0;
export const PERM_SUPPLY = 1 << 1;
export const PERM_MARKET_TRADE = 1 << 2;
export const PERM_INTENT = 1 << 3;

/**
 * The first vault release whose gates are tighter, in three places: a manager takes a position out
 * only with the bit that put it in (PERM_YIELD for staking, PERM_SUPPLY for lending), cancels an
 * intent order only with PERM_INTENT, and the allow-list switch is frozen under a lock in both
 * directions. An older vault keeps the looser rules, which is also what an unknown release reads as.
 */
export const STRICT_GATES_SINCE = '1.0.6';

/**
 * The first vault release with 1.0.7's lock rules: a lock leaves the asset manager's grant dormant,
 * so a manager may do nothing at all on a locked vault, and the owner may still sell a non-stablecoin
 * into a stablecoin at market (marketSell only), so an asset the escape address cannot take is not
 * stranded. Older vaults refuse every market trade under a lock and let the manager unwind.
 */
export const LOCKED_SALE_SINCE = '1.0.7';

/** Whether `version` ("1.0.6") is `since` or later. Unknown (null) is not. */
export function versionAtLeast(version: string | null | undefined, since: string): boolean {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = since.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  return true;
}

export type VaultAction =
  // DeFi
  | 'deposit'
  | 'withdraw'
  | 'claimWithdrawal'
  | 'autoYield'
  | 'setAutoYielding'
  | 'marketTrade'
  | 'placeIntentOrder'
  | 'approveIntentSpender'
  | 'cancelIntentOrder'
  // Money out
  | 'send'
  | 'sendToWhitelistedRecipient'
  | 'addWhitelistedRecipient'
  | 'removeWhitelistedRecipient'
  | 'retrieve721'
  // Configuration
  | 'updateRisk'
  | 'setTokenAsGas'
  | 'setAssetManager'
  | 'transferOwnership'
  | 'updateAllowList'
  | 'useBittyAllowList'
  | 'setAutoYieldTrigger'
  | 'upgradeVault'
  | 'upgradeProtocol'
  // Locks
  | 'emergencyLock'
  | 'unlock'
  | 'foreverLock'
  // The relayer charging the vault for gas
  | 'relayGas';

/**
 * Why an action is refused. Each one is a translation key under `vault.gate.` — the same strings in
 * web and mobile, since mobile reads web's catalogue.
 */
export type GateReason =
  | 'locked_temp'
  | 'locked_forever'
  | 'not_locked'
  | 'stablecoin_buy_only'
  | 'stablecoin_sale_only'
  | 'send_allowance_off'
  | 'market_trade_off'
  | 'owner_only'
  | 'no_permission';

export type Gate = {allowed: true} | {allowed: false; reason: GateReason};

/**
 * What the gates depend on. Anything not known yet is left undefined/null and reads as allowed:
 * the contract still refuses what it must, and a control that flickers disabled while a read is in
 * flight is worse than one revert.
 */
export interface VaultGateState {
  lockLevel: LockLevel | null;
  /** The connected wallet's standing in this vault. Null while unknown. */
  role: 'owner' | 'assetManager' | 'none' | null;
  /** The live asset manager grant's PERM_* bits; read only when `role` is "assetManager". */
  managerPermissions?: number;
  /** The send daily allowance is set to 0: regular sends are off. */
  sendAllowanceOff?: boolean;
  /** The market-trade daily loss allowance is set to 0: market trading is off. */
  marketTradeOff?: boolean;
  /** The vault's release ("1.0.6"), which picks the rules — see {STRICT_GATES_SINCE}. */
  vaultVersion?: string | null;
}

export interface GateOptions {
  /**
   * deposit (and, from 1.0.6, withdraw / claimWithdrawal): the protocol stakes (needs PERM_YIELD)
   * rather than supplies (PERM_SUPPLY).
   */
  staking?: boolean;
  /**
   * placeIntentOrder and marketTrade: the order or trade buys an allowed stablecoin. Unknown reads
   * as allowed.
   */
  buysStablecoin?: boolean;
  /** marketTrade: the trade sells a stablecoin. Unknown reads as allowed. */
  sellsStablecoin?: boolean;
}

const ALLOWED: Gate = {allowed: true};
const refuse = (reason: GateReason): Gate => ({allowed: false, reason});

/**
 * Who may call it: the owner alone, or also a manager holding `perm` (0 = any live manager). Up to
 * 1.0.5; STRICT_MANAGER_PERMISSION overrides it from 1.0.6.
 */
const MANAGER_PERMISSION: Partial<Record<VaultAction, number>> = {
  withdraw: 0,
  claimWithdrawal: 0,
  cancelIntentOrder: 0,
  marketTrade: PERM_MARKET_TRADE,
  placeIntentOrder: PERM_INTENT,
  approveIntentSpender: PERM_INTENT,
};

/** From 1.0.6 no unwind is free: cancelling needs PERM_INTENT (exits are sized by `staking`). */
const STRICT_MANAGER_PERMISSION: Partial<Record<VaultAction, number>> = {
  cancelIntentOrder: PERM_INTENT,
};

/** Positions in or out, from 1.0.6: the bit for the protocol's kind. */
const POSITION_ACTIONS = new Set<VaultAction>([
  'deposit',
  'withdraw',
  'claimWithdrawal',
]);

const strict = (state: VaultGateState) =>
  versionAtLeast(state.vaultVersion, STRICT_GATES_SINCE);

const lockedSale = (state: VaultGateState) =>
  versionAtLeast(state.vaultVersion, LOCKED_SALE_SINCE);

/** Still open under either lock: value coming home, and the ways out the owner drew in advance. */
const OPEN_WHILE_LOCKED = new Set<VaultAction>([
  'withdraw',
  'claimWithdrawal',
  'approveIntentSpender',
  'sendToWhitelistedRecipient',
  // Up to 1.0.5 only (back to Bitty's list; leaving it is updateAllowList). From 1.0.6 the switch is
  // frozen under a lock in both directions.
  'useBittyAllowList',
]);

/** Not the connected wallet's to call: the relayer is checked by the vault, not by role. */
const NO_ROLE_CHECK = new Set<VaultAction>(['relayGas']);

export function capability(
  action: VaultAction,
  state: VaultGateState,
  opts: GateOptions = {},
): Gate {
  const level = state.lockLevel ?? 0;
  const lockReason: GateReason = level === 2 ? 'locked_forever' : 'locked_temp';

  // From 1.0.7 a lock leaves the manager's grant dormant: nothing is the manager's to do.
  if (
    level !== 0 &&
    state.role === 'assetManager' &&
    lockedSale(state) &&
    !NO_ROLE_CHECK.has(action)
  )
    return refuse(lockReason);

  const roleGate = checkRole(action, state, opts);
  if (!roleGate.allowed) return roleGate;

  switch (action) {
    case 'emergencyLock':
      return level === 0 ? ALLOWED : refuse(lockReason);
    case 'unlock':
      return level === 1
        ? ALLOWED
        : refuse(level === 2 ? 'locked_forever' : 'not_locked');
    case 'foreverLock':
      return level === 2 ? refuse('locked_forever') : ALLOWED;
    case 'relayGas':
      // The emergency lock still lets the relayer take its fee; the forever lock does not.
      return level === 2 ? refuse('locked_forever') : ALLOWED;
    case 'marketTrade':
      if (level === 0) break;
      // From 1.0.7 the owner may still sell a non-stablecoin into a stablecoin; nothing else trades.
      if (!lockedSale(state)) return refuse(lockReason);
      if (opts.sellsStablecoin === true || opts.buysStablecoin === false)
        return refuse('stablecoin_sale_only');
      return state.marketTradeOff ? refuse('market_trade_off') : ALLOWED;
    case 'placeIntentOrder':
      // Checked when the order FILLS: a locked vault fills only orders that buy a stablecoin.
      return level !== 0 && opts.buysStablecoin === false
        ? refuse('stablecoin_buy_only')
        : ALLOWED;
  }

  if (
    level !== 0 &&
    (!OPEN_WHILE_LOCKED.has(action) ||
      (action === 'useBittyAllowList' && strict(state)))
  )
    return refuse(lockReason);

  if (action === 'send' && state.sendAllowanceOff)
    return refuse('send_allowance_off');
  if (action === 'marketTrade' && state.marketTradeOff)
    return refuse('market_trade_off');
  return ALLOWED;
}

function checkRole(
  action: VaultAction,
  state: VaultGateState,
  opts: GateOptions,
): Gate {
  if (state.role === null || state.role === 'owner') return ALLOWED;
  if (NO_ROLE_CHECK.has(action)) return ALLOWED;
  const strictGates = strict(state);
  const perm =
    action === 'deposit' || (strictGates && POSITION_ACTIONS.has(action))
      ? opts.staking
        ? PERM_YIELD
        : PERM_SUPPLY
      : ((strictGates ? STRICT_MANAGER_PERMISSION[action] : undefined) ??
        MANAGER_PERMISSION[action]);
  if (perm === undefined) return refuse('owner_only');
  if (state.role !== 'assetManager') return refuse('no_permission');
  if (perm === 0) return ALLOWED;
  return ((state.managerPermissions ?? 0) & perm) === perm
    ? ALLOWED
    : refuse('no_permission');
}

/**
 * The action a vault function performs, for the check just before a write is sent. Only functions
 * the lock or an allowance can refuse are listed; anything else is sent unchecked.
 */
export const ACTION_FOR_FUNCTION: Record<string, VaultAction> = {
  deposit: 'deposit',
  autoYield: 'autoYield',
  autoYields: 'autoYield',
  setAutoYielding: 'setAutoYielding',
  setAutoYieldings: 'setAutoYielding',
  marketSell: 'marketTrade',
  marketBuy: 'marketTrade',
  cancelIntentOrder: 'cancelIntentOrder',
  cancelIntentOrders: 'cancelIntentOrder',
  send: 'send',
  batchSend: 'send',
  sendAndAddWhitelistedRecipient: 'send',
  batchSendAndAddWhitelistedRecipient: 'send',
  addWhitelistedRecipient: 'addWhitelistedRecipient',
  removeWhitelistedRecipients: 'removeWhitelistedRecipient',
  retrieve721: 'retrieve721',
  updateRisk: 'updateRisk',
  setTokenAsGas: 'setTokenAsGas',
  disableTokenAsGas: 'setTokenAsGas',
  setStableCoinAsGas: 'setTokenAsGas',
  disableStableCoinAsGas: 'setTokenAsGas',
  setGasless: 'setTokenAsGas',
  disableGasless: 'setTokenAsGas',
  setAssetManager: 'setAssetManager',
  transferOwnership: 'transferOwnership',
  updateProtocols: 'updateAllowList',
  updateAssets: 'updateAllowList',
  setAutoYieldTrigger: 'setAutoYieldTrigger',
  upgrade: 'upgradeVault',
  upgradeProtocol: 'upgradeProtocol',
  emergencyLock: 'emergencyLock',
  unlock: 'unlock',
  foreverLock: 'foreverLock',
};

/**
 * The sentence for a vault revert, by error name, as a key under `vault.gate.`. The last word when
 * the early check did not catch it: a lock made on another device, an allowance spent elsewhere.
 */
export const REVERT_REASON: Record<string, string> = {
  VaultLocked: 'err_vault_locked',
  PaymentNotStableCoin: 'err_payment_not_stable',
  PaymentExceedsPeriodLimit: 'err_send_limit',
  PaymentExceedsRiskCap: 'err_send_limit',
  MarketTradeExceedsDailyLossAllowance: 'err_market_loss',
  MarketTradePriceTooLow: 'err_pool_price',
  InsufficientOutput: 'err_market_price',
  Deprecated: 'err_deprecated',
  ProtocolNotNewer: 'err_not_newer',
  VaultNotNewer: 'err_not_newer',
  OwnableUnauthorizedAccount: 'err_unauthorized',
  NotRegistered: 'err_not_registered',
  ProtectionPeriodNotEnded: 'err_recipient_waiting',
  NoEscapeRecipient: 'err_no_escape',
  GasBudgetExceeded: 'err_gas_budget',
  PriceStale: 'err_price_unavailable',
  PriceFeedMissing: 'err_price_unavailable',
  SequencerDown: 'err_price_unavailable',
};

/** The error names in REVERT_REASON with their argument types, for selector matching. */
export const REVERT_SIGNATURES: string[] = Object.keys(REVERT_REASON).map(
  (name) =>
    name === 'PriceStale' || name === 'PriceFeedMissing'
      ? `${name}(address)`
      : name === 'OwnableUnauthorizedAccount'
        ? `${name}(address)`
        : `${name}()`,
);

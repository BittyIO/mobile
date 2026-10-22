import {parseAbi} from 'viem';

/** vault.trustedForwarder() — the forwarder a signed ForwardRequest must target (frozen at init). */
export const VAULT_FWD_ABI = parseAbi([
  'function trustedForwarder() view returns (address)',
]);

/**
 * forwarder.nonceFor(signer, target) — per-(signer, target) nonce LANE. The forwarder's EIP-712 digest
 * hashes nonceFor(from, to), NOT the inherited OZ nonces(from), so the signed nonce must come from here.
 */
export const FORWARDER_ABI = parseAbi([
  'function nonceFor(address signer, address target) view returns (uint64)',
]);

/**
 * The forwarder's own entry points, for READING a relayed transaction back.
 *
 * The app never calls these — the relayer does — but a transaction the relayer sent has one of them
 * as its input, and the signed request inside carries the vault call. That is how a FAILED operation
 * can still be described: reverting destroys the effects, not the calldata. See {decodeFailedTrade}.
 */
export const FORWARDER_EXEC_ABI = parseAbi([
  'function executeWithFee((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature) request, address stableCoinAddress, uint256 fee)',
  'function executeBatchWithFee((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature)[] requests, address vault, address stableCoinAddress, uint256 fee)',
]);

/**
 * Asset / protocol allowlist management + upgrades (v1.0.x). `updateAssets`/`updateProtocols` add/remove
 * from the vault's allowlist; enable/disableAllowlist toggles restricted mode; `upgrade` UUPS-upgrades
 * the vault; `upgradeProtocol` upgrades an adapter clone in place (same lineage, strictly newer).
 */
export const VAULT_MANAGE_ABI = parseAbi([
  'function updateAssets(address[] addAssets,address[] removeAssets)',
  'function updateProtocols(address[] addProtocols,address[] removeProtocols)',
  'function enableAllowlist()',
  'function disableAllowlist()',
  'function allowlistEnabled() view returns (bool)',
  'function isAssetAllowed(address assetAddress) view returns (bool)',
  'function isProtocolAllowed(address protocol) view returns (bool)',
  'function upgrade(address newImpl)',
]);

/**
 * v1.0.0 ownership handover. `transferOwnership` queues it behind the risk timelock; once the wait
 * is over `owner()` already answers the new key. The current owner can cancel until then.
 */
export const VAULT_OWNERSHIP_ABI = parseAbi([
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function cancelOwnershipTransfer()',
]);

/**
 * v1.0.0's allow-list switch, named for the list a vault USES rather than whether it is restricted:
 * `useBittyAllowList(true)` is the old `disableAllowlist`, `false` the old `enableAllowlist`, and
 * `usingBittyAllowList()` is `!allowlistEnabled()`.
 */
export const VAULT_ALLOWLIST_V2_ABI = parseAbi([
  'function useBittyAllowList(bool use)',
  'function usingBittyAllowList() view returns (bool)',
]);

/** Guard reads for the upgrade target — the current build new vaults are activated on, per category. */
export const GUARD_IMPL_ABI = parseAbi([
  'function latestImplementation(uint8 category) view returns (address)',
]);

/** Adapter identity — same lineage + strictly newer version is what the vault's upgradeProtocol requires. */
export const ADAPTER_ABI = parseAbi([
  'function protocolLineage() view returns (bytes32)',
  'function protocolVersion() view returns (uint256)',
]);

/** In-place adapter upgrade: move the per-vault clone to a newer impl of the SAME lineage, then swap the
 *  allowlist registration — bundled in one multicall so a restricted vault's routing keeps working. */
export const VAULT_UPGRADE_ABI = parseAbi([
  'function getClone(address protocol) view returns (address)',
  'function upgradeProtocol(address protocol,address newImplementation)',
  'function updateProtocols(address[] addProtocols,address[] removeProtocols)',
  'function multicall(bytes[] data) returns (bytes[] results)',
]);

/** ERC-1967 implementation slot — the vault's currently-running implementation. */
export const ERC1967_IMPL_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
/** Guard implementation category for the vault itself. */
export const IMPLEMENTATION_VAULT = 1;

/**
 * StableCoinAsGas config — which stable coins may pay the relay fee (empty = any guard-registered coin), plus
 * the daily budget + per-op cap. `disableStableCoinAsGas` turns relaying off entirely. From v1.0.2 it is
 * `*TokenAsGas`, and the vault's WETH ({gasWrappedAddress}) may pay too.
 */
export const VAULT_STABLE_COIN_AS_GAS_ABI = parseAbi([
  'function setTokenAsGas(address[] assets,uint64 dailyLimit,uint64 maxFeePerOp)',
  'function disableTokenAsGas()',
  'function tokenAsGasConfig() view returns (address[] assets,uint256 dailyLimit,uint256 maxFeePerOp)',
  'function gasWrappedAddress() view returns (address)',
  'function setStableCoinAsGas(address[] stableCoins,uint64 dailyLimit,uint64 maxFeePerOp)',
  'function disableStableCoinAsGas()',
  'function stableCoinAsGasConfig() view returns (address[] stableCoins,uint256 dailyLimit,uint256 maxFeePerOp)',
  'function setGasless(address[] stableCoins,uint64 dailyLimit,uint64 maxFeePerOp)',
  'function disableGasless()',
  'function gaslessConfig() view returns (address[] stableCoins,uint256 dailyLimit,uint256 maxFeePerOp)',
  'function vaultVersion() view returns (uint256)',
  'function gasBudgetRemaining() view returns (uint256)',
]);

/**
 * Auto-yield (v1.0.x): a per-asset default route — idle balances of `asset` are swept into `protocol`
 * by the keeper. `protocol` = zero address clears the route. `getAutoYieldings` reads them back.
 */
export const VAULT_AUTOYIELD_ABI = parseAbi([
  'function setAutoYielding((address asset,address protocol) route)',
  'function getAutoYieldings(address[] assetAddresses) view returns (address[] protocols)',
]);

/** The vault DeFi actions we relay. `deposit` = stake/supply; `withdraw` folds unstake in on v1.0.x. */
export const VAULT_DEFI_ABI = parseAbi([
  'function deposit(address protocol, address asset, uint256 amount)',
  'function withdraw(address protocol, address asset, uint256 amount)',
]);

/**
 * Market swaps through the AMM adapter (Uniswap V3). marketSell = exact-in (sell exactly, receive at
 * least buyAmountMin); marketBuy = exact-out (receive exactly, spend at most sellAmountMax). `path` is
 * the encoded V3 route; for marketBuy it is REVERSED (buy→fee→sell).
 */
export const VAULT_TRADE_ABI = parseAbi([
  'function marketSell(address ammProtocol,address sellToken,uint256 sellAmount,address buyToken,uint256 buyAmountMin,bytes path)',
  'function marketBuy(address ammProtocol,address sellToken,uint256 sellAmountMax,address buyToken,uint256 buyAmount,bytes reversedPath)',
]);

/**
 * Payments. `send` transfers from the vault to a recipient (empty withdraw arrays = pay from
 * free balance). Scheduled payments and the operator-proposed-send governance (approveSend /
 * cancelSend) are GONE from the contract: the payment surface is wholly the owner's now, so the
 * fragments went with the screens that called them.
 *
 * The whitelist on v1.0.0: an entry is an address and nothing else — it accepts any asset, since a
 * locked vault pays out only through these and cannot trade into a narrower one. Removing an entry
 * the vault can already pay waits out the timelock (a lock voids it), so `removeWhitelistedRecipients`
 * may only QUEUE it. `getWhitelist` reads the whole book from state, each entry with its status
 * (WHITELIST_STATUS) and the times it becomes payable and, if queued, is removed.
 */
export const VAULT_PAYMENTS_ABI = parseAbi([
  'function send(address recipient,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts)',
  // One recipient, several assets: the vault pays one recipient per call (from 1.0.1).
  'function batchSend(address recipient,address[] assets,uint256[] amounts,address[][] withdrawProtocols,uint256[][] withdrawAmounts)',
  // Pay one recipient and save them in the same call (from 1.0.1): cheaper than the two in a multicall.
  'function sendAndAddWhitelistedRecipient(address recipient,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts) returns (uint256 id)',
  'function batchSendAndAddWhitelistedRecipient(address recipient,address[] assets,uint256[] amounts,address[][] withdrawProtocols,uint256[][] withdrawAmounts) returns (uint256 id)',
  // Whitelist / address book
  'function addWhitelistedRecipient(address recipient) returns (uint256 id)',
  'function removeWhitelistedRecipients(uint256[] ids)',
  'function sendToWhitelistedRecipient(uint256 id,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts)',
  'function getWhitelist(uint256 fromId,uint256 count) view returns (uint256 lastId,(uint256 id,address recipient,uint64 effectiveAt,uint64 removeAt,uint8 status)[] entries)',
]);

/** `getWhitelist`'s per-entry status, as the vault's WHITELIST_* constants. */
export const WHITELIST_STATUS = {
  removed: 0, // gone, or never issued
  pending: 1, // still waiting out the timelock it was added under
  payable: 2, // can be paid now, lock or no lock
  voided: 3, // a lock landed before it matured, so it never will
  removalQueued: 4, // payable until `removeAt`, then gone
} as const;

/** v1.0.3's whitelist entry also names the one asset it may be paid in; the app always passes "any". */
export const VAULT_PAYMENTS_V103_ABI = parseAbi([
  'function addWhitelistedRecipient(address recipient,address allowedAsset) returns (uint256 id)',
  // One recipient per leg; the app passes the same recipient for every leg.
  'function batchSend(address[] recipients,address[] assets,uint256[] amounts,address[][] withdrawProtocols,uint256[][] withdrawAmounts)',
]);

/**
 * Delegation (v1.0.0). `setAssetManager` appoints the single trading delegate until `expiresAt` with a
 * `permissions` mask of what it may do (0 addr revokes; appointing, extending or widening the mask
 * waits out a change timelock, landing in the pending slot until it applies).
 * The payout-operator role was removed from the contract — a proposer in front of the only person
 * who could release the money anyway — so no operator fragments remain.
 */
export const VAULT_DELEGATE_ABI = parseAbi([
  'function setAssetManager(address assetManager,uint64 expiresAt,uint32 permissions)',
  'function getAssetManagerSettings() view returns (address manager,uint64 expiresAt,address pendingManager,uint64 pendingAt,uint32 permissions,uint32 pendingPermissions)',
]);

/**
 * v1.0.3's delegation: no permission masks, so `setAssetManager` takes two arguments and
 * `getAssetManagerSettings` returns four. Decoding a v1.0.3 return with the v1.0.0 fragment fails
 * outright, so callers pick this one by generation.
 */
export const VAULT_DELEGATE_V103_ABI = parseAbi([
  'function setAssetManager(address assetManager,uint64 expiresAt)',
  'function getAssetManagerSettings() view returns (address manager,uint64 expiresAt,address pendingManager,uint64 pendingAt)',
]);

/**
 * The asset-manager permission bits v1.0.0 defines (`PERM_*` in Constants.sol).
 *  - yield: deposit into staking protocols.     - supply: deposit into lending protocols.
 *  - marketTrade: `marketSell` / `marketBuy`.   - intent: limit orders and TWAP (relayer approval,
 *    order signatures).
 * Withdrawing and cancelling orders take no permission — any active manager may unwind.
 */
export const ASSET_MANAGER_PERMS = {
  yield: 1 << 0,
  supply: 1 << 1,
  marketTrade: 1 << 2,
  intent: 1 << 3,
} as const;

/** Every permission above: what a new appointment starts with. */
export const ASSET_MANAGER_ALL_PERMISSIONS = 0b1111;

/**
 * Owner risk & controls, matching the v1.0.0 vault's risk surface.
 *  - The risk surface is THREE numbers (`RiskSettings`): `timelock` — the one wait in front of
 *    everything deferred — `sendDailyAllowance`, the ceiling on what regular sends may move per
 *    rolling day in whole USD (0 = no cap; above 0, sends are held to stablecoins), and
 *    `marketTradeDailyLossAllowance`, what market trades may lose against oracle value per rolling
 *    day in whole USD (0 = unprotected). The two ceilings are kept apart, so trading never uses up
 *    what may be sent. Any can be `type(uint256).max` (UNCHANGED) to write just some. Tightening applies at once; loosening waits
 *    out the timelock in force when it was asked for. Read via `riskSettings`.
 *  - The locks: `emergencyLock` freezes the risk surface where it stands (reversible with
 *    `unlock`); `foreverLock` freezes it for good — no way back by any key. Both instant, by
 *    design: a queued lock is one the thief cancels. `lockLevel` reads 0 / 1 / 2. `foreverLock`
 *    names a whitelisted recipient the vault can pay right now and refuses (`NoEscapeRecipient`)
 *    without one, since afterwards that list is the only way money ever leaves.
 *  - `pendingChanges` lists what is waiting out the timelock: a loosened risk number shows here with
 *    the moment it applies (`At` = 0 means nothing waiting), as do a handover and a queued grant.
 *  - `wrapNative` wraps native ETH the vault holds into WETH so it's usable.
 *  - `autoYield(asset)` manually sweeps an asset's idle balance into its configured yield route now.
 */
export const VAULT_RISK_ABI = parseAbi([
  'struct RiskSettings { uint256 timelock; uint256 sendDailyAllowance; uint256 marketTradeDailyLossAllowance; }',
  'function updateRisk(RiskSettings riskSettings)',
  'function riskSettings() view returns (uint64 timelock,uint64 sendDailyAllowance,uint64 marketTradeDailyLossAllowance)',
  'function lockLevel() view returns (uint8)',
  'struct PendingChanges { uint8 lockLevel; address newOwner; uint64 newOwnerReadyAt; address newAssetManager; uint64 newAssetManagerAt; uint32 newAssetManagerPerms; uint64 timelock; uint64 timelockAt; uint64 sendDailyAllowance; uint64 sendDailyAllowanceAt; uint64 marketTradeDailyLossAllowance; uint64 marketTradeDailyLossAllowanceAt; uint64 gasBudgetDaily; uint64 gasBudgetDailyAt; uint64 maxFeePerOp; uint64 maxFeePerOpAt; }',
  'function pendingChanges() view returns (PendingChanges changes)',
  'function emergencyLock()',
  'function unlock()',
  'function foreverLock(uint256 escapeRecipientId)',
  'function wrapNative()',
  'function autoYield(address asset)',
]);

/**
 * v1.0.3's risk surface: one 4-field `PaymentRisk` struct, each field `type(uint256).max` (UNCHANGED)
 * to leave it. `getRiskConfig`'s tuple order swaps the last two vs the struct. No locks on v1.0.3,
 * and no market-trade allowance. The app maps v1.0.0's numbers onto it: `timelock` =
 * `changeTimelock`, the send allowance = `maxSendValue` (per `maxSendInterval`, which v1.0.3 lets
 * the owner set).
 */
export const VAULT_RISK_V103_ABI = parseAbi([
  'struct PaymentRisk { uint256 newPaymentProtection; uint256 maxSendValue; uint256 maxSendInterval; uint256 changeTimelock; }',
  'function updatePaymentRisk(PaymentRisk update)',
  'function getRiskConfig() view returns (uint64 newPaymentProtection,uint64 maxSendValue,uint64 changeTimelock,uint64 maxSendInterval)',
]);

/** Intent (CoW) — relayer approval + on-chain cancel (CoW can't soft-cancel an eip1271 vault order). */
export const VAULT_INTENT_ABI = parseAbi([
  'function approveIntentRelayer(address intentProtocol,address token)',
  'function cancelIntentOrders(address intentProtocol,bytes[] orderUids)',
]);

/**
 * Registered-protocol set. Registering an adapter is a prerequisite for routing through it: a market
 * swap's guard requires the AMM adapter listed, and registering an INTENT adapter is what makes the vault
 * clone it (the clone is what CoW calls isValidSignature on). `getProtocols` reads the current set so a
 * one-time `updateProtocols` add can be skipped when it's already there.
 */
export const VAULT_REGISTRY_ABI = parseAbi([
  'function getProtocols() view returns (address[])',
  'function updateProtocols(address[] addProtocols,address[] removeProtocols)',
]);

/** vault.multicall — batch several vault calls into ONE transaction (one signature, one relay). Used to
 *  bundle a one-time adapter registration with the operation that needs it, so nothing waits mid-way. */
export const VAULT_MULTICALL_ABI = parseAbi([
  'function multicall(bytes[] data) returns (bytes[] results)',
]);

/** Uniswap V3 QuoterV2 — non-view, but callable via eth_call (viem simulateContract). */
export const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

/** OZ's ForwardRequest — the exact type the forwarder verifies against. Mirrors web gasless.ts. */
export const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    {name: 'from', type: 'address'},
    {name: 'to', type: 'address'},
    {name: 'value', type: 'uint256'},
    {name: 'gas', type: 'uint256'},
    {name: 'nonce', type: 'uint256'},
    {name: 'deadline', type: 'uint48'},
    {name: 'data', type: 'bytes'},
  ],
} as const;

/**
 * Stablecoin-paid vault activation — signed against the FACTORY domain (see vault/activate.ts). `calls` is the
 * owner's FIRST batch of vault operations, run during the vault's init right after deploy ("activate and
 * call"). It's part of the signed struct so a relayer can't append operations of its own; an empty list
 * is plain activation. Must match the new factory's Activation typehash exactly or every signature is
 * rejected with InvalidActivationSignature.
 */
export const ACTIVATION_TYPES = {
  Activation: [
    {name: 'owner', type: 'address'},
    {name: 'stableCoinAddress', type: 'address'},
    {name: 'feeAmount', type: 'uint256'},
    {name: 'allowlistEnabled', type: 'bool'},
    {name: 'calls', type: 'bytes[]'},
  ],
} as const;

/**
 * The v1.0.0 generation's Activation: the allow-list flag is named for what it does
 * (`restrictToOwnAllowList`), and the signature now expires at `deadline`, so one the relayer sat on
 * cannot be spent later. Field names are part of the typehash — they must match the factory's exactly.
 */
export const ACTIVATION_TYPES_V2 = {
  Activation: [
    {name: 'owner', type: 'address'},
    {name: 'stableCoinAddress', type: 'address'},
    {name: 'feeAmount', type: 'uint256'},
    {name: 'restrictToOwnAllowList', type: 'bool'},
    {name: 'calls', type: 'bytes[]'},
    {name: 'deadline', type: 'uint256'},
  ],
} as const;

/** Chainlink-style price feed — ETH/USD `answer` at 8 decimals. */
export const PRICE_FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
]);

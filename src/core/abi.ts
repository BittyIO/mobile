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
 * Gasless config — which stable coins may pay the relay fee (empty = any guard-registered coin), plus
 * the daily budget + per-op cap. `disableGasless` turns relaying off entirely.
 */
export const VAULT_GASLESS_ABI = parseAbi([
  'function setGasless(address[] stableCoins,uint64 dailyLimit,uint64 maxFeePerOp)',
  'function disableGasless()',
  'function gaslessConfig() view returns (address[] stableCoins,uint256 dailyLimit,uint256 maxFeePerOp)',
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

/** LP management on the AMM adapter. `data` is the ABI-encoded Uniswap params (see vault/lp-actions). */
export const VAULT_LP_ABI = parseAbi([
  'function addLiquidity(address ammProtocol,address token0,uint256 amount0,address token1,uint256 amount1,bytes data)',
  'function removeLiquidity(address ammProtocol,bytes data)',
  'function decreaseLiquidity(address ammProtocol,bytes data)',
  'function claimAMMFees(address ammProtocol,bytes data)',
]);

/**
 * Payments (v1.0.x). `send` transfers from the vault to a recipient (empty withdraw arrays = pay from
 * free balance). Scheduled payments recur from a start time; `payScheduled` executes a due one.
 */
const SCHEDULED_PAYMENT_TUPLE =
  '(address scheduledPaymentAddress,uint256 paymentCount,bool isImmutable,bool payWithInsufficientBalance,address trigger,address assetAddress,uint256 amount,uint256 startTimestamp,uint256 paymentInterval)';

export const VAULT_PAYMENTS_ABI = parseAbi([
  'function send(address recipient,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts)',
  'function batchSend(address[] recipients,address[] assets,uint256[] amounts,address[][] withdrawProtocols,uint256[][] withdrawAmounts)',
  `function addScheduledPayment(${SCHEDULED_PAYMENT_TUPLE} scheduledPayment) returns (uint256 id)`,
  `function updateScheduledPayments(uint256[] ids,${SCHEDULED_PAYMENT_TUPLE}[] scheduledPayments)`,
  'function removeScheduledPayments(uint256[] ids)',
  'function payScheduled(uint256 id,address[] withdrawProtocols)',
  // Whitelist / address book
  'function addWhitelistedRecipient(address recipient,address allowedAsset) returns (uint256 id)',
  'function removeWhitelistedRecipients(uint256[] ids)',
  'function updateWhitelistedRecipients(uint256[] ids,address[] recipients,address[] allowedAssets)',
  'function sendToWhitelistedRecipient(uint256 id,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts)',
  // Operator-proposed send governance
  'function approveSend(uint256 id)',
  'function cancelSend(uint256 id)',
]);

/**
 * Delegation. `setAssetManager` appoints the single trading delegate until `expiresAt` (0 addr revokes;
 * appointing/extending waits out a change timelock, landing in the pending slot until it applies).
 * Payout operators (propose payments for owner approval) are toggled with `updatePayoutOperator`; there's
 * no list getter, so the current set is derived from `PayoutOperatorUpdated` events verified against
 * `isPayoutOperator`.
 */
export const VAULT_DELEGATE_ABI = parseAbi([
  'function setAssetManager(address assetManager,uint64 expiresAt)',
  'function getAssetManagerSettings() view returns (address manager,uint64 expiresAt,address pendingManager,uint64 pendingAt)',
  'function updatePayoutOperator(address payoutOperator,bool add)',
  'function isPayoutOperator(address account) view returns (bool)',
  'event PayoutOperatorUpdated(address indexed payoutOperator,bool added)',
]);

/**
 * Owner risk & controls.
 *  - Payment risk: one 4-field `PaymentRisk` struct. Each field can be `type(uint256).max` (UNCHANGED)
 *    to write just one and leave the rest. Read via `getRiskConfig` — NOTE its tuple order swaps the
 *    last two vs the struct: (newPaymentProtection, maxSendValue, changeTimelock, maxSendInterval).
 *    Units: durations in seconds; maxSendValue in WHOLE stablecoin tokens (0 = unrestricted).
 *    Tightening applies at once; loosening waits out `changeTimelock`.
 *  - `disableTradeUntilTimestamp` pauses all trading until a unix second (a panic control).
 *  - `wrapNative` wraps native ETH the vault holds into WETH so it's usable.
 *  - `autoYield(asset)` manually sweeps an asset's idle balance into its configured yield route now.
 */
export const VAULT_RISK_ABI = parseAbi([
  'struct PaymentRisk { uint256 newPaymentProtection; uint256 maxSendValue; uint256 maxSendInterval; uint256 changeTimelock; }',
  'function updatePaymentRisk(PaymentRisk update)',
  'function getRiskConfig() view returns (uint64 newPaymentProtection,uint64 maxSendValue,uint64 changeTimelock,uint64 maxSendInterval)',
  'function disableTradeUntilTimestamp(uint256 timestamp)',
  'function tradeDisabledUntil() view returns (uint256)',
  'function wrapNative()',
  'function autoYield(address asset)',
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
 * Gasless vault activation — signed against the FACTORY domain (see vault/activate.ts). `calls` is the
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

/** Chainlink-style price feed — ETH/USD `answer` at 8 decimals. */
export const PRICE_FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
]);

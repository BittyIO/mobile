/**
 * What a transaction did, from the server's decoded calldata (`actions` on the transfers feed), as
 * one readable line per action. Movement actions (market swaps, deposits, withdrawals, sends) are
 * already told by the transfer legs, so they yield nothing here; configuration actions, which move
 * nothing but their gas fee, are the point.
 */
import type {Network} from '@/core/chain';
import {assetMeta} from '@/core/assets';
import {protocolDisplayName, protocolMeta} from '@/core/protocols';
import {displaySymbol, fmtNum, shortAddress} from '@/core/format';
import {recipientName, useRecipientNames} from '@/core/recipient-names';
import {feeConfigOf, type FeeConfig, type OpDetails} from './tx-details';
import {formatUnits, type Address} from 'viem';
import type {CowOrder} from '@/vault/limit';
import type {TransferRow} from '@/vault/transactions';
import {RISK_TITLE, fmtRiskValue} from '@/components/riskFormat';
import type {RiskField} from '@/vault/risk';

export type VaultAction = {name: string; args: Record<string, string | string[]>};

type T = (key: string, params?: Record<string, string | number>) => string;

const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

/** One line for a CoW order: "0.1 ETH → 250 USDC" (sell for buy), from the order's raw amounts. */
export function describeOrder(o: CowOrder, network: Network): string {
  const sell = assetMeta(network, o.sellToken as `0x${string}`);
  const buy = assetMeta(network, o.buyToken as `0x${string}`);
  const amt = (raw: string, dec: number) => fmtNum(Number(formatUnits(BigInt(raw), dec)));
  return `${amt(o.sellAmount, sell.decimals)} ${displaySymbol(sell.symbol)} → ${amt(o.buyAmount, buy.decimals)} ${displaySymbol(buy.symbol)}`;
}

/**
 * A market swap reconstructed from the decoded calldata, when the transfer feed could not pair its
 * legs into one — the `{sold, bought}` shape {netTrade} returns, so a history row can draw it the
 * same way.
 *
 * The feed is built from `Transfer` logs for the indexed tokens, and on Sepolia the bought WETH leg
 * is not indexed at all — the chain has two WETH contracts and the vault's is not the router's — so
 * a market buy arrives as the sold-token out-legs and nothing coming back, which the transfer
 * heuristic reads as a plain send. The `marketSell`/`marketBuy` call names both tokens and both
 * amounts, so the trade is named from there instead: the sold side is the amount asked (fee
 * included), and the bought side is the real in-leg when one survived, else the order's own floor
 * (`buyAmountMin`) — the honest figure a trade that moved money we could not fully see can report.
 */
export function swapFromActions(
  actions: VaultAction[] | undefined,
  network: Network,
  legs: TransferRow[],
): {sold: {address: string; symbol: string; amount: number}; bought: {address: string; symbol: string; amount: number}} | null {
  const swap = (actions ?? []).find((a) => a.name === 'marketSell' || a.name === 'marketBuy');
  if (!swap) return null;
  const str = (k: string) => (typeof swap.args[k] === 'string' ? (swap.args[k] as string) : undefined);
  const sellToken = str('sellToken');
  const buyToken = str('buyToken');
  const sellRaw = str('sellAmount') ?? str('sellAmountMax');
  const buyRaw = str('buyAmountMin') ?? str('buyAmount');
  if (!sellToken || !buyToken || sellRaw == null || buyRaw == null) return null;
  try {
    const sellM = assetMeta(network, sellToken as Address);
    const buyM = assetMeta(network, buyToken as Address);
    const lc = (s?: string | null) => (s ?? '').toLowerCase();
    const inLeg = legs
      .filter((l) => l.direction === 'in' && lc(l.assetAddress) === lc(buyToken))
      .reduce((s, l) => s + Number(l.amount ?? 0), 0);
    return {
      sold: {address: sellToken, symbol: sellM.symbol, amount: Number(formatUnits(BigInt(sellRaw), sellM.decimals))},
      bought: {address: buyToken, symbol: buyM.symbol, amount: inLeg > 0 ? inLeg : Number(formatUnits(BigInt(buyRaw), buyM.decimals))},
    };
  } catch {
    return null;
  }
}

/** The history tabs an action can belong to; mirrors TransactionsScreen's Category. */
export type ActionCategory = 'trade' | 'stake' | 'send' | 'settings' | 'gas';

/**
 * Which tab a transaction belongs to, judged by what the vault was ASKED to do.
 *
 * The tab used to be inferred purely from which tokens moved, and a transaction that moved none
 * fell through to "network fee" — so cancelling a limit order, and approving an asset for the
 * intent protocol, both filed themselves under the fee they happened to pay. An action is direct
 * evidence of intent where a counterparty address is a guess, so it is consulted first.
 *
 * Only actions with an unambiguous home are listed. A change to the vault's own configuration goes
 * to Settings: it moves nothing but the relay fee, so on the fee tab it read as a payment with no
 * reason. Anything not listed still lands on the fee tab.
 */
const ACTION_CATEGORY: Record<string, ActionCategory> = {
  // Earn, and the reason this map exists at all: a lending supply moves the underlying OUT and the
  // aToken IN, but the indexer does not track aTokens, so only the outgoing leg is visible and the
  // transfer heuristic read it as a payment to a stranger.
  deposit: 'stake',
  withdraw: 'stake',
  // Trading. None of these move a token, but every one of them is part of an order's life.
  approveIntentRelayer: 'trade',
  cancelIntentOrder: 'trade',
  cancelIntentOrders: 'trade',
  disableTradeUntilTimestamp: 'trade',
  marketSell: 'trade',
  marketBuy: 'trade',
  // Earn. The keeper's sweep and the switches that govern it.
  autoYield: 'stake',
  autoYields: 'stake',
  setAutoYielding: 'stake',
  setAutoYieldings: 'stake',
  setAutoYieldTrigger: 'stake',
  // Payments.
  addScheduledPayment: 'send',
  updateScheduledPayments: 'send',
  removeScheduledPayments: 'send',
  payScheduled: 'send',
  addWhitelistedRecipient: 'send',
  removeWhitelistedRecipients: 'send',
  proposeSend: 'send',
  approveSend: 'send',
  cancelSends: 'send',
  // The vault's own configuration.
  updateRisk: 'settings',
  setStableCoinAsGas: 'settings',
  disableStableCoinAsGas: 'settings',
  // The same two calls under the names the vault uses from v1.0.2, when WETH joined the fee coins.
  setTokenAsGas: 'settings',
  disableTokenAsGas: 'settings',
  setGasless: 'settings',
  disableGasless: 'settings',
  updateAssets: 'settings',
  updateProtocols: 'settings',
  upgradeProtocol: 'settings',
  upgrade: 'settings',
  setAssetManager: 'settings',
  clearDelegates: 'settings',
  useBittyAllowList: 'settings',
  enableAllowlist: 'settings',
  disableAllowlist: 'settings',
  updatePaymentRisk: 'settings',
  updatePayoutOperator: 'settings',
  emergencyLock: 'settings',
  foreverLock: 'settings',
  unlock: 'settings',
  transferOwnership: 'settings',
  acceptOwnership: 'settings',
  settleOwnershipTransfer: 'settings',
  cancelOwnershipTransfer: 'settings',
};

/**
 * A deposit into, or a withdrawal from, a yield or lending route — read from the call rather than
 * from the transfers.
 *
 * `deposit` and `withdraw` are one pair of vault functions covering both Earn routes, so which
 * kind it is comes from the protocol's own category: Aave is lending, Sky and Lido are yielding.
 */
export function defiMoveFromActions(
  actions: VaultAction[] | undefined,
  network: Network,
): {kind: 'stake' | 'supply'; out: boolean} | null {
  for (const a of actions ?? []) {
    if (a.name !== 'deposit' && a.name !== 'withdraw') continue;
    const protocol = String(a.args.depositProtocol ?? a.args.withdrawProtocol ?? a.args.protocol ?? '');
    if (!protocol) continue;
    const category = protocolMeta(network, protocol).category;
    // An unknown adapter is still an Earn move; treating it as yielding names it honestly enough.
    return {kind: category === 'lending' ? 'supply' : 'stake', out: a.name === 'deposit'};
  }
  return null;
}

/**
 * The tab these actions put a transaction on, or null when none of them says.
 *
 * Settings only when nothing else in the transaction has a home: an order's first approval
 * registers its adapter with `updateProtocols` in the same multicall, and that is a trade.
 */
export function categoryForActions(actions: VaultAction[] | undefined): ActionCategory | null {
  let settings = false;
  for (const a of actions ?? []) {
    const c = ACTION_CATEGORY[a.name];
    if (c === 'settings') settings = true;
    else if (c) return c;
  }
  return settings ? 'settings' : null;
}

/** `type(uint256).max`: the field is left as it is. */
const RISK_UNCHANGED = (BigInt(1) << BigInt(256)) - BigInt(1);
const RISK_FIELDS: RiskField[] = ['timelock', 'sendDailyAllowance', 'marketTradeDailyLossAllowance'];

/** One line per risk field the call set, worded as the Safety settings screen words it. */
function riskLines(raw: string | string[] | undefined, t: T): string[] {
  try {
    const settings = JSON.parse(String(raw)) as Partial<Record<RiskField, string>>;
    return RISK_FIELDS.flatMap((f) => {
      if (settings[f] === undefined) return [];
      const v = BigInt(settings[f]!);
      return v === RISK_UNCHANGED ? [] : [`${t(RISK_TITLE[f])}: ${fmtRiskValue(f, v, null, undefined, t)}`];
    });
  } catch {
    return [];
  }
}

/**
 * What a fee-coin call changed: each coin turned on or off against the setting before it, and each
 * cap that moved. With nothing earlier in the history to compare against, the setting as it now is.
 * An empty list is not "no coins" — it is any coin the guard registers.
 */
function feeLines(cfg: FeeConfig, prev: FeeConfig | null | undefined, network: Network, t: T): string[] {
  const k = (key: string, params?: Record<string, string | number>) => t(`mobile.actions.${key}`, params);
  const sym = (a: string) => displaySymbol(assetMeta(network, a).symbol);
  const out: string[] = [];
  if (prev && prev.assets.length > 0 && cfg.assets.length > 0) {
    for (const a of cfg.assets) if (!prev.assets.includes(a)) out.push(k('fee_coin_on', {token: sym(a)}));
    for (const a of prev.assets) if (!cfg.assets.includes(a)) out.push(k('fee_coin_off', {token: sym(a)}));
  } else if (!prev || prev.assets.length !== cfg.assets.length) {
    out.push(cfg.assets.length ? k('fee_coins', {tokens: cfg.assets.map(sym).join(', ')}) : k('fee_coins_any'));
  }
  const cap = (label: string, from: string | undefined, to: string) => {
    if (!to) return;
    if (from === undefined) out.push(`${t(label)}: $${to}`);
    else if (from !== to) out.push(`${t(label)}: $${from} → $${to}`);
  };
  cap('mobile.settings.gas_max_per_op', prev?.maxFeePerOp, cfg.maxFeePerOp);
  cap('mobile.settings.gas_max_daily', prev?.dailyLimit, cfg.dailyLimit);
  return out;
}

const isZeroAddr = (a: string) => /^0x0{40}$/i.test(a);

export function describeActions(
  actions: VaultAction[] | undefined,
  network: Network,
  t: T,
  orders: Map<string, CowOrder> | undefined,
  /** What the history around this transaction says it changed — see vault/tx-details. */
  details?: OpDetails,
): string[] {
  if (!actions?.length) return [];
  // A deposit or withdrawal names the protocol it went through. This used to be behind the
  // "DeFi details" switch, which is gone: where the money actually sits is part of what the
  // operation did, not a disclosure to opt into.
  const token = (a: string) => displaySymbol(assetMeta(network, a).symbol);
  const proto = (a: string) => protocolDisplayName(protocolMeta(network, a).name);
  const k = (key: string, params?: Record<string, string | number>) => t(`mobile.actions.${key}`, params);
  // An address as the history shows it: the name this device gave it, if any, and its short form.
  const names = useRecipientNames.getState().names;
  const addr = (a: string) => {
    const named = recipientName(names, network, a);
    return named ? `${named} (${shortAddress(a)})` : shortAddress(a);
  };
  const versions = () =>
    details?.versionTo
      ? [details.versionFrom ? k('version_change', {from: details.versionFrom, to: details.versionTo}) : k('version_to', {to: details.versionTo})]
      : [];
  const out: string[] = [];
  // Approving a token for limit trading registers the intent adapter in the same transaction the
  // first time; the approval is the story, so that adapter's "enable service" line is dropped.
  const approvedIntents = new Set(
    actions.filter((x) => x.name === 'approveIntentRelayer').map((x) => String(x.args.intent).toLowerCase()),
  );
  // An adapter upgrade is sent with the allow-list swap that goes with it (add the new address, drop
  // the old one) in the same multicall. The upgrade's own lines already say which address went and
  // which came, so the swap must not say it again.
  const upgraded = new Set(
    actions
      .filter((x) => x.name === 'upgradeProtocol')
      .flatMap((x) => [String(x.args.protocol).toLowerCase(), String(x.args.newImplementation).toLowerCase()]),
  );
  for (const a of actions) {
    const g = a.args;
    switch (a.name) {
      case 'activateVault':
        out.push(k('activate'));
        break;
      // Neither was described before, so an Earn move showed no line at all under its title.
      case 'deposit':
        out.push(k('deposit_to', {name: proto(String(g.depositProtocol ?? g.protocol))}));
        break;
      case 'withdraw':
        out.push(k('withdraw_from', {name: proto(String(g.withdrawProtocol ?? g.protocol))}));
        break;
      case 'approveIntentRelayer':
        out.push(k('approve_intent', {token: token(String(g.token))}));
        break;
      case 'cancelIntentOrders':
      case 'cancelIntentOrder': {
        // One line per cancelled order, with what the order was when the orderbook still knows it.
        const uids = [...list(g.uids), ...list(g.uid)].map((u) => u.toLowerCase());
        out.push(uids.length > 1 ? k('cancel_intents', {count: uids.length}) : k('cancel_intent'));
        for (const uid of uids) {
          const o = orders?.get(uid);
          if (o) out.push(describeOrder(o, network));
        }
        break;
      }
      case 'updateProtocols':
        for (const p of list(g.add))
          if (!approvedIntents.has(p.toLowerCase()) && !upgraded.has(p.toLowerCase())) out.push(k('enable_service', {name: proto(p)}));
        for (const p of list(g.remove)) if (!upgraded.has(p.toLowerCase())) out.push(k('disable_service', {name: proto(p)}));
        break;
      case 'updateAssets':
        for (const p of list(g.add)) out.push(k('asset_added', {name: token(p)}));
        for (const p of list(g.remove)) out.push(k('asset_removed', {name: token(p)}));
        break;
      // The adapter the vault used is replaced by the newer one of its lineage: say which, and the
      // versions either side.
      case 'upgradeProtocol':
        out.push(
          k('upgrade_protocol', {name: proto(String(g.protocol))}),
          ...versions(),
          k('address_disabled', {address: shortAddress(String(g.protocol))}),
          k('address_enabled', {address: shortAddress(String(g.newImplementation))}),
        );
        break;
      /**
       * The vault's own implementation.
       *
       * It moves no token, so the history has nothing else to go on: before this it decoded to a
       * name with no line, and the row came out as the relayer's fee and nothing more — which
       * reads as a network fee, the one thing it is not.
       */
      case 'upgrade':
        out.push(k('upgrade_vault'), ...versions());
        break;
      case 'setAssetManager': {
        const m = String(g.assetManager ?? '');
        if (!m || isZeroAddr(m)) {
          out.push(k('asset_manager_removed'));
          break;
        }
        out.push(k('asset_manager_to', {address: addr(m)}));
        // 0 = no end date.
        const until = Number(g.expiresAt ?? 0);
        if (until > 0) out.push(k('asset_manager_until', {date: new Date(until * 1000).toLocaleString()}));
        break;
      }
      case 'useBittyAllowList':
        out.push(k(String(g.use) === 'true' ? 'allowlist_on' : 'allowlist_off'));
        break;
      case 'transferOwnership':
        out.push(k('ownership_to', {address: addr(String(g.newOwner))}));
        break;
      case 'cancelOwnershipTransfer':
        out.push(k('ownership_cancelled'));
        break;
      case 'settleOwnershipTransfer':
        out.push(k('ownership_settled'));
        break;
      case 'emergencyLock':
        out.push(k('lock_emergency'));
        break;
      case 'unlock':
        out.push(k('lock_unlock'));
        break;
      case 'foreverLock':
        out.push(k('lock_forever'));
        break;
      case 'clearDelegates':
        out.push(k('delegates_cleared'));
        break;
      case 'setAutoYielding':
      case 'setAutoYieldings': {
        // Routes arrive as JSON ({asset, protocol}); a zero protocol clears the route.
        const raw = a.name === 'setAutoYielding' ? [String(g.route)] : list(g.routes);
        for (const r of raw) {
          try {
            const {asset, protocol} = JSON.parse(r) as {asset: string; protocol: string};
            const off = /^0x0{40}$/i.test(protocol);
            out.push(k(off ? 'auto_yield_off' : 'auto_yield_set', {token: token(asset)}));
          } catch {
            out.push(k('auto_yield_set', {token: ''}));
          }
        }
        break;
      }
      case 'setAutoYieldTrigger':
        out.push(k('auto_yield_trigger'));
        break;
      case 'autoYield':
      case 'autoYields':
        out.push(k('auto_yield_run'));
        break;
      case 'setGasless':
      case 'setStableCoinAsGas':
      case 'setTokenAsGas': {
        out.push(k('stable_coin_as_gas_set'));
        const cfg = feeConfigOf([a]);
        if (cfg) out.push(...feeLines(cfg, details?.feePrev, network, t));
        break;
      }
      case 'disableGasless':
      case 'disableStableCoinAsGas':
      case 'disableTokenAsGas':
        out.push(k('stable_coin_as_gas_disabled'));
        break;
      case 'updatePaymentRisk':
        out.push(k('payment_risk'));
        break;
      case 'updateRisk':
        // The deployed vault names the struct `riskSettings`; an earlier one named it `settings`.
        out.push(k('risk_updated'), ...riskLines(g.riskSettings ?? g.settings, t));
        break;
      case 'updatePayoutOperator':
        out.push(k(String(g.add) === 'true' ? 'operator_added' : 'operator_removed'));
        break;
      case 'enableAllowlist':
        out.push(k('allowlist_enabled'));
        break;
      case 'disableAllowlist':
        out.push(k('allowlist_disabled'));
        break;
      case 'disableTradeUntilTimestamp':
        out.push(k('trade_paused'));
        break;
      case 'wrapNative':
        out.push(k('wrap'));
        break;
      case 'addScheduledPayment':
        out.push(k('scheduled_added'));
        break;
      case 'updateScheduledPayments':
        out.push(k('scheduled_updated'));
        break;
      case 'removeScheduledPayments':
        out.push(k('scheduled_removed'));
        break;
      case 'payScheduled':
        out.push(k('scheduled_paid'));
        break;
      case 'addWhitelistedRecipient':
      case 'sendAndAddWhitelistedRecipient':
      case 'batchSendAndAddWhitelistedRecipient':
        out.push(k('recipient_added'), addr(String(g.recipient)));
        break;
      case 'removeWhitelistedRecipients':
        out.push(k('recipient_removed'), ...list(g.ids).map((id) => k('recipient_id', {id})));
        break;
      case 'proposeSend':
        out.push(k('send_proposed'));
        break;
      case 'approveSend':
        out.push(k('send_approved'));
        break;
      case 'cancelSends':
        out.push(k('send_cancelled'));
        break;
      default:
        // marketSell/marketBuy, deposit/withdraw, send: the legs already say it.
        break;
    }
  }
  return [...new Set(out)];
}

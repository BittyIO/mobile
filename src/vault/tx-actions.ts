/**
 * What a transaction did, from the server's decoded calldata (`actions` on the transfers feed), as
 * one readable line per action. Movement actions (market swaps, deposits, withdrawals, sends) are
 * already told by the transfer legs, so they yield nothing here; configuration actions, which move
 * nothing but their gas fee, are the point.
 */
import {NATIVE, type Network} from '@/core/chain';
import {assetMeta, underlyingOf} from '@/core/assets';
import {protocolDisplayName, protocolMeta} from '@/core/protocols';
import {displaySymbol, fmtNum, shortAddress} from '@/core/format';
import {recipientName, useRecipientNames} from '@/core/recipient-names';
import {feeConfigOf, type FeeConfig, type OpDetails} from './tx-details';
import {susdsRateCached} from './yielding';
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
  // An order paid from a position sells its receipt token: told as the asset it holds, at its rate.
  const rate = (sym: string) => (sym.toUpperCase() === 'SUSDS' ? susdsRateCached(network) : 1);
  const amt = (raw: string, dec: number, sym: string) => fmtNum(Number(formatUnits(BigInt(raw), dec)) * rate(sym));
  return `${amt(o.sellAmount, sell.decimals, sell.symbol)} ${displaySymbol(sell.symbol)} → ${amt(o.buyAmount, buy.decimals, buy.symbol)} ${displaySymbol(buy.symbol)}`;
}

/** A CoW order as the two legs of a trade, drawn the way a market trade's are. */
export function orderTrade(o: CowOrder, network: Network): {sold: Leg; bought: Leg} {
  const leg = (token: string, raw: string): Leg => {
    const m = assetMeta(network, token as `0x${string}`);
    const rate = m.symbol.toUpperCase() === 'SUSDS' ? susdsRateCached(network) : 1;
    return {address: token, symbol: m.symbol, amount: Number(formatUnits(BigInt(raw), m.decimals)) * rate};
  };
  return {sold: leg(o.sellToken, o.sellAmount), bought: leg(o.buyToken, o.buyAmount)};
}
type Leg = {address: string; symbol: string; amount: number};

/** The calls a CoW order's setup transaction is made of (see vault/limit `prepareIntent`). */
const ORDER_SETUP = new Set(['approveIntentRelayer', 'approveIntentSpender', 'updateAssets', 'updateProtocols', 'upgrade', 'upgradeProtocol']);
/** How long after its setup is mined an order is posted: signing and one POST, seconds in practice. */
const ORDER_SETUP_WINDOW_MS = 120_000;

/**
 * The CoW order each setup transaction was sent for, by tx hash.
 *
 * A limit order is a signature posted to CoW's book, so the only transaction it leaves is the setup
 * in front of it: allowlisting the tokens, the approval, and any upgrade that rode along. Shown as
 * those calls, the row read as a settings change when what the user did was place an order. Nothing
 * on chain links the two, so they are paired by time — each order to the closest setup before it
 * within the window. A transaction counts as setup only when every call is one and at least one
 * prepares an order (an approval, an asset or adapter added); a lone vault or adapter upgrade
 * sent from Settings a minute before an order stays what it was.
 */
export function ordersBySetup(
  ops: {txHash: string; timestamp: string | null; actions?: VaultAction[]}[],
  orders: Map<string, CowOrder> | undefined,
): Map<string, CowOrder> {
  const out = new Map<string, CowOrder>();
  if (!orders?.size) return out;
  const setups = ops
    .filter((op) => {
      const a = op.actions ?? [];
      if (!a.length || !a.every((x) => ORDER_SETUP.has(x.name))) return false;
      const upgrading = a.some((x) => x.name === 'upgradeProtocol');
      return a.some((x) => x.name.startsWith('approveIntent') || x.name === 'updateAssets' || (x.name === 'updateProtocols' && !upgrading));
    })
    .map((op) => ({hash: op.txHash, at: op.timestamp ? Date.parse(op.timestamp) : NaN}))
    .filter((s) => !Number.isNaN(s.at));
  for (const o of orders.values()) {
    const placed = o.creationDate ? Date.parse(o.creationDate) : NaN;
    if (Number.isNaN(placed)) continue;
    let best: {hash: string; at: number} | null = null;
    for (const s of setups) {
      if (s.at <= placed && placed - s.at <= ORDER_SETUP_WINDOW_MS && (!best || s.at > best.at) && !out.has(s.hash)) best = s;
    }
    if (best) out.set(best.hash, o);
  }
  return out;
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
  // A Lido unstake's second half: the finalized ETH comes back as WETH.
  claimWithdrawal: 'stake',
  claimWithdrawals: 'stake',
  // Trading. None of these move a token, but every one of them is part of an order's life.
  approveIntentRelayer: 'trade',
  approveIntentSpender: 'trade',
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
  updateAssets: 'settings',
  updateProtocols: 'settings',
  upgradeProtocol: 'settings',
  upgrade: 'settings',
  setAssetManager: 'settings',
  clearDelegates: 'settings',
  useBittyAllowList: 'settings',
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
/** One deposit into or withdrawal from a yield or lending position, as the call asked for it. */
export type DefiMove = {kind: 'stake' | 'supply'; out: boolean; protocol: string; asset: string; amount: bigint};

/**
 * Every deposit and withdrawal a transaction's calls made, in order — a move from Flexible Yield to
 * Flexible Lend is one withdraw and one deposit, and each is its own line in the history. The
 * asset is the underlying (USDC, WETH), never the position's receipt token.
 */
export function defiMovesFromActions(actions: VaultAction[] | undefined, network: Network): DefiMove[] {
  const out: DefiMove[] = [];
  const kindOf = (protocol: string) => (protocolMeta(network, protocol).category === 'lending' ? 'supply' : 'stake');
  for (const a of actions ?? []) {
    if (a.name === 'deposit' || a.name === 'withdraw') {
      const protocol = String(a.args.depositProtocol ?? a.args.withdrawProtocol ?? a.args.protocol ?? '');
      const asset = String(a.args.assetAddress ?? '');
      if (!protocol || !asset) continue;
      out.push({kind: kindOf(protocol), out: a.name === 'deposit', protocol, asset, amount: BigInt(String(a.args.amount ?? '0'))});
    } else if (a.name === 'withdraws') {
      const ps = list(a.args.protocols), as = list(a.args.assets), ns = list(a.args.amounts);
      ps.forEach((protocol, i) => as[i] && out.push({kind: kindOf(protocol), out: false, protocol, asset: as[i], amount: BigInt(ns[i] ?? '0')}));
    }
  }
  return out;
}

/**
 * A leg in a position's receipt token, told as the asset it stands for: an aToken is its underlying
 * one to one, and sUSDS is worth `rate` USDC (vault/yielding `susdsRate`). The address is kept, so
 * the history still knows it for what it is; only what is shown changes.
 */
export function asUnderlying(l: TransferRow, network: Network, rates?: Map<string, number>): TransferRow {
  const u = l.assetAddress ? underlyingOf(network, l.assetAddress) : null;
  if (!u) return l;
  const rate = rates?.get(String(l.assetAddress).toLowerCase()) ?? 1;
  const n = Number(l.amount ?? '0');
  return {...l, assetSymbol: u, amount: Number.isFinite(n) ? String(n * rate) : l.amount};
}

/**
 * The protocol an Earn move went through, as the row names it ("Aave V3", "Lido V2", "Sky V1").
 *
 * An adapter this build's table does not know still has its category from the guard, and each
 * Earn route has one protocol per kind of asset: lending is Aave, staking ETH is Lido, staking a
 * stablecoin is Sky. Null only when not even the category is known.
 */
export function earnProtocolName(network: Network, protocol: string, asset?: string): string | null {
  const meta = protocolMeta(network, protocol);
  if (!meta.name.startsWith('0x')) return protocolDisplayName(meta.name);
  if (meta.category === 'lending') return protocolDisplayName('Aave V3');
  if (meta.category !== 'staking') return null;
  const sym = asset ? assetMeta(network, asset).symbol.toUpperCase() : '';
  return protocolDisplayName(sym === 'WETH' || sym === 'ETH' || sym === 'STETH' ? 'Lido' : 'Sky');
}

/**
 * The adapter a claim of finalized unstaking requests came from (Lido), or null when the
 * transaction made none. The call names request ids, not an amount: what came back is in the legs.
 */
export function stakeClaimFromActions(actions: VaultAction[] | undefined): string | null {
  const a = (actions ?? []).find((x) => x.name === 'claimWithdrawal' || x.name === 'claimWithdrawals');
  // The vault's own parameter is `withdrawProtocol`; reading `protocol` named no adapter at all, and
  // the row then showed "from …".
  return a ? String(a.args.withdrawProtocol ?? a.args.protocol ?? '') : null;
}

export function defiMoveFromActions(
  actions: VaultAction[] | undefined,
  network: Network,
): {kind: 'stake' | 'supply'; out: boolean; protocol: string; asset: string} | null {
  for (const a of actions ?? []) {
    if (a.name !== 'deposit' && a.name !== 'withdraw') continue;
    const protocol = String(a.args.depositProtocol ?? a.args.withdrawProtocol ?? a.args.protocol ?? '');
    if (!protocol) continue;
    const category = protocolMeta(network, protocol).category;
    // An unknown adapter is still an Earn move; treating it as yielding names it honestly enough.
    return {kind: category === 'lending' ? 'supply' : 'stake', out: a.name === 'deposit', protocol, asset: String(a.args.assetAddress ?? '')};
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
      return v === RISK_UNCHANGED ? [] : [`${t(RISK_TITLE[f])}: ${fmtRiskValue(f, v, t)}`];
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
  /** Leave deposits and withdrawals out: the history row names their protocol on the amount. */
  skipMoves = false,
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
    actions
      .filter((x) => x.name === 'approveIntentRelayer' || x.name === 'approveIntentSpender')
      .map((x) => String(x.args.intent).toLowerCase()),
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
        if (skipMoves) break;
        out.push(k('deposit_to', {name: proto(String(g.depositProtocol ?? g.protocol))}));
        break;
      case 'withdraw':
        if (skipMoves) break;
        out.push(k('withdraw_from', {name: proto(String(g.withdrawProtocol ?? g.protocol))}));
        break;
      // A position's receipt token is named as the asset it holds: enabling limit trading on a
      // Flexible Lend WETH is "WETH", not "aWETH".
      case 'approveIntentRelayer':
      case 'approveIntentSpender': {
        const tk = String(g.token);
        const u = underlyingOf(network, tk);
        out.push(k('approve_intent', {token: u ? displaySymbol(u) : token(tk)}));
        break;
      }
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
        // One line, the row's title: "Upgrade vault 1.0.6 → 1.0.7".
        out.push(
          details?.versionTo
            ? `${k('upgrade_vault')} ${details.versionFrom ? `${details.versionFrom} → ` : '→ '}${details.versionTo}`
            : k('upgrade_vault'),
        );
        break;
      case 'setAssetManager': {
        const m = String(g.assetManager ?? '');
        if (!m || isZeroAddr(m)) {
          out.push(k('asset_manager_removed'));
          break;
        }
        // The action first, as the row's title; who it went to is the line under it.
        out.push(k('asset_manager_set'), k('asset_manager_to', {address: addr(m)}));
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
      case 'setStableCoinAsGas':
      case 'setTokenAsGas': {
        out.push(k('stable_coin_as_gas_set'));
        const cfg = feeConfigOf([a]);
        if (cfg) out.push(...feeLines(cfg, details?.feePrev, network, t));
        break;
      }
      case 'disableStableCoinAsGas':
      case 'disableTokenAsGas':
        out.push(k('stable_coin_as_gas_disabled'));
        break;
      case 'updateRisk':
        // The deployed vault names the struct `riskSettings`; an earlier one named it `settings`.
        out.push(k('risk_updated'), ...riskLines(g.riskSettings ?? g.settings, t));
        break;
      case 'updatePayoutOperator':
        out.push(k(String(g.add) === 'true' ? 'operator_added' : 'operator_removed'));
        break;
      case 'disableTradeUntilTimestamp':
        out.push(k('trade_paused'));
        break;
      case 'wrapNative':
        out.push(k('wrap', {coin: NATIVE[network].symbol}));
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

/**
 * What a transaction did, from the server's decoded calldata (`actions` on the transfers feed), as
 * one readable line per action. Movement actions (market swaps, deposits, withdrawals, sends) are
 * already told by the transfer legs, so they yield nothing here; configuration actions, which move
 * nothing but their gas fee, are the point.
 */
import type {Network} from '@/core/chain';
import {assetMeta} from '@/core/assets';
import {protocolDisplayName, protocolMeta} from '@/core/protocols';
import {displaySymbol, fmtNum} from '@/core/format';
import {formatUnits} from 'viem';
import type {CowOrder} from '@/vault/limit';

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

/** The history tabs an action can belong to; mirrors TransactionsScreen's Category. */
export type ActionCategory = 'trade' | 'stake' | 'send' | 'gas';

/**
 * Which tab a transaction belongs to, judged by what the vault was ASKED to do.
 *
 * The tab used to be inferred purely from which tokens moved, and a transaction that moved none
 * fell through to "network fee" — so cancelling a limit order, and approving an asset for the
 * intent protocol, both filed themselves under the fee they happened to pay. An action is direct
 * evidence of intent where a counterparty address is a guess, so it is consulted first.
 *
 * Only actions with an unambiguous home are listed. Anything else, and anything genuinely about
 * the vault's configuration, still lands on the fee tab, which is where a pure config change
 * belongs.
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

/** The tab these actions put a transaction on, or null when none of them says. */
export function categoryForActions(actions: VaultAction[] | undefined): ActionCategory | null {
  for (const a of actions ?? []) {
    const c = ACTION_CATEGORY[a.name];
    if (c) return c;
  }
  return null;
}

export function describeActions(
  actions: VaultAction[] | undefined,
  network: Network,
  t: T,
  orders: Map<string, CowOrder> | undefined,
): string[] {
  if (!actions?.length) return [];
  // A deposit or withdrawal names the protocol it went through. This used to be behind the
  // "DeFi details" switch, which is gone: where the money actually sits is part of what the
  // operation did, not a disclosure to opt into.
  const token = (a: string) => displaySymbol(assetMeta(network, a).symbol);
  const proto = (a: string) => protocolDisplayName(protocolMeta(network, a).name);
  const k = (key: string, params?: Record<string, string | number>) => t(`mobile.actions.${key}`, params);
  const out: string[] = [];
  // Approving a token for limit trading registers the intent adapter in the same transaction the
  // first time; the approval is the story, so that adapter's "enable service" line is dropped.
  const approvedIntents = new Set(
    actions.filter((x) => x.name === 'approveIntentRelayer').map((x) => String(x.args.intent).toLowerCase()),
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
        for (const p of list(g.add)) if (!approvedIntents.has(p.toLowerCase())) out.push(k('enable_service', {name: proto(p)}));
        for (const p of list(g.remove)) out.push(k('disable_service', {name: proto(p)}));
        break;
      case 'updateAssets':
        for (const p of list(g.add)) out.push(k('asset_added', {name: token(p)}));
        for (const p of list(g.remove)) out.push(k('asset_removed', {name: token(p)}));
        break;
      case 'upgradeProtocol':
        out.push(k('upgrade_protocol', {name: proto(String(g.protocol))}));
        break;
      /**
       * The vault's own implementation.
       *
       * It moves no token, so the history has nothing else to go on: before this it decoded to a
       * name with no line, and the row came out as the relayer's fee and nothing more — which
       * reads as a network fee, the one thing it is not.
       */
      case 'upgrade':
        out.push(k('upgrade_vault'));
        break;
      case 'setAssetManager':
        out.push(k('asset_manager_set'));
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
        out.push(k('gasless_set'));
        break;
      case 'disableGasless':
        out.push(k('gasless_disabled'));
        break;
      case 'updatePaymentRisk':
        out.push(k('payment_risk'));
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
        out.push(k('recipient_added'));
        break;
      case 'removeWhitelistedRecipients':
        out.push(k('recipient_removed'));
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
        // marketSell/marketBuy, deposit/withdraw, send, liquidity: the legs already say it.
        break;
    }
  }
  return [...new Set(out)];
}

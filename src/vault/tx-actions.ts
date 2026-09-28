/**
 * What a transaction did, from the server's decoded calldata (`actions` on the transfers feed), as
 * one readable line per action. Movement actions (market swaps, deposits, withdrawals, sends) are
 * already told by the transfer legs, so they yield nothing here; configuration actions, which move
 * nothing but their gas fee, are the point.
 */
import type {Network} from '@/core/chain';
import {assetMeta} from '@/core/assets';
import {protocolMeta} from '@/core/protocols';
import {displaySymbol, fmtNum} from '@/core/format';
import {formatUnits} from 'viem';
import type {CowOrder} from '@/vault/limit';

export type VaultAction = {name: string; args: Record<string, string | string[]>};

type T = (key: string, params?: Record<string, string | number>) => string;

const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

/** One line for a CoW order: "0.1 ETH → 250 USDC" (sell for buy), from the order's raw amounts. */
function describeOrder(o: CowOrder, network: Network): string {
  const sell = assetMeta(network, o.sellToken as `0x${string}`);
  const buy = assetMeta(network, o.buyToken as `0x${string}`);
  const amt = (raw: string, dec: number) => fmtNum(Number(formatUnits(BigInt(raw), dec)));
  return `${amt(o.sellAmount, sell.decimals)} ${displaySymbol(sell.symbol)} → ${amt(o.buyAmount, buy.decimals)} ${displaySymbol(buy.symbol)}`;
}

export function describeActions(actions: VaultAction[] | undefined, network: Network, t: T, orders?: Map<string, CowOrder>): string[] {
  if (!actions?.length) return [];
  const token = (a: string) => displaySymbol(assetMeta(network, a).symbol);
  const proto = (a: string) => protocolMeta(network, a).name;
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
      case 'createSubVault':
        out.push(k('sub_created'));
        break;
      case 'fundSubVault':
        out.push(k('sub_funded'));
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

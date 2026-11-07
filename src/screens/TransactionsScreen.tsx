import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useVaultTransactions} from '@/vault/useVaultTransactions';
import type {Operation, TransferRow} from '@/vault/transactions';
import {TokenIcon} from '@/components/TokenIcon';
import {SettingsIcon} from '@/components/SettingsIcon';
import {Sheet} from '@/components/Sheet';
import {getAssetManager} from '@/vault/delegate';
import {Amount} from '@/components/Amount';
import {GasIcon} from '@/components/GasIcon';
import {splitMarketSwap, netTrade, isReceiptToken, STAKE_TOKENS, SUPPLY_TOKENS, STAKE_COUNTERPARTY, SUPPLY_COUNTERPARTY, BITTY_FEE_COLLECTORS} from '@/vault/market-trades';
import {fmtNum, fmtShort, displaySymbol, shortAddress} from '@/core/format';
import {EXPLORER_TX, type Network} from '@/core/chain';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {asUnderlying, categoryForActions, defiMoveFromActions, defiMovesFromActions, describeActions, earnProtocolName, ordersBySetup, stakeClaimFromActions, orderTrade, swapFromActions} from '@/vault/tx-actions';
import {GPV2_SETTLEMENT, fetchRecentOrders, type CowOrder} from '@/vault/limit';

import {currentCatalog} from '@/core/asset-catalog';
import {openLink} from '@/core/open-link';
import {attemptTrade, isFailure, useVaultAttempts, wasSent, type Attempt} from '@/vault/attempts';
import {formatEth} from '@/vault/direct';
import {formatUnits} from 'viem';
import {protocolDisplayName} from '@/core/protocols';
import {assetMeta, RECEIPT_TOKENS} from '@/core/assets';
import {susdsRate} from '@/vault/yielding';
import {feeHistory, useUpgradeVersions, type OpDetails} from '@/vault/tx-details';

const fmtAmt = (v: string | null): string => fmtNum(Number(v ?? '0'));
const fmtN = fmtNum;

/**
 * The timestamp on a history row: day, month and time, no year.
 *
 * The list is newest first and reaches back months, not decades, so the year repeated on every
 * row said nothing and crowded out the time, which is what tells two transactions on the same day
 * apart. Fields rather than a format string, so each locale still orders and punctuates its own
 * way — 1月5日 09:30 in Chinese, 5 Jan 09:30 in English.
 */
function fmtDate(ts: string | null, locale: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}

const lc = (s?: string | null) => (s ?? '').toLowerCase();

// One transaction can be a multicall of several vault functions (withdraw from Sky, then market-sell
// the proceeds). Each shows in full, as its own titled part, rather than one title with stray legs.
type Part = {
  title: string;
  swap: ReturnType<typeof netTrade>;
  legs: TransferRow[];
  // For a plain send or receive: who the other side was. Sends show "to", receives show "from".
  counterparty?: {address: string; direction: 'to' | 'from'};
  // For an Earn move: the protocol the money went to or came from, "to Aave V3", on the amount line.
  via?: string;
};
/** The web's own grouping of an operation, in its order. */
type Category = 'trade' | 'stake' | 'send' | 'receive' | 'settings' | 'gas';
const CATEGORY_ORDER: Category[] = ['trade', 'stake', 'send', 'receive', 'settings', 'gas'];

type OpView = {
  parts: Part[];
  fee: TransferRow | null;
  // Configuration the transaction performed (approvals, services, assets, ...), one line each.
  details: string[];
  /** Which tab it belongs to; taken from what the parts turned out to be. */
  category: Category;
};

type T = (key: string, params?: Record<string, string | number>) => string;

/** Turn a raw tx's legs into readable, typed parts — the same categories the web history shows. */
export function classify(
  op: Operation,
  network: Network,
  t: T,
  orders: Map<string, CowOrder> | undefined,
  /** Joins the two halves of a trade title the way the language writes them. See {joinWords}. */
  words: (...parts: (string | false | null | undefined)[]) => string,
  /** What the history around it says this transaction changed — see vault/tx-details. */
  opDetails?: OpDetails,
  /** USDC per receipt token where it is not one to one (sUSDS), by lowercase address. */
  rates?: Map<string, number>,
  /** The limit order this transaction set up, when it was one: see {ordersBySetup}. */
  placed?: CowOrder,
): OpView {
  // A position's receipt token is never shown as itself: an aWETH or sUSDS leg is told as the WETH
  // or USDC it stands for, at its rate. The address stays, so it is still recognised below.
  const legs = op.legs.map((l) => asUnderlying(l, network, rates));
  // The gasless relay fee leg (paid to Bitty's fee collector) — shown on its own line, not as a transfer.
  // A market trade pays the same Safe twice: the adapter's 0.2% during the swap, then the relay fee
  // after it. The feed lists a transaction's legs newest log first, so the first match is the relay
  // fee — ponytail: relies on that order (the feed carries no logIndex); match by amount if it changes.
  const fee = legs.find((l) => l.direction === 'out' && BITTY_FEE_COLLECTORS.has(lc(l.counterparty))) ?? null;
  const core = legs.filter((l) => l !== fee);

  const swapLegs = splitMarketSwap(core);
  const swapSet = new Set(swapLegs);
  let swap = swapLegs.length ? netTrade(swapLegs) : null;
  let rest = core.filter((l) => !swapSet.has(l));

  // The feed can miss a market swap's legs — on Sepolia the bought WETH leg is not indexed, leaving
  // only the sold-token out-legs, which the heuristic below would read as a plain send. The decoded
  // calldata is authoritative: when it says a market swap happened, name it one and draw it from the
  // call's own figures, pulling its two tokens out of `rest` so no phantom "Sent"/"Received" part is
  // produced from the one-sided legs.
  if (!swap) {
    const fromAction = swapFromActions(op.actions, network, core);
    if (fromAction) {
      swap = fromAction;
      const swapTokens = new Set([fromAction.sold.address, fromAction.bought.address].map(lc));
      rest = rest.filter((l) => !swapTokens.has(lc(l.assetAddress)));
    }
  }

  const parts: Part[] = [];
  const via = (out: boolean, protocol: string, asset?: string) => {
    const name = earnProtocolName(network, protocol, asset);
    return name ? t(out ? 'mobile.actions.to_protocol' : 'mobile.actions.from_protocol', {name}) : undefined;
  };
  // What the parts turned out to be, for the tab this row belongs to.
  const kinds = {stake: false, supply: false, sent: false, received: false};
  if (swap) {
    // A swap against the CoW settlement contract is a limit or TWAP order being filled by a solver —
    // its own transaction, separate from the approval that was relayed earlier. Side is read off the
    // legs: the non-stable leg is the base; receiving it is a buy.
    const viaCow = swapLegs.some((l) => lc(l.counterparty) === GPV2_SETTLEMENT.toLowerCase());
    if (viaCow) {
      // By symbol, not address: an order paid from a position sells its aToken or sUSDS, which is
      // told as the USDC it stands for (see {asUnderlying}) but keeps the receipt's own address.
      const stable = new Set(currentCatalog(network).filter((a) => a.kind === 'stable').map((a) => a.symbol.toUpperCase()));
      const soldStable = stable.has(swap.sold.symbol.toUpperCase());
      const boughtStable = stable.has(swap.bought.symbol.toUpperCase());
      const isBuy = soldStable && !boughtStable ? true : boughtStable && !soldStable ? false : false;
      const kind = op.settlement?.twap ? t('vault.twap') : t('vault.limit');
      // The badge-sized side word, as on the Trade screen's own order rows: the buttons' fuller
      // wording (Chinese 买入 / 卖出) belongs on a button, not in a title beside the type.
      //
      // Joined through `words`, not with a template literal: Chinese and Japanese run the two
      // halves together (限价买, not 限价 买), and a hardcoded space put one here long after the
      // Trade screen's own rows had stopped using one.
      parts.push({title: words(kind, t(isBuy ? 'mobile.trade.buy_short' : 'mobile.trade.sell_short')), swap, legs: []});
    } else {
      parts.push({title: t('vault.market_trade'), swap, legs: []});
    }
  }

  // Yield/lend ops are recognized by a receipt token (sUSDS/stETH, aTokens) OR the underlying protocol
  // contract as counterparty (covers testnet receipt tokens we don't enumerate). The principal is the
  // non-receipt side; its direction (leaving the vault = deposit, arriving = withdraw) types it.
  /**
   * Deposits and withdrawals, one part EACH, from the calls themselves. A move from Flexible Yield
   * to Flexible Lend is a withdraw and a deposit in one transaction, and it used to come out as one
   * "Withdraw" with both legs under it. Each part takes the leg that matches it (same asset and
   * direction), or the call's own amount when the feed has none; the receipt-token side is never
   * shown. Whatever legs are left are classified as before.
   */
  const moves = swap ? [] : defiMovesFromActions(op.actions, network);
  if (moves.length > 0) {
    const used = new Set<TransferRow>();
    for (const m of moves) {
      const dir = m.out ? 'out' : 'in';
      const leg = rest.find((l) => !used.has(l) && !isReceiptToken(l.assetAddress) && lc(l.assetAddress) === lc(m.asset) && l.direction === dir);
      if (leg) used.add(leg);
      const meta = assetMeta(network, m.asset);
      const shown: TransferRow = leg ?? {
        txHash: op.txHash,
        direction: dir,
        counterparty: null,
        amount: formatUnits(m.amount, meta.decimals),
        assetSymbol: meta.symbol,
        assetAddress: m.asset,
        category: 'erc20',
        blockNum: op.blockNum,
        timestamp: op.timestamp,
      };
      if (m.kind === 'stake') kinds.stake = true;
      else kinds.supply = true;
      parts.push({
        title: t(m.kind === 'stake' ? (m.out ? 'vault.deposit_to_earn' : 'vault.withdraw_from_earn') : m.out ? 'vault.supply_to_flexible_lend' : 'vault.withdraw_from_flexible_lend'),
        swap: null,
        legs: [shown],
        via: via(m.out, m.protocol, m.asset),
      });
    }
    rest = rest.filter((l) => !used.has(l) && !isReceiptToken(l.assetAddress));
  }

  // Claiming a Lido unstake brings WETH in from the adapter, which the rules below read as a
  // payment received. It is the end of a withdrawal from Earn, and says so.
  const claimFrom = swap ? null : stakeClaimFromActions(op.actions);
  if (claimFrom !== null) {
    kinds.stake = true;
    const legs = rest.filter((l) => l.direction === 'in' && !isReceiptToken(l.assetAddress));
    // Named by the Earn route, as the withdrawal that queued it was: the adapter's address is not
    // always one this build knows, and an unknown one came out as a bare "0x12…ab".
    // Only Lido queues its withdrawals, so a claim is Lido's whether or not its adapter is known.
    parts.push({title: t('mobile.actions.claim_from', {name: t('vault.flexible_yield')}), swap: null, legs, via: t('mobile.actions.from_protocol', {name: (claimFrom && earnProtocolName(network, claimFrom, 'WETH')) || protocolDisplayName('Lido')})});
    rest = rest.filter((l) => !legs.includes(l));
  }

  if (rest.length > 0 && moves.length === 0 && claimFrom === null) {
    // What the CALL says, where there is a call. The receipt side of an Earn move is often
    // invisible — the indexer tracks no aTokens, so an Aave supply shows one outgoing leg and
    // nothing coming back, which the transfer rules below read as money sent to a stranger.
    const move = defiMoveFromActions(op.actions, network);
    const isStake = move ? move.kind === 'stake' : rest.some((l) => STAKE_TOKENS.has(lc(l.assetAddress)) || STAKE_COUNTERPARTY.has(lc(l.counterparty)));
    const isSupply = move ? move.kind === 'supply' : rest.some((l) => SUPPLY_TOKENS.has(lc(l.assetAddress)) || SUPPLY_COUNTERPARTY.has(lc(l.counterparty)));
    const principal = rest.filter((l) => !isReceiptToken(l.assetAddress));
    const principalOut = move ? move.out : principal.some((l) => l.direction === 'out');
    const hasIn = rest.some((l) => l.direction === 'in');
    const hasOut = rest.some((l) => l.direction === 'out');
    if (isStake) {
      kinds.stake = true;
      parts.push({title: principalOut ? t('vault.deposit_to_earn') : t('vault.withdraw_from_earn'), swap: null, legs: principal, via: move ? via(move.out, move.protocol, move.asset) : undefined});
    } else if (isSupply) {
      kinds.supply = true;
      parts.push({title: principalOut ? t('vault.supply_to_flexible_lend') : t('vault.withdraw_from_flexible_lend'), swap: null, legs: principal, via: move ? via(move.out, move.protocol, move.asset) : undefined});
    } else if (hasIn && !hasOut) {
      kinds.received = true;
      const from = rest.find((l) => l.counterparty)?.counterparty;
      parts.push({title: t('vault.received'), swap: null, legs: rest, counterparty: from ? {address: from, direction: 'from'} : undefined});
    } else if (hasOut && !hasIn) {
      kinds.sent = true;
      const to = rest.find((l) => l.counterparty)?.counterparty;
      parts.push({title: t('vault.sent'), swap: null, legs: rest, counterparty: to ? {address: to, direction: 'to'} : undefined});
    } else {
      // Both directions but not a recognized swap/stake — still a trade-like exchange (e.g. wrap, LP).
      parts.push({title: t('vault.trade'), swap: null, legs: rest});
    }
  }

  const described = describeActions(op.actions, network, t, orders, opDetails, true);
  /**
   * The tab a row lands on.
   *
   * A swap is unarguable, so it leads. Then what the vault was ASKED to do, because an action is
   * direct evidence where a counterparty address is a guess — this is what keeps a cancelled limit
   * order and an intent approval on Trade, and the keeper's sweep on Earn, instead of dropping
   * them all on the fee tab for having moved nothing the heuristic recognised. Only then the
   * tokens that moved, and last the fee tab, which is left holding genuine configuration changes.
   */
  const category: Category =
    swap || placed
      ? 'trade'
      : (categoryForActions(op.actions) ??
        (kinds.stake || kinds.supply
          ? 'stake'
          : kinds.sent
            ? 'send'
            : kinds.received
              ? 'receive'
              : 'gas'));
  // The relay fee is not a detail: every row carries it in its footer, beside the date.
  const details = described;
  if (parts.length === 0) {
    /**
     * Nothing visible moved but the fee. What the row is called then comes from the CALL.
     *
     * A swap is the case that needed naming. {describeActions} says nothing for marketSell and
     * marketBuy — "the legs already say it", which is true of every row that has legs — so a swap
     * whose legs the feed cannot see fell all the way through to the generic "Transaction", leaving
     * a row whose only content was the relayer's fee. It read as a network fee, which is the one
     * thing it is not.
     *
     * The feed can miss a swap's legs for an ordinary reason: it is built from `Transfer` logs for a
     * FIXED list of tokens, so a pair involving something the deployed catalog does not carry yet
     * moves real money and emits logs nobody is listening for. The transaction succeeded; only its
     * itemisation is missing. So this names it a market trade and does not call it failed — a
     * failure reverts, pays no fee, and leaves no row here at all.
     */
    const swapped = (op.actions ?? []).some((a) => a.name === 'marketSell' || a.name === 'marketBuy');
    // A limit order's setup: the order is the story, its setup the lines under it.
    if (placed) {
      parts.push({title: t('mobile.actions.limit_order'), swap: orderTrade(placed, network), legs: []});
      return {parts, fee, details, category};
    }
    parts.push({
      title: swapped ? t('vault.market_trade') : (details[0] ?? t('mobile.home.transaction')),
      swap: null,
      legs: [],
    });
    return {parts, fee, details: swapped ? details : details.slice(1), category};
  }
  return {parts, fee, details, category};
}

function Leg({r, counterparty, via}: {r: TransferRow; counterparty?: Part['counterparty']; via?: string}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const out = r.direction === 'out';
  return (
    <View style={styles.leg}>
      <TokenIcon symbol={r.assetSymbol ?? '?'} size={20} />
      <Text style={[styles.legText, out ? styles.outC : styles.inC]}>
        {out ? '−' : '+'}
        <Amount v={fmtAmt(r.amount)} /> {displaySymbol(r.assetSymbol) || '?'}
      </Text>
      {/* Who the other side was, as plain text.
          It was a copy control, which put a second tappable thing inside a row that is itself a
          link to the explorer — and the explorer is where anyone who wants the address is going
          anyway, with the full one and everywhere it has been. A counterparty here is read, to
          recognise who was paid; it is not something to pick up and carry. */}
      {counterparty ? (
        <View style={styles.counterparty}>
          <Text style={styles.counterpartyText} numberOfLines={1}>
            {t(counterparty.direction === 'to' ? 'mobile.home.to_address' : 'mobile.home.from_address', {address: shortAddress(counterparty.address)})}
          </Text>
        </View>
      ) : via ? (
        // The protocol reads as part of the amount ("+1.2 WETH from Lido V2"), so it follows it
        // rather than sitting at the row's far edge like a counterparty address.
        <View style={styles.via}>
          <Text style={styles.counterpartyText} numberOfLines={1}>
            {via}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** The ETH the owner wallet paid in gas, drawn where a relayed row draws the relay fee. */
function OwnerFee({fee}: {fee: bigint}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  return (
    <>
      <GasIcon color={c.subtext} size={12} />
      <Text style={styles.fee}>
        <Amount v={formatEth(fee)} size={12} color={c.subtext} /> ETH
      </Text>
    </>
  );
}

function Op({
  op,
  explorer,
  network,
  orders,
  details,
  rates,
  placed,
  onManager,
}: {
  op: Operation;
  explorer: string;
  network: Network;
  orders?: Map<string, CowOrder>;
  details?: OpDetails;
  rates?: Map<string, number>;
  placed?: CowOrder;
  /** Set when the vault's asset manager signed this operation: opens the sheet that says so. */
  onManager?: () => void;
}) {
  const {t, language, words} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  // The row subscribes for itself. This is the classify call the list actually RENDERS from — the
  // one in the screen above only decides which tabs exist — so without it a flip of the switch
  // left every line on screen as it was.
  const v = classify(op, network, t, orders, words, details, rates, placed);
  return (
    <Pressable style={styles.op} onPress={() => openLink(explorer + op.txHash, 'Etherscan')}>
      {v.parts.map((part, i) => (
        <View key={`${op.txHash}-${i}`} style={i > 0 ? styles.partGap : undefined}>
          {/* The title owns the line. It shared it with the timestamp until a Russian
              "Вывести из Гибкого кредитования" ran into the date and pushed it off the row;
              the timestamp moved to the footer, where it belongs anyway — it describes the
              transaction, not this one part of it. */}
          <View style={[styles.opHeader, i === 0 && onManager ? styles.opHeaderRow : null]}>
            <Text style={[styles.title, styles.flex]}>{part.title}</Text>
            {i === 0 && onManager ? (
              <Pressable hitSlop={10} onPress={onManager} accessibilityLabel={t('mobile.actions.by_asset_manager')}>
                <SettingsIcon name="delegation" size={22} round />
              </Pressable>
            ) : null}
          </View>

          {part.swap ? (
            <View style={styles.swapRow}>
              <View style={styles.swapSide}>
                <TokenIcon symbol={part.swap.sold.symbol} size={20} />
                <Text style={styles.swapText}><Amount v={fmtN(part.swap.sold.amount)} size={15} /> {displaySymbol(part.swap.sold.symbol)}</Text>
              </View>
              <Text style={styles.swapArrow}>→</Text>
              <View style={styles.swapSide}>
                <TokenIcon symbol={part.swap.bought.symbol} size={20} />
                <Text style={[styles.swapText, styles.inC]}><Amount v={fmtN(part.swap.bought.amount)} size={15} color={c.success} /> {displaySymbol(part.swap.bought.symbol)}</Text>
              </View>
            </View>
          ) : null}

          {part.legs.map((r, li) => (
            <Leg key={`${r.txHash}-${r.assetAddress}-${r.direction}-${r.amount}`} r={r} counterparty={li === 0 ? part.counterparty : undefined} via={part.via} />
          ))}
        </View>
      ))}
      {v.details.map((d) => (
        <Text key={d} style={styles.detail}>
          {d}
        </Text>
      ))}

      <View style={styles.footer}>
        <View style={styles.meta}>
          {/* The gasless relay fee, split out of the transfer legs so it never inflates a send, is
              shown on every row: it left the vault, whatever the operation was. No minus: beside
              the gas mark a fee is only ever a cost. */}
          <Text style={styles.date}>{fmtDate(op.timestamp, language)}</Text>
          {v.fee ? (
            <>
              <GasIcon color={c.subtext} size={12} />
              <Text style={styles.fee}>
                <Amount v={fmtAmt(v.fee.amount)} /> {displaySymbol(v.fee.assetSymbol)}
              </Text>
            </>
          ) : op.ownerFee ? (
            // The owner wallet sent it and paid the gas itself: ETH from that wallet, as the
            // server read it off the receipt.
            <OwnerFee fee={op.ownerFee} />
          ) : null}
        </View>
        <Text style={styles.link}>{t('mobile.home.view')} ↗</Text>
      </View>
    </Pressable>
  );
}



/**
 * An operation that was asked for and did not succeed.
 *
 * Its own row rather than an {Op}, because there is nothing for an Op to render: the history feed is
 * built from ERC-20 Transfer logs, and a reverted transaction emits none while a refused one has no
 * transaction at all. So it moved no money, carries no legs and has no category. It comes from the
 * relayer's own record — see {useVaultAttempts} — which is the only account of the attempt, and the
 * reason an operation attempted on the web shows up here too.
 *
 * Says what the operation WAS, decoded from the calldata the relayer was handed, and why it did not
 * happen. A submitted-then-reverted one links to its receipt; a refusal has nothing to link to and
 * keeps the relayer's reason instead, which is then the only place that reason exists.
 */
function FailedOp({tx, explorer, network}: {tx: Attempt; explorer: string; network: Network}) {
  const {t, language} = useT();
  const styles = useStyles(makeStyles);
  const onChain = wasSent(tx);
  /**
   * What was attempted, in the words the rest of the page uses.
   *
   * {describeActions} is the same decoder the ordinary rows are labelled by, so a failed deposit
   * reads as "Deposit" here exactly as a successful one does above it — the row differs in what
   * became of it, not in what it is called.
   *
   * A SWAP is the exception, and it is the reason this is not one line. `describeActions` says
   * nothing at all for marketSell and marketBuy, on the stated grounds that "the legs already say
   * it" — which holds for every row that moved something and is precisely false here: a trade that
   * failed moved nothing, so there were no legs and the row fell through to the generic
   * "Transaction". Worse, an attempt that carried its allowlist setup alongside the swap titled
   * itself with the setup, naming the least interesting call in the batch.
   *
   * So a swap is named from the legs it ASKED for, which the server recorded off the calldata —
   * the same figures the order lists draw their row from. See {attemptTrade}.
   */
  const trade = attemptTrade(tx, network);
  const lines = describeActions(tx.actions, network, t, undefined);
  /**
   * The same title a SUCCESSFUL market trade carries, not a sentence of its own.
   *
   * The row was titled "Pay 500 USDC to buy 67 UNI" and said nothing else, where the row above it
   * for a trade that worked says "Market trade" and draws the two legs. Two shapes for one kind of
   * event, and the failed one the odd one out — on a page read by scanning down the left edge, that
   * is the thing that makes it look wrong rather than merely different.
   */
  const title = trade ? t('vault.market_trade') : (lines[0] ?? t('mobile.home.transaction'));
  return (
    <Pressable
      style={styles.op}
      disabled={!onChain}
      onPress={onChain ? () => openLink(explorer + tx.txHash, 'Etherscan') : undefined}>
      <View style={styles.opHeader}>
        <Text style={styles.title}>{title}</Text>
      </View>
      {/* The legs, drawn exactly as a completed swap's are — same icons, same arrow, same
          metrics — because it is the same kind of event and the only difference is how it ended.
          The received side is NOT green here: that colour means money arrived, and none did. The
          figures are what the order asked for, which is all a trade that never ran can report. */}
      {trade ? (
        <View style={styles.swapRow}>
          <View style={styles.swapSide}>
            <TokenIcon symbol={trade.sold.symbol} size={20} />
            <Text style={styles.swapText}>
              <Amount v={fmtN(trade.sold.amount)} size={15} /> {displaySymbol(trade.sold.symbol)}
            </Text>
          </View>
          <Text style={styles.swapArrow}>→</Text>
          <View style={styles.swapSide}>
            <TokenIcon symbol={trade.bought.symbol} size={20} />
            <Text style={styles.swapText}>
              <Amount v={fmtN(trade.bought.amount)} size={15} /> {displaySymbol(trade.bought.symbol)}
            </Text>
          </View>
        </View>
      ) : null}
      {/* Two outcomes, two words. A revert means the chain ran it and rejected it; a refusal means
          the relayer turned it down before signing, so nothing happened at all and it can simply be
          tried again once whatever it objected to is fixed. */}
      <Text style={styles.failed}>
        {tx.status === 'refused' ? t('vault.tx_not_included') : t('vault.tx_failed')}
      </Text>
      {tx.reason ? (
        <Text style={styles.detail} numberOfLines={3}>
          {tx.reason}
        </Text>
      ) : null}
      <View style={styles.footer}>
        <View style={styles.meta}>
          {/* Through {fmtDate}, like every other row: a bare toLocaleString prints
              "10/8/2026, 10:25:35 PM" against the "8 Oct, 22:25" above it, which reads as a
              different kind of row rather than the same row with a worse outcome. */}
          <Text style={styles.date}>{fmtDate(new Date(tx.at * 1000).toISOString(), language)}</Text>
        </View>
        {onChain ? <Text style={styles.link}>{t('mobile.home.view')} ↗</Text> : null}
      </View>
    </Pressable>
  );
}

export function TransactionsScreen() {
  const {t, words} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const {ops, loading, error, refresh} = useVaultTransactions(vault, network);
  // The vault's CoW orders by uid, so a cancellation can say which order it cancelled.
  const [orders, setOrders] = React.useState<Map<string, CowOrder>>(() => new Map());
  React.useEffect(() => {
    let live = true;
    if (!vault) return;
    fetchRecentOrders(vault, network)
      .then((list) => live && setOrders(new Map(list.map((o) => [o.uid.toLowerCase(), o]))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vault, network, ops]);
  // The pull spinner belongs to a pull only. The first load shows the inline spinner below; tying
  // the pull control to `loading` made both appear at once on entry.
  const [pulled, setPulled] = React.useState(false);
  const onPull = React.useCallback(() => {
    setPulled(true);
    refresh();
  }, [refresh]);
  React.useEffect(() => {
    if (!loading) setPulled(false);
  }, [loading]);
  const explorer = EXPLORER_TX[network];

  /**
   * Operations that did not succeed — from the relayer's own record, not this device's.
   *
   * The transfer feed cannot carry them: a reverted transaction emits no logs and a refused one has
   * no transaction. They used to be kept locally, which meant an attempt made on the web never
   * appeared here. Now the server writes every attempt down and both clients read it.
   *
   * Not filtered by the tabs: a failure moved nothing, so {classify} has no category to put it in,
   * and a row that answers no question must not be hidden by one.
   */
  /**
   * What a settings row changed beyond its own call: the fee-coin setting before it, from the next
   * older one in this history, and an upgrade's versions either side, from the chain.
   */
  const feePrev = React.useMemo(() => feeHistory(ops), [ops]);
  /**
   * What one sUSDS is worth in USDC on this chain, so a row that moved it can say so in USDC. Read
   * once per chain; aTokens need no rate (one to one with their underlying).
   */
  const [rates, setRates] = React.useState<Map<string, number>>(() => new Map());
  React.useEffect(() => {
    let live = true;
    const susds = Object.entries(RECEIPT_TOKENS[network]).find(([, r]) => r.symbol === 'sUSDS')?.[0];
    if (!susds) return;
    susdsRate(network).then((r) => live && setRates(new Map([[susds, r]])));
    return () => {
      live = false;
    };
  }, [network]);
  const upgrades = useUpgradeVersions(network, vault, ops);
  const detailsOf = (op: Operation): OpDetails | undefined => {
    const h = op.txHash.toLowerCase();
    const v = upgrades.get(h);
    if (!feePrev.has(h) && !v) return undefined;
    return {feePrev: feePrev.get(h), versionFrom: v?.from, versionTo: v?.to};
  };

  const {attempts} = useVaultAttempts(vault, network, loading ? 0 : 1);
  const failures = React.useMemo(() => attempts.filter(isFailure), [attempts]);

  /**
   * No "Confirming" tab.
   *
   * It listed the writes this device had sent and was waiting on, which is now the toast's job —
   * and the toast says it where the user is, with the hash and a link, instead of on a page they
   * have to go and find. Keeping both meant a transaction announced itself twice and lingered in
   * the second place long after it had settled. The pending store still exists: it is what the
   * toast watches for settlement, and what tells the balances to re-read. See {showTx}.
   */
  const [tab, setTab] = React.useState<Category | 'all'>('all');

  // One tab per category that has entries, as on the web.
  const placedBy = React.useMemo(() => ordersBySetup(ops, orders), [ops, orders]);
  /**
   * Every address that has been this vault's asset manager: the one appointed now, and each one a
   * past `setAssetManager` in the history named — so an operation a since-revoked manager ran is
   * still marked as theirs.
   */
  const [currentManager, setCurrentManager] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    if (vault) getAssetManager(vault, network).then((m) => live && setCurrentManager(m.manager.toLowerCase()));
    return () => {
      live = false;
    };
  }, [vault, network]);
  const managers = React.useMemo(() => {
    const out = new Set<string>();
    if (currentManager && !/^0x0+$/.test(currentManager)) out.add(currentManager);
    for (const op of ops)
      for (const a of op.actions ?? [])
        if (a.name === 'setAssetManager') {
          const m = String((a.args as Record<string, unknown> | undefined)?.assetManager ?? '').toLowerCase();
          if (m && !/^0x0+$/.test(m)) out.add(m);
        }
    return out;
  }, [ops, currentManager]);
  const [managerSheet, setManagerSheet] = React.useState<string | null>(null);
  const views = React.useMemo(
    () => new Map(ops.map((op) => [op.txHash, classify(op, network, t, orders, words, undefined, rates, placedBy.get(op.txHash))])),
    [ops, network, t, orders, words, rates, placedBy],
  );
  const tabs: {key: Category | 'all'; label: string}[] = [
    {key: 'all', label: t('vault.all')},
    ...CATEGORY_ORDER.filter((cat) => ops.some((op) => views.get(op.txHash)?.category === cat)).map((cat) => ({
      key: cat,
      label: t(
        cat === 'trade'
          ? 'vault.trade'
          : cat === 'stake'
            ? 'vault.earn'
            : cat === 'send'
              ? 'vault.sent'
              : cat === 'receive'
                ? 'vault.received'
                : cat === 'settings'
                  ? 'vault.settings'
                  : 'mobile.settings.gas',
      ),
    })),
  ];
  // A category that has emptied out hands back to All.
  React.useEffect(() => {
    if (!tabs.some((x) => x.key === tab)) setTab('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length]);
  const shown = tab === 'all' ? ops : ops.filter((op) => views.get(op.txHash)?.category === tab);

  /**
   * The feed and the failures, as ONE list in time order.
   *
   * The failures were a block above everything, which put a refusal from last week over a deposit
   * from a minute ago. They are not a separate kind of news — they are things that happened to this
   * vault, in the same sequence as everything else — so they sort in with the rest and the newest is
   * at the top wherever it came from.
   *
   * Still unfiltered by the tabs: a failure moved nothing, so {classify} cannot put it in a
   * category, and a row that answers no question must not be hidden by one.
   */
  const feed = React.useMemo(() => {
    const at = (op: Operation) => (op.timestamp ? Date.parse(op.timestamp) : op.blockNum);
    const rows: {key: string; at: number; op?: Operation; tx?: Attempt}[] = [
      ...shown.map((op) => ({key: op.txHash, at: at(op), op})),
      ...failures.map((tx) => ({key: `relay-${tx.id}`, at: tx.at * 1000, tx})),
    ];
    return rows.sort((a, b) => b.at - a.at);
  }, [shown, failures]);

  /**
   * Ten rows at a time.
   *
   * The page drew every operation the vault ever made the moment it opened — each one a card of
   * token icons, amounts and counterparties — so a vault with a long history opened slowly and
   * the first screenful waited on hundreds below it. Now the first ten draw, and the next ten join
   * as the list nears its end; a FlatList also leaves the cards scrolled far off screen undrawn.
   * A new tab, vault or chain starts again from the first page.
   */
  const [pages, setPages] = React.useState(1);
  React.useEffect(() => setPages(1), [tab, vault, network]);
  const visible = React.useMemo(() => feed.slice(0, pages * PAGE_SIZE), [feed, pages]);
  const more = visible.length < feed.length;
  const loadMore = React.useCallback(() => {
    if (more) setPages((n) => n + 1);
  }, [more]);

  const header = (
    <>
      {tabs.length > 2 ? (
        <View style={styles.tabStrip}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
            {tabs.map((x) => (
              <Pressable
              key={x.key}
              style={styles.tab}
              onPress={() => setTab(x.key)}>
                <Text style={[styles.tabText, tab === x.key && styles.tabTextOn]}>{x.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {error ? <Text style={styles.err}>{error}</Text> : null}
    </>
  );

  return (
    <>
      <FlatList
        data={error ? [] : visible}
        keyExtractor={(row) => row.key}
        renderItem={({item: row}) =>
          row.op ? (
            <Op op={row.op} explorer={explorer} network={network} orders={orders} details={detailsOf(row.op)} rates={rates} placed={placedBy.get(row.op.txHash)} onManager={row.op.signer && managers.has(row.op.signer) ? () => setManagerSheet(row.op!.signer!) : undefined} />
          ) : (
            <FailedOp tx={row.tx!} explorer={explorer} network={network} />
          )
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          error ? null : loading && ops.length === 0 ? <ActivityIndicator color={c.accent} /> : <Text style={styles.note}>{loading ? '' : t('vault.no_operations')}</Text>
        }
        // The next page while the last screenful is still in view, so it is there before the end is.
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        ListFooterComponent={more ? <ActivityIndicator color={c.subtext} style={styles.more} /> : null}
        initialNumToRender={PAGE_SIZE}
        windowSize={7}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pulled && loading} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}
      />
      <Sheet visible={managerSheet != null} title={t('vault.asset_manager')} onClose={() => setManagerSheet(null)}>
        <View style={styles.managerSheet}>
          <Text style={styles.managerText}>{t('mobile.actions.by_asset_manager')}</Text>
          <Text style={styles.managerAddr} selectable>
            {managerSheet ?? ''}
          </Text>
        </View>
      </Sheet>
    </>
  );
}

/** Rows drawn per page of the history. */
const PAGE_SIZE = 10;

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  tabStrip: {marginTop: -4, marginBottom: -8},
  tabRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 20, paddingHorizontal: 4},
  tab: {alignItems: 'center', paddingVertical: 6},
  tabText: {color: c.subtext, fontSize: 15, fontWeight: '600'},
  tabTextOn: {color: c.text, fontWeight: '700'},
  content: {flexGrow: 1, padding: 16, gap: 16, paddingBottom: 32},
  op: {backgroundColor: c.card, borderRadius: 20, padding: 18, gap: 12},
  opHeader: {marginBottom: 10},
  opHeaderRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  flex: {flex: 1},
  managerSheet: {paddingHorizontal: 16, paddingVertical: 8, gap: 12},
  managerText: {color: c.text, fontSize: 15, lineHeight: 21},
  managerAddr: {color: c.subtext, fontSize: 14, fontVariant: ['tabular-nums']},
  // A failed row's header carries the ✕, so the title and the control sit on one line.
  failedHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10},
  dismiss: {color: c.subtext, fontSize: 15},
  failed: {color: c.danger, fontSize: 13, fontWeight: '600', marginBottom: 10},
  partGap: {marginTop: 14, gap: 8},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  title: {color: c.text, fontSize: 15, fontWeight: '400'},
  date: {color: c.subtext, fontSize: 12},
  swapRow: {flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap'},
  swapSide: {flexDirection: 'row', alignItems: 'center', gap: 6},
  swapText: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums']},
  swapArrow: {color: c.subtext, fontSize: 15},
  leg: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6},
  counterparty: {marginLeft: 'auto', flexShrink: 1},
  via: {flexShrink: 1},
  counterpartyText: {color: c.subtext, fontSize: 13, fontFamily: undefined},
  detail: {color: c.subtext, fontSize: 13},
  outC: {color: c.warning},
  inC: {color: c.success},
  legText: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums']},
  footer: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 10},
  // Timestamp and fee together on the left; the fee is a pump and a number, no label.
  meta: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1},
  fee: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
  link: {color: c.accent, fontSize: 12, fontWeight: '600'},
  note: {color: c.subtext, fontSize: 14},
  more: {paddingVertical: 8},
  err: {color: c.danger, fontSize: 13},
});

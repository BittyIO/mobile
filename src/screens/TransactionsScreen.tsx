import React from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {useVaultTransactions} from '@/vault/useVaultTransactions';
import type {Operation, TransferRow} from '@/vault/transactions';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {splitMarketSwap, netTrade, isReceiptToken, STAKE_TOKENS, SUPPLY_TOKENS, STAKE_COUNTERPARTY, SUPPLY_COUNTERPARTY, BITTY_FEE_COLLECTOR} from '@/vault/market-trades';
import {fmtNum, displaySymbol} from '@/core/format';
import {EXPLORER_TX, type Network} from '@/core/chain';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {CopyAddress} from '@/components/CopyAddress';
import {describeActions} from '@/vault/tx-actions';
import {GPV2_SETTLEMENT, fetchRecentOrders, type CowOrder} from '@/vault/limit';
import {ASSETS} from '@/core/assets';

const fmtAmt = (v: string | null): string => fmtNum(Number(v ?? '0'));
const fmtN = fmtNum;

function fmtDate(ts: string | null, locale: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale);
}

const lc = (s?: string | null) => (s ?? '').toLowerCase();
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// One transaction can be a multicall of several vault functions (withdraw from Sky, then market-sell
// the proceeds). Each shows in full, as its own titled part, rather than one title with stray legs.
type Part = {
  title: string;
  swap: ReturnType<typeof netTrade>;
  legs: TransferRow[];
  // For a plain send or receive: who the other side was. Sends show "to", receives show "from".
  counterparty?: {address: string; direction: 'to' | 'from'};
};
type OpView = {
  parts: Part[];
  fee: TransferRow | null;
  // Configuration the transaction performed (approvals, services, assets, ...), one line each.
  details: string[];
};

type T = (key: string, params?: Record<string, string | number>) => string;

/** Turn a raw tx's legs into readable, typed parts — the same categories the web history shows. */
function classify(op: Operation, network: Network, t: T, orders?: Map<string, CowOrder>): OpView {
  // The gasless relay fee leg (paid to Bitty's fee collector) — shown on its own line, not as a transfer.
  const fee = op.legs.find((l) => l.direction === 'out' && lc(l.counterparty) === BITTY_FEE_COLLECTOR) ?? null;
  const core = op.legs.filter((l) => l !== fee);

  const swapLegs = splitMarketSwap(core);
  const swapSet = new Set(swapLegs);
  const swap = swapLegs.length ? netTrade(swapLegs) : null;
  const rest = core.filter((l) => !swapSet.has(l));

  const parts: Part[] = [];
  if (swap) {
    // A swap against the CoW settlement contract is a limit or TWAP order being filled by a solver —
    // its own transaction, separate from the approval that was relayed earlier. Side is read off the
    // legs: the non-stable leg is the base; receiving it is a buy.
    const viaCow = swapLegs.some((l) => lc(l.counterparty) === GPV2_SETTLEMENT.toLowerCase());
    if (viaCow) {
      const stable = new Set(ASSETS[network].filter((a) => a.kind === 'stable').map((a) => a.address.toLowerCase()));
      const soldStable = stable.has(swap.sold.address.toLowerCase());
      const boughtStable = stable.has(swap.bought.address.toLowerCase());
      const isBuy = soldStable && !boughtStable ? true : boughtStable && !soldStable ? false : false;
      const kind = op.settlement?.twap ? t('vault.twap') : t('vault.limit');
      parts.push({title: `${kind} ${isBuy ? t('vault.buy') : t('vault.sell')}`, swap, legs: []});
    } else {
      parts.push({title: t('vault.market_trade'), swap, legs: []});
    }
  }

  // Yield/lend ops are recognized by a receipt token (sUSDS/stETH, aTokens) OR the underlying protocol
  // contract as counterparty (covers testnet receipt tokens we don't enumerate). The principal is the
  // non-receipt side; its direction (leaving the vault = deposit, arriving = withdraw) types it.
  if (rest.length > 0) {
    const isStake = rest.some((l) => STAKE_TOKENS.has(lc(l.assetAddress)) || STAKE_COUNTERPARTY.has(lc(l.counterparty)));
    const isSupply = rest.some((l) => SUPPLY_TOKENS.has(lc(l.assetAddress)) || SUPPLY_COUNTERPARTY.has(lc(l.counterparty)));
    const principal = rest.filter((l) => !isReceiptToken(l.assetAddress));
    const principalOut = principal.some((l) => l.direction === 'out');
    const hasIn = rest.some((l) => l.direction === 'in');
    const hasOut = rest.some((l) => l.direction === 'out');
    if (isStake) {
      parts.push({title: principalOut ? t('vault.deposit_to_earn') : t('vault.withdraw_from_earn'), swap: null, legs: principal});
    } else if (isSupply) {
      parts.push({title: principalOut ? t('vault.supply_to_flexible_lend') : t('vault.withdraw_from_flexible_lend'), swap: null, legs: principal});
    } else if (hasIn && !hasOut) {
      const from = rest.find((l) => l.counterparty)?.counterparty;
      parts.push({title: t('vault.received'), swap: null, legs: rest, counterparty: from ? {address: from, direction: 'from'} : undefined});
    } else if (hasOut && !hasIn) {
      const to = rest.find((l) => l.counterparty)?.counterparty;
      parts.push({title: t('vault.sent'), swap: null, legs: rest, counterparty: to ? {address: to, direction: 'to'} : undefined});
    } else {
      // Both directions but not a recognized swap/stake — still a trade-like exchange (e.g. wrap, LP).
      parts.push({title: t('vault.trade'), swap: null, legs: rest});
    }
  }

  const details = describeActions(op.actions, network, t, orders);
  if (parts.length === 0) {
    // Nothing moved but the fee: the transaction IS its configuration change, so it heads the row.
    parts.push({title: details[0] ?? t('mobile.home.transaction'), swap: null, legs: []});
    return {parts, fee, details: details.slice(1)};
  }
  return {parts, fee, details};
}

function Leg({r, counterparty}: {r: TransferRow; counterparty?: Part['counterparty']}) {
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
      {counterparty ? (
        <View style={styles.counterparty}>
          <CopyAddress
            address={counterparty.address}
            label={t(counterparty.direction === 'to' ? 'mobile.home.to_address' : 'mobile.home.from_address', {address: shortAddress(counterparty.address)})}
            textStyle={styles.counterpartyText}
            iconSize={12}
            numberOfLines={1}
          />
        </View>
      ) : null}
    </View>
  );
}

function Op({op, explorer, network, orders}: {op: Operation; explorer: string; network: Network; orders?: Map<string, CowOrder>}) {
  const {t, language} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const v = classify(op, network, t, orders);
  return (
    <Pressable style={styles.op} onPress={() => Linking.openURL(explorer + op.txHash)}>
      {v.parts.map((part, i) => (
        <View key={`${op.txHash}-${i}`} style={i > 0 ? styles.partGap : undefined}>
          <View style={styles.opHeader}>
            <View style={styles.titleRow}>
              <Text style={styles.title}>{part.title}</Text>
            </View>
            {i === 0 ? <Text style={styles.date}>{fmtDate(op.timestamp, language)}</Text> : null}
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
            <Leg key={`${r.txHash}-${r.assetAddress}-${r.direction}-${r.amount}`} r={r} counterparty={li === 0 ? part.counterparty : undefined} />
          ))}
        </View>
      ))}
      {v.details.map((d) => (
        <Text key={d} style={styles.detail}>
          {d}
        </Text>
      ))}

      <View style={styles.footer}>
        {v.fee ? (
          <Text style={styles.fee}>
            {t('mobile.settings.gas')} −<Amount v={fmtAmt(v.fee.amount)} /> {displaySymbol(v.fee.assetSymbol)}
          </Text>
        ) : (
          <View />
        )}
        <Text style={styles.link}>{t('mobile.home.view')} ↗</Text>
      </View>
    </Pressable>
  );
}

export function TransactionsScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
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

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={pulled && loading} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />
      }>
      {error ? (
        <Text style={styles.err}>{error}</Text>
      ) : ops.length === 0 ? (
        <Text style={styles.note}>{loading ? '' : t('vault.no_operations')}</Text>
      ) : (
        ops.map((op) => <Op key={op.txHash} op={op} explorer={explorer} network={network} orders={orders} />)
      )}
      {loading && ops.length === 0 ? <ActivityIndicator color={c.accent} /> : null}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  content: {flexGrow: 1, padding: 20, gap: 12},
  op: {backgroundColor: c.card, borderRadius: 20, padding: 18, gap: 12},
  opHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10},
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
  counterpartyText: {color: c.subtext, fontSize: 13, fontFamily: undefined},
  detail: {color: c.subtext, fontSize: 13},
  outC: {color: c.warning},
  inC: {color: c.success},
  legText: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums']},
  footer: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 10},
  fee: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
  link: {color: c.accent, fontSize: 12, fontWeight: '600'},
  note: {color: c.subtext, fontSize: 14},
  err: {color: c.danger, fontSize: 13},
});

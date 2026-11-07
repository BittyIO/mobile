import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Amount} from '@/components/Amount';
import {TokenIcon} from '@/components/TokenIcon';
import {Pill, type PillTone} from '@/components/ui';
import {displaySymbol} from '@/core/format';
import {useStyles, useColors, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * One order, wherever it is shown.
 *
 * The Trade tab and Order history draw the same thing — a side badge, the leg the order is for,
 * what it went at, and the detail under it — and they used to draw it from two bodies of code.
 * Every change had to be made twice and the two drifted on every one of them: the price appeared
 * on one screen before the other, a finished TWAP showed its settled amount here and its ordered
 * amount there, the parts were a list of rows on one side and label/value lines on the other, and
 * a tiny amount got its zero count dropped to a subscript in Trade and printed raw in history.
 * This is that row, once, with the Trade tab's metrics — it was the one being designed against.
 *
 * What the two screens genuinely differ in is passed in, not re-implemented: Trade collapses its
 * rows and offers a Cancel, history is a record and is always open. Numbers come in as values,
 * not as finished strings, so the row — not its two callers — decides how an amount reads.
 */

/** An amount and what it is denominated in. Formatted by the row, so both screens agree. */
export type Leg = {
  /** Already through fmtShort/fmtAmt: the digits, without the symbol. */
  amount: string;
  symbol: string;
};

/** A value on a detail line: a quiet string (a time, a count) or an amount, which reads loud. */
export type OrderValue = string | Leg;

/** One slot of a TWAP: what it is for, and where it has got to. */
export type OrderPart = {
  label: string;
  state: string;
  /** A slot that has not gone out yet is a plan, not a fact, so it steps back from the ones that have. */
  pending?: boolean;
};

export type OrderRowProps = {
  /** Tints the badge and says which way round the trade is. */
  /** "Limit Buy", "TWAP Sell", "Market Buy". */
  badge: string;
  /** The leg the row is ABOUT: a buy's bought asset, a sell's sold one. */
  /**
   * What the row is FOR, loud. Optional for the one row that cannot know it: a trade this device
   * recorded before it kept the legs, which is still worth listing — see `title`.
   */
  leg?: Leg;
  /**
   * Stands in for {leg} when there is none — the sentence the toast said at the time.
   *
   * Only an attempt that failed ever needs this. It reads quieter than a leg, because it is a
   * description rather than a figure, and nothing should look like an amount that is not one.
   */
  title?: string;
  /** What it went at, or what it asks. Lighter than the amount; omitted when there is none. */
  price?: string | null;
  /** Trails the leg in the label colour — Trade's "(yielding)" on a sale out of a position. */
  note?: string;
  /**
   * Whatever claims the right-hand end: a Cancel, a state pill, a part count.
   *
   * Nothing given, the leg takes that corner instead — which is the rule both screens follow and
   * the reason this is one prop rather than a boolean.
   */
  right?: React.ReactNode;
  /** A TWAP's slots. */
  parts?: OrderPart[];
  /** The order's terms. Hidden behind Details when `onDetails` is given. */
  lines?: [string, OrderValue][];
  /** Opens the terms in a sheet instead of printing them under the parts. */
  onDetails?: () => void;
  /** Left of the footer, opposite Details — the Trade tab's cancel. */
  cancel?: React.ReactNode;
  /**
   * What became of the order, at the foot of the open panel.
   *
   * A TWAP states this per slot, down the right of its parts; an order with no parts had nowhere
   * to say it at all, so an open one and a filled one read identically once the price and the
   * date were accounted for. The foot is where the row's own last word belongs, and the left of
   * it is free on every row that is not a TWAP — the Cancel that sits there on one of those is
   * in the head instead, beside the amount it would be cancelling.
   *
   * It was tried beside the kind, up in the head, which put it on the collapsed row too — but a
   * badge reading "Limit Buy" followed by a chip reading "Expired" is two labels competing to be
   * the thing the row is, and the one that matters while scanning is the kind. No tone makes it
   * a plain label rather than a chip, which is what an order that is still open wants: the foot
   * then reads "Expires · 2d 5h", a deadline rather than a verdict.
   */
  outcome?: {label: string; tone?: PillTone};
  /**
   * And when, opposite it — "Filled · Oct 5, 3:42 PM", "Expires · in 2d 5h".
   *
   * The word and the time are one statement, so they share a line rather than the time sitting
   * as a label-and-value row above it repeating the word the pill has already said. The slot is
   * the one a TWAP gives to Details, which is free on every row that has no parts to detail.
   */
  outcomeAt?: string;
  /**
   * Collapsed rows show their head only.
   *
   * OPEN by default, which is what the order history wants — that page is the record and folds
   * nothing. Which makes this a trap for the Trade panel, where every row starts shut: omitting it
   * there does not get the panel's behaviour, it gets the record's, and the row is stuck open with
   * no way to close it. A caller that folds must pass this AND {onPress}.
   */
  expanded?: boolean;
  /** Tapping the head, or the open panel, which is the bigger target of the two. */
  onPress?: () => void;
  last?: boolean;
  /**
   * One card per row, instead of one card holding the list.
   *
   * The Trade panel's rows are cells of a single card: they sit under a chart and a form and have
   * to pack tight, so a hairline between them is the whole separation. The order history is the
   * record and nothing else, and read down a long page those hairlines were not enough to tell a
   * three-line TWAP from the row under it — the transaction feed next door gives each operation
   * its own card and reads far better for it.
   *
   * So the row drops the divider it drew for itself; the caller supplies both the card and the gap.
   */
  standalone?: boolean;
};

export function OrderRow({
  badge,
  leg,
  title,
  price,
  note,
  right,
  parts,
  lines,
  onDetails,
  cancel,
  outcome,
  outcomeAt,
  expanded = true,
  onPress,
  last,
  standalone,
}: OrderRowProps) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);

  /**
   * One leg of the trade, not both.
   *
   * It used to read "100 USDC → 0.0312 ETH", which is the whole trade and does not fit: beside a
   * kind badge and a Cancel it ran out of row and ellipsed, usually through the half anyone cared
   * about. The badge already says which direction this is, so the line says what the order is FOR
   * — what a buy buys, what a sell sells — and the other side is in the detail, where Pay and
   * Receive still spell out both. The icon travels with it, so the row says WHICH asset first.
   */
  const legView = !leg ? (
    // No legs to name. The row still has to exist — it is a trade that was attempted — so it says
    // what it was in words, in the quieter style a description belongs in.
    <View style={styles.legWrap}>
      <Text style={styles.price} numberOfLines={2}>
        {title ?? ''}
      </Text>
    </View>
  ) : (
    <View style={styles.legWrap}>
      <TokenIcon symbol={leg.symbol} size={18} />
      <Text style={styles.leg} numberOfLines={1}>
        <Amount v={leg.amount} size={15} /> {displaySymbol(leg.symbol)}
        {price ? <Text style={styles.price}> @{price}</Text> : null}
        {note ? <Text style={styles.price}> {note}</Text> : null}
      </Text>
    </View>
  );

  const head = (
    <>
      <View style={styles.headLeft}>
        <Text style={styles.badgeText}>{badge}</Text>
        {right ? legView : null}
      </View>
      {right ?? legView}
    </>
  );

  /**
   * What became of the row, and the controls that belong to it.
   *
   * Shown whether the row is open or SHUT. It used to live inside the panel, so a closed row said
   * what it was and what it was for and never what happened to it — which on a list of finished
   * orders is the one thing every row is read for. Two lines shut: the order, then its verdict.
   *
   * `controls` is what the open row adds. Cancel and Details are actions, and an action does not
   * belong on a row that has not been opened — least of all the destructive one, which would then
   * sit under a thumb reaching for a row it only meant to expand.
   */
  const foot = (controls: boolean) => {
    if (!outcome && !outcomeAt && !(controls && (cancel || onDetails))) return null;
    // One phrase, not two ends: see the untoned branch below.
    const joined = !!outcome && !outcome.tone && !!outcomeAt;
    return (
      /**
       * Opposite ends of one line: WHEN on the left, WHAT BECAME OF IT on the right.
       *
       * The two were the other way round. Reading down a list, the right-hand column is the one
       * the eye follows — it is where every row above puts its amount — and the verdict is what a
       * reader is scanning for, while the date is the detail they drop to once a row has their
       * attention. The head's own figures sit right too, so status under them reads as the same
       * column continued rather than as a label stranded on the far side.
       *
       * Cancel keeps the left, where every other row in this list puts its Cancel: Details is the
       * safe one of the two, so the destructive control should not be what lands under a thumb
       * reaching for the corner the list has trained it to reach for. It displaces the date rather
       * than the verdict, which is the less costly of the two to lose.
       */
      <View style={styles.foot}>
        {/* Cancel first, or the time where there is no Cancel to show. */}
        {(controls ? cancel : null) ??
          (outcomeAt && !joined ? <Text style={styles.footAt}>{outcomeAt}</Text> : <View />)}
        {/* The verdict, and — for a schedule that is open — the way into its parts. Both, when
            both apply: Details used to take the slot outright, so an expanded TWAP showed no
            status at all. */}
        <View style={styles.footRight}>
          {outcome ? (
            outcome.tone ? (
              <Pill label={outcome.label} tone={outcome.tone} />
            ) : (
              /**
               * An untoned outcome is the NAME of the time beside it — "Expires" — so the two are
               * one phrase and are printed as one: "Expires in 169d 18h".
               *
               * Split to opposite ends of the foot they read as two unrelated facts, and the left
               * end is where Cancel belongs on an order that still has one. A toned outcome is a
               * verdict about something that already happened, which is a different kind of thing
               * from when it happened, so those two stay apart.
               */
              <Text style={styles.label}>
                {joined ? `${outcome.label} ${outcomeAt}` : outcome.label}
              </Text>
            )
          ) : null}
          {controls && onDetails ? (
            <Pressable onPress={onDetails} hitSlop={8}>
              <Text style={styles.link}>{t('mobile.trade.details')}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  };

  const detail = (
    <>
      {(parts ?? []).map((p, i) => (
        <View key={`${p.label}-${i}`} style={styles.partRow}>
          <Text style={[styles.partText, p.pending && styles.partPending]} numberOfLines={1}>
            {p.label}
          </Text>
          <Text style={styles.partState}>{p.state}</Text>
        </View>
      ))}
      {/* Behind Details, the terms do not also print here — that was the point of moving them. */}
      {onDetails ? null : (lines ?? []).map(([label, value]) => (
        <View key={label} style={styles.line}>
          <Text style={styles.label}>{label}</Text>
          <Value v={value} />
        </View>
      ))}
      {foot(true)}
    </>
  );

  // Worked out before the render so the head can tighten up when a second line follows it.
  const shut = foot(false);
  const Head = onPress ? Pressable : View;
  /* The open detail closes it again. The head is a 52pt strip and the panel under it is the bigger
     target by far; having to go back up to the row to put it away read as the panel being a
     separate thing rather than the row's own second half. A Cancel inside is a nested pressable
     and still wins the tap. */
  const Panel = onPress ? Pressable : View;
  return (
    <View style={[standalone ? styles.plain : styles.card, last && !standalone && styles.lastCard]}>
      <Head style={[styles.head, !expanded && shut && styles.headTight]} onPress={onPress}>
        {head}
      </Head>
      {/* The verdict, on its own line, on a row that is shut. An open row gets it at the foot of
          its panel instead, where it has the controls beside it.

          Pressable like the head, and for the same reason the open panel is: it is the row's
          second line, not a caption under it. Outside the tap target it made the bottom half of
          every shut row dead to the touch — and on a two-line row that half is most of what the
          thumb lands on, so the row read as not expandable at all. A shut foot never holds a
          control (see {foot}), so nothing here competes for the tap. */}
      {!expanded && shut ? (
        <Head style={styles.shutFoot} onPress={onPress}>
          {shut}
        </Head>
      ) : null}
      {expanded ? (
        <Panel style={styles.detail} onPress={onPress}>
          {detail}
        </Panel>
      ) : null}
    </View>
  );
}

/** A detail value. An amount is the figure the line is about and reads in the text colour; a time
 *  or a count is context and steps back — a panel where everything was as loud as the amount had
 *  nothing to look at first. */
function Value({v, loud}: {v: OrderValue; loud?: boolean}) {
  const styles = useStyles(makeStyles);
  if (typeof v === 'string') return <Text style={[styles.value, !loud && styles.valueQuiet]}>{v}</Text>;
  return (
    <View style={styles.amt}>
      <Text style={styles.value}>
        <Amount v={v.amount} size={15} />
      </Text>
      <TokenIcon symbol={v.symbol} size={16} />
      <Text style={styles.amtSym}>{displaySymbol(v.symbol)}</Text>
    </View>
  );
}

/** The same figures the row prints, as a sheet reads them: one weight, line by line. A sheet is
 *  opened FOR these numbers, so none of them is the aside it would be under a row. */
export function OrderDetailLines({lines}: {lines: [string, OrderValue][]}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.detail}>
      {lines.map(([label, value]) => (
        <View key={label} style={styles.line}>
          <Text style={styles.label}>{label}</Text>
          <Value v={value} loud />
        </View>
      ))}
    </View>
  );
}

/**
 * "85.13" — two decimals above a dollar (none from 10,000: "80364"), three significant figures below one, truncated.
 *
 * Truncated rather than rounded: a price is a thing that happened, and rounding 0.08999 up to
 * 0.09 reads as a round number the trade never got. Lives here because both screens print it and
 * each used to carry its own copy — the two had already drifted by a digit once.
 */
export function fmtPrice(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  // Five figures and up in whole units (a Bitcoin price: 80364), two decimals from 1, more below.
  const dp = n >= 10_000 ? 0 : n >= 1 ? 2 : Math.ceil(-Math.log10(n)) + 2;
  const pow = 10 ** dp;
  return String(Number((Math.floor(n * pow) / pow).toFixed(dp)));
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    /**
     * The divider sits inside the card's padding, as the Overview's and Earn's do.
     *
     * It used to run edge to edge, the row stepping out past the padding, on the grounds that an
     * inset rule read as a hint within one block rather than a line between two. In use it was the
     * one list in the app ruled differently from the rest, and next to the chart card it read as a
     * different surface. Same rule everywhere now.
     */
    card: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    /**
     * The last row gives its trailing space back, so the card's own padding frames the list.
     *
     * This used to be done by dropping `paddingBottom` INSIDE the row — off the head while
     * collapsed, off the detail once open. Which padding was suppressed therefore changed on every
     * tap, and since the head also carries `minHeight`, losing 14 of bottom padding re-centred its
     * contents: the badge and the leg slid several points up as the row opened and back down as it
     * closed. Pulled up from the wrapper instead, the padding inside a row never changes.
     */
    lastCard: {marginBottom: -14},
    // The standalone variant: no divider of its own, since the card around it is the separation.
    // See {standalone}.
    plain: {},
    // An order row reads at the same weight as an asset row elsewhere: 15pt for the line itself, a
    // 44pt-tall tap target, and the labels one step down rather than two.
    head: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, gap: 10, minHeight: 52},
    headLeft: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1},
    /**
     * The kind and the side, as ordinary text.
     *
     * It was a tinted pill, then bold text in the colour of its side, and both were the same
     * mistake at different volumes: "Market Buy" is a LABEL — it says what sort of row this is —
     * and it was being shouted louder than the amount beside it, which is the figure anyone
     * actually reads. A column of them down a list read as a legend rather than as orders.
     *
     * The side is not lost by dropping the colour: the word says it, and the row's own figures and
     * its Pay / Receive lines say it again in terms that cannot be mistaken for decoration.
     */
    badgeText: {color: c.subtext, fontSize: 13, fontWeight: '400'},
    legWrap: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0},
    leg: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1},
    // Regular weight inside a semibold line: the amount is the subject, the price is the aside.
    price: {fontWeight: '400'},
    detail: {paddingBottom: 14, gap: 10},
    // A shut row's verdict line. The head gives up its bottom padding to it (see headTight), so
    // the two lines sit as one block rather than with a 14pt gap down the middle of the row.
    shutFoot: {paddingBottom: 14},
    headTight: {paddingBottom: 2, minHeight: 40},
    // A part is a smaller thing than an order line, so it reads one step down from the rows above it.
    partRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
    partText: {color: c.text, fontSize: 13, fontVariant: ['tabular-nums'], flexShrink: 1},
    // The column still lines up, so the boundary between done and due is the only edge.
    partPending: {color: c.subtext},
    partState: {color: c.subtext, fontSize: 12, fontWeight: '600'},
    line: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12},
    label: {color: c.subtext, fontSize: 14},
    value: {color: c.text, fontSize: 15, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right'},
    valueQuiet: {color: c.subtext},
    amt: {flexDirection: 'row', alignItems: 'center', gap: 6},
    amtSym: {color: c.subtext, fontSize: 14, fontWeight: '600'},
    // The panel's own last line: a way further in at one end, the way out at the other.
    foot: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2},
    // The right-hand end can hold two things — the verdict and a way into the parts — so it is a
    // row of its own rather than one slot the second would have to evict.
    footRight: {flexDirection: 'row', alignItems: 'center', gap: 12},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
    // Quieter than a detail value: it is the pill's second half, not a figure of its own.
    footAt: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums']},
  });

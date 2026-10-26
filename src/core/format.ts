/**
 * Shared display formatter for token amounts. Values ≥ 1 show at most 2 decimals, TRUNCATED (not rounded)
 * so a balance is never overstated, with trailing zeros dropped — e.g. 101.108294 → "101.1", 1234.50 →
 * "1,234.5", 1900.00 → "1,900". Below 1 keeps more precision (down to a "<0.0001" floor) so small crypto
 * amounts stay legible instead of collapsing to 0.
 */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1) {
    const truncated = Math.trunc(n * 100) / 100;
    return truncated.toLocaleString(undefined, {maximumFractionDigits: 2});
  }
  // Up to three zeros after the point (0.0005) stays a plain decimal: that many can be counted at a
  // glance. From four zeros on (0.0000123 and smaller) the count goes into a subscript, "0.0₄123", as
  // Uniswap and DEX Screener do, so five zeros can never be misread as three.
  // (Rounded to three significant digits first: 0.0000999999 is 0.0001 on screen, not a tiny value.)
  if (Number(abs.toPrecision(3)) < 0.0001) return (n < 0 ? '-' : '') + fmtTiny(abs);
  return n.toLocaleString(undefined, {maximumFractionDigits: 7});
}

/**
 * The same formatter, kept SHORT — for a row that lists amounts rather than reports a balance.
 *
 * {@link fmtNum} gives a sub-1 amount up to seven decimals, which is right where the number IS the
 * answer (what you hold, what is free to spend). In a list of orders it is noise: "0.1051606 ETH →
 * 250 USDC" is read for its magnitude, and the long tail only makes two rows harder to compare. So
 * two decimals, truncated like the ≥ 1 case so an amount is never overstated, and trailing zeros
 * kept ("0.10") because a column of amounts lines up on the point.
 *
 * Below 0.01 it hands back to {@link fmtNum}: truncating there would print "0.00" and lose the row.
 */
export function fmtShort(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1) return fmtNum(n);
  if (abs < 0.01) return fmtNum(n);
  return (Math.trunc(n * 100) / 100).toFixed(2);
}

/**
 * A holding on a list row: two decimals from 1 up, as {fmtNum}; below 1, at most four — 0.0365,
 * not 0.0365366 — so a column of balances reads like the total above it. The exact figure is a tap
 * away (the breakdown sheet). Still the subscript form for dust, so 0.00001 is never shown as 0.
 */
export function fmtHolding(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1 || Number(abs.toPrecision(3)) < 0.0001) return fmtNum(n);
  return (Math.trunc(n * 1e4) / 1e4).toLocaleString(undefined, {maximumFractionDigits: 4});
}

/**
 * The amount in FULL, with nothing dropped off the end.
 *
 * {@link fmtNum} truncates at two decimals above 1, which is right for a balance being read and
 * wrong for one about to be acted on: "Available 1.23 ETH" over a Max that fills 1.2345678 named a
 * different number from the one the field was going to hold.
 *
 * The decimal count comes from the number's OWN shortest text rather than from a fixed ceiling.
 * Asking `toLocaleString` for eighteen places prints the double's full binary expansion — 1.23
 * comes back as "1.229999999999999982" — so the cap is exactly the digits the value really has,
 * which is what `String(n)` gives.
 */
export function fmtFull(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  // The subscript form stays: for these it is both shorter AND exact, which a run of zeros is not.
  if (abs < 1 && Number(abs.toPrecision(3)) < 0.0001) return (n < 0 ? '-' : '') + fmtTiny(abs);
  const text = String(abs);
  // Exponential text ("1.2e-7") has no decimals to count; nothing above 0.0001 reaches it anyway.
  const dot = text.indexOf('.');
  const places = text.includes('e') ? 20 : dot < 0 ? 0 : text.length - dot - 1;
  return n.toLocaleString(undefined, {maximumFractionDigits: Math.min(20, places)});
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const sub = (k: number) => String(k).split('').map((d) => SUBSCRIPT[Number(d)]).join('');

/** 0 < abs < 0.0001 → "0.0₄123": zeros after the point as a subscript, then up to 3 significant digits. */
export function fmtTiny(abs: number): string {
  // Work from toPrecision's own text ("0.000990" or "1.23e-7"), never from a float round trip, which
  // would bring binary noise back (0.00099 → 0.000989999…).
  const p = abs.toPrecision(3);
  let zeros: number;
  let digits: string;
  const e = /^(\d)\.?(\d*)e-(\d+)$/.exec(p);
  if (e) {
    zeros = Number(e[3]) - 1;
    digits = e[1] + e[2];
  } else {
    const m = /^0\.(0*)(\d+)$/.exec(p);
    if (!m) return p;
    zeros = m[1].length;
    digits = m[2];
  }
  digits = digits.replace(/0+$/, '') || '0';
  return `0.0${sub(zeros)}${digits}`;
}

/**
 * The symbol to SHOW for a token. ETH sent to the vault arrives as WETH (the vault wraps on receipt),
 * and the vault only ever holds the wrapped form, so to its owner that balance simply is their ETH:
 * WETH reads as ETH everywhere a symbol is displayed, as on the web. Matching, lookups and contract
 * calls keep the real symbol; only rendering goes through here.
 */
/**
 * The yield and lending positions' receipt tokens, by the asset each stands for. The app never
 * names one: a Flexible Lend WETH is "ETH" and a Flexible Yield USDC is "USDC" wherever it shows —
 * an order paid from the position, its cancellation, a history line — because that is what the
 * user holds and what it is worth (aTokens one to one, sUSDS at its USDC rate; amounts are scaled
 * where they are read, see vault/yielding `susdsRateCached`).
 */
const RECEIPT_UNDERLYING: Record<string, string> = {
  SUSDS: 'USDC',
  STETH: 'ETH',
  AWETH: 'ETH',
  AUSDC: 'USDC',
  AUSDT: 'USDT',
  AWBTC: 'WBTC',
  ACBBTC: 'cbBTC',
};

export function displaySymbol(symbol: string | null | undefined): string {
  const s = symbol ?? '';
  const up = s.toUpperCase();
  return up === 'WETH' ? 'ETH' : (RECEIPT_UNDERLYING[up] ?? s);
}

/**
 * `0x123456…123456`: the first 8 and last 6 characters of an address, for tight spaces.
 *
 * The app's ONE address formatter, and it has to stay that way. Six screens had grown their own —
 * three of them cutting at `0x1234…1234` — so the same address read differently depending on which
 * list you found it in, and four hex digits is not enough to recognise one by: a vault, its asset
 * manager and a payout recipient can easily share them.
 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/**
 * Six decimals, taken DOWN; and the matching rounding for what comes out of the arithmetic.
 *
 * Used on every balance that feeds a ceiling. Six is what the amount fields keep, and a balance
 * read off chain carries as many decimals as its token has — eighteen for ETH — so rounding one to
 * six could name a ceiling a shade above what the vault actually holds. Flooring cannot, and once
 * the inputs land on six places exactly, {round6} at the end is lossless and only there to clear
 * the noise of subtracting them.
 *
 * Through the decimal TEXT, not by multiplying. `Math.floor(v * 1e6) / 1e6` is wrong for exactly
 * the figures it would be reached for: 8.21 * 1e6 is 8209999.999999999 in binary, so it floors to
 * 8.209999 and takes a cent off a balance that was never short. toFixed hands back the decimal
 * expansion and cutting it four digits in truncates at six with no binary detour.
 *
 * Here rather than in one screen because two forms now hold an amount back from a balance — the
 * order sheet and the Earn deposit — and a ceiling worked out two ways is two ceilings.
 */
export const floor6 = (v: number): number => {
  if (!(v > 0)) return 0;
  const text = v.toFixed(10);
  return Number(text.slice(0, text.indexOf('.') + 7));
};

export const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

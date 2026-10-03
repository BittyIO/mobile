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
export function displaySymbol(symbol: string | null | undefined): string {
  const s = symbol ?? '';
  return s.toUpperCase() === 'WETH' ? 'ETH' : s;
}

/** `0x123456…123456`: the first 8 and last 6 characters of an address, for tight spaces. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/**
 * Addresses as people read and type them, per network.
 *
 * Inside the app an address is always the 20-byte `0x…` form: that is what the contracts take, what
 * JSON-RPC returns, and what every store, cache and comparison here holds — on Tron too, whose
 * contracts see exactly those 20 bytes. Only at the edges does Tron differ: Tronscan, TronLink and
 * every exchange write the same account as base58 `T…`, and a vault address shown as 0x… on Tron
 * would be copied into a Tron wallet that refuses it — or worse, into an EVM wallet on another chain.
 *
 * So: {displayAddress} wherever an address is shown, copied or put in a QR code, and
 * {parseAddress} wherever one is typed, pasted or scanned. Nothing else converts.
 */
import {getAddress, isAddress, type Address} from 'viem';
import {isTronNetwork, type Network} from '@/core/chain';
import {evmToTron, tronToEvm} from '@/tron/address';

/** The address as the network's own wallets and explorer write it: 0x… checksummed, or T… on Tron. */
export function displayAddress(network: Network, address: string): string {
  if (!isTronNetwork(network)) return address;
  try {
    return evmToTron(address);
  } catch {
    return address;
  }
}

/**
 * What was typed, pasted or scanned, as the 0x… the app works in — or null when it is not an
 * address on `network`. On Tron the T… form is the one people have; 0x… is taken too, as Tron's
 * own JSON-RPC and contract tooling print it.
 */
export function parseAddress(network: Network, input: string): Address | null {
  const s = input.trim();
  if (isTronNetwork(network)) {
    const t = tronToEvm(s);
    if (t) return getAddress(t);
  }
  return isAddress(s, {strict: false}) ? getAddress(s) : null;
}

/** First and last characters, for a row too narrow for the whole address. */
export function shortDisplayAddress(network: Network, address: string, head = 6, tail = 4): string {
  const a = displayAddress(network, address);
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

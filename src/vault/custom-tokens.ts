import {parseAddress} from '@/core/address';
import {useCallback, useEffect, useState} from 'react';
import {erc20Abi, formatUnits, getAddress, isAddress, parseAbi, zeroAddress, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {getPref, setPref} from '@/core/prefs';
import {knownAssets} from '@/core/assets';
import {yieldAdapters} from '@/core/protocols';
import {isReceiptToken} from './market-trades';

/**
 * Tokens the owner pasted in by contract address, so the vault can send what the catalog does not
 * list — an airdrop, a token Bitty never registered.
 *
 * Everything shown is read from the token itself (symbol, decimals) and from the chain (what the
 * vault holds), never trusted from the paste. The list is kept per network and vault, so a token
 * pasted once is there next time.
 *
 * A position's receipt token (an aToken, stETH, sUSDS) is refused. It is not the owner's to send
 * whole: the protocol's adapter takes Bitty's yield fee out of the position when it is withdrawn,
 * so the position goes out through a withdrawal - the Send screen's position lines - and never as
 * the receipt token itself.
 */
export type CustomToken = {
  address: Address;
  symbol: string;
  decimals: number;
  /** What the vault holds, in token units. */
  balance: string;
};

const keyOf = (network: string, vault: string) => `send.customTokens:${network}:${vault.toLowerCase()}`;

const saved = (network: string, vault: string): Address[] =>
  (getPref(keyOf(network, vault)) ?? '')
    .split(',')
    .filter((a) => isAddress(a))
    .map((a) => getAddress(a));

const CLONE_ABI = parseAbi([
  'function getClone(address protocol) view returns (address)',
  'function receiptTokenOf(address asset) view returns (address)',
]);

/**
 * The receipt tokens of this vault's yield and lending positions, lowercased: each adapter clone the
 * vault has (getClone) names its receipt token per asset (receiptTokenOf). A clone answers only for
 * assets it has been used with, which is every asset the vault can hold a position in. A network
 * with no yield or lending adapters (Tron) has none.
 */
export async function positionReceiptTokens(network: Network, vault: Address): Promise<Set<string>> {
  const protocols = yieldAdapters(network).map((p) => p.address);
  const out = new Set<string>();
  if (protocols.length === 0) return out;
  const client = publicClientFor(network);
  const clones = (
    await client.multicall({
      allowFailure: true,
      contracts: protocols.map((p) => ({address: vault, abi: CLONE_ABI, functionName: 'getClone' as const, args: [p] as const})),
    })
  )
    .map((r) => (r.status === 'success' ? (r.result as Address) : null))
    .filter((c): c is Address => !!c && c !== zeroAddress);
  if (clones.length === 0) return out;
  const assets = [...new Set(knownAssets(network).map((a) => a.address.toLowerCase() as Address))];
  const receipts = await client.multicall({
    allowFailure: true,
    contracts: clones.flatMap((clone) =>
      assets.map((a) => ({address: clone, abi: CLONE_ABI, functionName: 'receiptTokenOf' as const, args: [a] as const})),
    ),
  });
  for (const r of receipts) {
    if (r.status === 'success' && r.result && r.result !== zeroAddress) out.add(String(r.result).toLowerCase());
  }
  return out;
}

/** Symbol, decimals and the vault's balance, or null when the address is not an ERC-20. */
export async function readCustomToken(network: Network, vault: Address, token: Address): Promise<CustomToken | null> {
  const client = publicClientFor(network);
  const [symbol, decimals, balance] = await client.multicall({
    allowFailure: true,
    contracts: [
      {address: token, abi: erc20Abi, functionName: 'symbol'},
      {address: token, abi: erc20Abi, functionName: 'decimals'},
      {address: token, abi: erc20Abi, functionName: 'balanceOf', args: [vault]},
    ],
  });
  if (decimals.status !== 'success' || balance.status !== 'success') return null;
  const d = Number(decimals.result);
  // A symbol is shown, so keep it short and printable; a token without one goes by its address.
  const sym = symbol.status === 'success' ? String(symbol.result).replace(/[^\x20-\x7E]/g, '').trim().slice(0, 12) : '';
  return {address: token, symbol: sym || `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: d, balance: formatUnits(balance.result, d)};
}

/** The pasted tokens for this vault, with fresh balances, and a way to add one. */
export function useCustomTokens(network: Network, vault: Address | null | undefined) {
  const [tokens, setTokens] = useState<CustomToken[]>([]);

  const reload = useCallback(async () => {
    if (!vault) return setTokens([]);
    // A receipt token pasted before they were refused is dropped too. If the lookup itself fails,
    // nothing pasted is offered rather than risk offering one.
    const receipts = await positionReceiptTokens(network, vault).catch(() => null);
    if (!receipts) return setTokens([]);
    const keep = saved(network, vault).filter((a) => !isReceiptToken(a) && !receipts.has(a.toLowerCase()));
    const read = await Promise.all(keep.map((a) => readCustomToken(network, vault, a).catch(() => null)));
    setTokens(read.filter((x): x is CustomToken => x != null));
  }, [network, vault]);
  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * Read and keep `address`. Throws a short reason when it cannot be added: "receipt-token" for one
   * of the vault's position receipt tokens.
   */
  const add = async (address: string): Promise<CustomToken> => {
    const a = parseAddress(network, address);
    if (!vault || !a) throw new Error('invalid-address');
    if (isReceiptToken(a) || (await positionReceiptTokens(network, vault)).has(a.toLowerCase())) {
      throw new Error('receipt-token');
    }
    const token = await readCustomToken(network, vault, a).catch(() => null);
    if (!token) throw new Error('not-a-token');
    const list = saved(network, vault).filter((x) => x.toLowerCase() !== token.address.toLowerCase());
    setPref(keyOf(network, vault), [...list, token.address].join(','));
    setTokens((ts) => [...ts.filter((x) => x.address.toLowerCase() !== token.address.toLowerCase()), token]);
    return token;
  };

  return {tokens, add, reload};
}

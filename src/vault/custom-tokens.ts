import {parseAddress} from '@/core/address';
import {useCallback, useEffect, useState} from 'react';
import {erc20Abi, formatUnits, getAddress, isAddress, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {getPref, setPref} from '@/core/prefs';

/**
 * Tokens the owner pasted in by contract address, so the vault can send what the catalog does not
 * list — an airdrop, a token Bitty never registered.
 *
 * Everything shown is read from the token itself (symbol, decimals) and from the chain (what the
 * vault holds), never trusted from the paste. The list is kept per network and vault, so a token
 * pasted once is there next time.
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
    const read = await Promise.all(saved(network, vault).map((a) => readCustomToken(network, vault, a).catch(() => null)));
    setTokens(read.filter((x): x is CustomToken => x != null));
  }, [network, vault]);
  useEffect(() => {
    reload();
  }, [reload]);

  /** Read and keep `address`. Throws a short reason when it cannot be added. */
  const add = async (address: string): Promise<CustomToken> => {
    const a = parseAddress(network, address);
    if (!vault || !a) throw new Error('invalid-address');
    const token = await readCustomToken(network, vault, a).catch(() => null);
    if (!token) throw new Error('not-a-token');
    const list = saved(network, vault).filter((x) => x.toLowerCase() !== token.address.toLowerCase());
    setPref(keyOf(network, vault), [...list, token.address].join(','));
    setTokens((ts) => [...ts.filter((x) => x.address.toLowerCase() !== token.address.toLowerCase()), token]);
    return token;
  };

  return {tokens, add, reload};
}

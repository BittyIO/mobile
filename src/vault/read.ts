/**
 * Vault read layer — the owner's deterministic vault address and its on-chain balances, read straight
 * from viem (no backend needed for this part). Positions (staked / supplied / LP) and history come
 * from the web API in a later step.
 */
import {erc20Abi, formatUnits, type Address} from 'viem';
import {NATIVE, publicClientFor, type Network} from '@/core/chain';
import {predictVaultAddressOn} from '@/core/predict-vault';
import {ASSETS, type AssetKind} from '@/core/assets';
import {currentCatalog} from '@/core/asset-catalog';

/**
 * The connected owner's vault address — defined whether or not the vault has been activated yet.
 *
 * The factory is one address on every EVM chain; each Tron network has its own (core/vault-contracts).
 */
export function ownerVaultAddress(owner: Address, network: Network): Address {
  return predictVaultAddressOn(network, owner);
}

export type TokenBalance = {
  symbol: string;
  address: Address | 'native';
  decimals: number;
  kind: AssetKind;
  raw: bigint;
  formatted: string;
};

export type VaultBalances = {
  vault: Address;
  native: TokenBalance;
  tokens: TokenBalance[];
};

/** The vault's free (spendable) balance of a symbol, as a formatted string. "0" when unknown. */
export function balanceOfSymbol(
  balances: VaultBalances | null,
  symbol: string,
): string {
  if (!balances) return '0';
  // The chain's own coin by its own symbol only: on BSC "ETH" is a token (Binance-Peg Ethereum),
  // and answering it with the vault's BNB would offer BNB to spend as ETH.
  if (symbol === balances.native.symbol) return balances.native.formatted;
  return balances.tokens.find((t) => t.symbol === symbol)?.formatted ?? '0';
}

/**
 * Read the vault's native + ERC-20 balances. One multicall for the tokens plus one getBalance for
 * native ETH. A token whose call fails is reported as zero rather than failing the whole read.
 */
export async function readVaultBalances(
  vault: Address,
  network: Network,
): Promise<VaultBalances> {
  const client = publicClientFor(network);
  /**
   * Every token worth asking about: the catalog's rows, plus anything this build bundles that the
   * catalog has not got.
   *
   * The union, not one or the other. Reading only the bundled list means an asset added to the DB
   * after this build can never show a balance, however many screens list it — which is what kept
   * SKY, LINK, MORPHO, ARB, ENA and SNDK invisible. Reading only the catalog would hand the
   * opposite failure to a cold launch or an unreachable host, where the rows are not there yet
   * and every balance would read as zero.
   */
  const seen = new Set<string>();
  const assets = [...currentCatalog(network), ...ASSETS[network]].filter((a) => {
    const k = a.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const readEach = () =>
    Promise.all(
      assets.map((a) =>
        client
          .readContract({address: a.address, abi: erc20Abi, functionName: 'balanceOf', args: [vault]})
          .then((v) => v as bigint)
          .catch(() => 0n),
      ),
    );

  const native = await client.getBalance({address: vault}).catch(() => 0n);

  // Prefer one multicall, but some RPCs (seen on Base) don't run aggregate3 cleanly and return an error
  // or all-empty — which would wrongly show every balance as 0. Fall back to individual reads then.
  let raws: bigint[];
  try {
    const results = await client.multicall({
      contracts: assets.map((a) => ({address: a.address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [vault] as const})),
      allowFailure: true,
    });
    raws = results.map((r) => (r.status === 'success' ? (r.result as bigint) : 0n));
    if (raws.every((v) => v === 0n)) raws = await readEach();
  } catch {
    raws = await readEach();
  }

  // Native ETH counts as WETH (TRX as WTRX on Tron: NATIVE.wrapped). A live vault wraps ETH the moment it arrives (receive()), and a vault
  // that is not deployed yet wraps whatever sits at its predicted address during initialize, before
  // the first action's calls run. So ETH sent ahead of activation is spendable as WETH from the first
  // action on, and the row shows it instead of a misleading 0.
  const tokens: TokenBalance[] = assets.map((a, i) => {
    const raw = a.symbol === NATIVE[network].wrapped ? raws[i] + native : raws[i];
    return {
      symbol: a.symbol,
      address: a.address,
      decimals: a.decimals,
      kind: a.kind,
      raw,
      formatted: formatUnits(raw, a.decimals),
    };
  });

  return {
    vault,
    native: {
      symbol: NATIVE[network].symbol,
      address: 'native',
      decimals: NATIVE[network].decimals,
      kind: 'native',
      raw: native,
      formatted: formatUnits(native, NATIVE[network].decimals),
    },
    tokens,
  };
}

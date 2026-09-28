/**
 * Vault read layer — the owner's deterministic vault address and its on-chain balances, read straight
 * from viem (no backend needed for this part). Positions (staked / supplied / LP) and history come
 * from the web API in a later step.
 */
import {erc20Abi, formatUnits, type Address} from 'viem';
import {
  BOOTSTRAP_ADDRESS,
  FACTORY_ADDRESS,
  publicClientFor,
  type Network,
} from '@/core/chain';
import {predictVaultAddress} from '@/core/predict-vault';
import {ASSETS, type AssetKind} from '@/core/assets';

/** The connected owner's vault address — defined whether or not the vault has been activated yet. */
export function ownerVaultAddress(owner: Address, network: Network): Address {
  return predictVaultAddress(owner, FACTORY_ADDRESS[network], BOOTSTRAP_ADDRESS);
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
  if (symbol === 'ETH') return balances.native.formatted;
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
  const assets = ASSETS[network];

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

  // Native ETH counts as WETH. A live vault wraps ETH the moment it arrives (receive()), and a vault
  // that is not deployed yet wraps whatever sits at its predicted address during initialize, before
  // the first action's calls run. So ETH sent ahead of activation is spendable as WETH from the first
  // action on, and the row shows it instead of a misleading 0.
  const tokens: TokenBalance[] = assets.map((a, i) => {
    const raw = a.symbol === 'WETH' ? raws[i] + native : raws[i];
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
      symbol: 'ETH',
      address: 'native',
      decimals: 18,
      kind: 'native',
      raw: native,
      formatted: formatUnits(native, 18),
    },
    tokens,
  };
}

import {useEffect, useState} from 'react';
import type {Network} from '@/core/chain';
import {getStableCoinAsGasConfig, type StableCoinAsGasConfig} from './stableCoinAsGas';
import {ownerEthBalance} from './direct';
import {quoteOwnerFeeWei, TYPICAL_RELAY_GAS} from './fee-quote';
import {useVaultBalances} from './useVaultBalances';
import {useActiveFeePayer} from './useFeePayer';

/**
 * Whether each way of paying the network fee can actually pay it right now — so the Network fee page
 * can say so before a transaction fails for it, instead of after.
 *
 * - The VAULT can when it holds some of a coin the relayer may bill it in: the stablecoins it
 *   allows (none named = any the vault holds) and, from v1.0.2, its WETH, which counts the plain
 *   ETH it holds too (see read `loadBalances`).
 * - The OWNER WALLET can when it holds at least one ordinary transaction's worth of ETH.
 *
 * `null` while either is still being read: no warning until there is something to warn about.
 */
export function useFeeReadiness(network: Network): {vault: boolean | null; owner: boolean | null} {
  const {owner, vault} = useActiveFeePayer(network);
  const {balances} = useVaultBalances(network);
  const [cfg, setCfg] = useState<StableCoinAsGasConfig | null | undefined>(undefined);
  const [ownerOk, setOwnerOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!vault) return;
    let live = true;
    getStableCoinAsGasConfig(vault, network).then((c) => live && setCfg(c));
    return () => {
      live = false;
    };
  }, [vault, network]);

  useEffect(() => {
    if (!owner) return;
    let live = true;
    Promise.all([ownerEthBalance(network, owner), quoteOwnerFeeWei(network, TYPICAL_RELAY_GAS)])
      .then(([have, fee]) => live && setOwnerOk(fee != null ? have >= fee : have > BigInt(0)))
      .catch(() => live && setOwnerOk(null));
    return () => {
      live = false;
    };
  }, [owner, network]);

  let vaultOk: boolean | null = null;
  if (balances && cfg !== undefined) {
    const allowed = new Set((cfg?.stableCoins ?? []).map((a) => a.toLowerCase()));
    const weth = cfg?.weth?.toLowerCase();
    vaultOk = balances.tokens.some(
      (tk) =>
        tk.raw > BigInt(0) &&
        tk.address !== 'native' &&
        (tk.address.toLowerCase() === weth || (tk.kind === 'stable' && (allowed.size === 0 || allowed.has(tk.address.toLowerCase())))),
    );
  }
  return {vault: vaultOk, owner: ownerOk};
}

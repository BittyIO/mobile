import {useEffect, useSyncExternalStore} from 'react';
import {parseAbi, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {generationConfig, generationKey, useVaultGeneration} from '@/core/vault-generation';
import {ASSETS, registerAssetCategories} from '@/core/assets';
import {useAssetCatalog} from '@/core/asset-catalog';

/**
 * Each asset's category, read from the guard — the live answer to "can this be market-traded?".
 *
 * The category is a BIT FIELD, and the vault reads it the same way: `ASSET_STABLE_COIN = 1`,
 * `ASSET_CRYPTO = 2` (both in the guard's interface) and `ASSET_AMM_LIQUID = 4`, which lives in
 * the vault's DeFiLogic because that is where it is enforced — a swap of a token without bit 4
 * reverts. So 6 is a crypto asset with a pool behind it and 2 is one without.
 *
 * It was a hard-coded address list per network, mirroring the web's. Keeping that in step with the
 * guard is a release, and by 2026-10-06 it was already wrong: SKY, LINK and ENA had been added to
 * mainnet as category 6 and the app would have offered them limit orders only, while MORPHO and
 * ARB went in as 2 and the list had no opinion on them at all. The guard is where the truth is and
 * the vault agrees with it by construction, so this asks.
 *
 * One read per asset, cached for the process — a category changes about as often as an asset is
 * registered, and a wrong answer costs a reverted swap, not money.
 */

const ASSET_ABI = parseAbi(['function assetCategory(address) view returns (uint8)']);

/** Bit 4. Named for the vault constant it mirrors. */
const ASSET_AMM_LIQUID = 4;

// Keyed by generation AND network: each generation asks its own guard.
const cache = new Map<string, Map<string, number>>();
const inflight = new Map<string, Promise<void>>();

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const bump = () => {
  version++;
  for (const fn of listeners) fn();
};

/** Read any categories not already known. Resolves when the map is as complete as it will get. */
export async function fetchAssetCategories(network: Network, addresses: string[]): Promise<void> {
  const genKey = generationKey(network);
  const guard = generationConfig().guard;
  const known = cache.get(genKey) ?? new Map<string, number>();
  const want = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !known.has(a));
  if (want.length === 0) return;

  const key = `${genKey}:${want.join(',')}`;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const client = publicClientFor(network);
      const calls = want.map((a) => ({
        address: guard,
        abi: ASSET_ABI,
        functionName: 'assetCategory' as const,
        args: [a as Address] as const,
      }));
      let cats: (number | null)[];
      try {
        const res = await client.multicall({contracts: calls, allowFailure: true});
        cats = res.map((r) => (r.status === 'success' ? Number(r.result) : null));
      } catch {
        // Some RPCs do not run aggregate3 cleanly; the same fallback the balance read uses.
        cats = await Promise.all(
          want.map((a) =>
            client
              .readContract({address: guard, abi: ASSET_ABI, functionName: 'assetCategory', args: [a as Address]})
              .then((v) => Number(v))
              .catch(() => null),
          ),
        );
      }

      const next = new Map(known);
      cats.forEach((c, i) => c != null && next.set(want[i], c));
      /**
       * Only trust a read that found at least one AMM-liquid asset.
       *
       * `assetCategory` answers 0 for anything it does not know, so a wrong chain or a node
       * serving an empty state looks exactly like "nothing here can be market-traded" — and that
       * answer, believed, would take Market off every pair in the app. Every network's bundled
       * list is non-empty, so a set with no bit 4 in it is a bad read, not news.
       */
      if (![...next.values()].some((c) => (c & ASSET_AMM_LIQUID) !== 0)) return;
      cache.set(genKey, next);
      registerAssetCategories(network, next);
      bump();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/**
 * Keep the categories warm and re-render when they land.
 *
 * Called by `App.Root` so the answer is in before the first trade sheet opens, and by the Trade
 * screen itself, which is what actually reads it — a re-render of the root does not reach a screen
 * the navigator is already holding. The fetch dedupes, so asking twice costs one request.
 */
export function useGuardAssets(network: Network): number {
  const catalog = useAssetCatalog(network);
  const seen = useSyncExternalStore(subscribe, () => version);
  const generation = useVaultGeneration((s) => s.generation);
  useEffect(() => {
    void fetchAssetCategories(network, [
      ...catalog.map((a) => a.address),
      ...ASSETS[network].map((a) => a.address),
    ]);
  }, [network, catalog, generation]);
  return seen;
}

import {useCallback, useEffect} from 'react';
import {useFocusEffect} from '@react-navigation/native';
import {create} from 'zustand';
import type {Address} from 'viem';
import type {Network} from '@/core/chain';
import {useWallet} from '@/wallet/store';
import {fetchCatalog, useCatalogVersion} from '@/core/asset-catalog';
import {usePending} from '@/vault/pending';
import {ownerVaultAddress, readVaultBalances, type VaultBalances} from './read';

type State = {
  vault: Address | null;
  balances: VaultBalances | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * ONE copy of the vault's balances, shared by every screen.
 *
 * It was a copy per hook call, which is a copy per screen, and tab screens are never unmounted:
 * the Overview and the Trade tab each read once on first mount and then only when something
 * pulled on THAT screen. Tokens arriving at the vault showed up wherever you happened to pull and
 * nowhere else — the Overview right, the Trade sheet quoting a Max from before the deposit — and
 * the only cure was pulling on each screen in turn.
 *
 * So the reads live here, keyed by network and vault, and the hook is a subscription. One pull
 * updates every screen, and the three things that can make the figure wrong all re-read once:
 *
 *  - a tracked transaction settling, since the vault's own writes change its balances;
 *  - the catalog landing, which changes WHICH tokens are asked about (see {readVaultBalances});
 *  - a screen coming into focus on data older than {STALE_MS}, which is what catches a deposit
 *    the app had no part in and cannot be told about.
 */

type Entry = {balances: VaultBalances | null; loading: boolean; error: string | null; at: number};

const useStore = create<{byKey: Record<string, Entry>}>(() => ({byKey: {}}));
const inflight = new Map<string, Promise<void>>();
const keyFor = (network: Network, vault: Address) => `${network}:${vault.toLowerCase()}`;

/**
 * How old a read may be before focus counts as a reason to redo it.
 *
 * Long enough that walking between tabs is not a stream of RPC calls, short enough that a deposit
 * made a moment ago is on screen by the time the user has gone to look for it.
 */
const STALE_MS = 15_000;

const EMPTY: Entry = {balances: null, loading: false, error: null, at: 0};

const patch = (key: string, next: Partial<Entry>) =>
  useStore.setState((s) => ({byKey: {...s.byKey, [key]: {...(s.byKey[key] ?? EMPTY), ...next}}}));

function load(network: Network, vault: Address): Promise<void> {
  const key = keyFor(network, vault);
  const running = inflight.get(key);
  if (running) return running;

  patch(key, {loading: true, error: null});
  // The catalog decides which tokens are read; warming it here means the first read after a cold
  // launch is complete rather than limited to what this build bundles.
  void fetchCatalog(network);
  const task = readVaultBalances(vault, network)
    .then((b) => patch(key, {balances: b, error: null}))
    .catch((e) => patch(key, {error: String((e as Error)?.message ?? e)}))
    .finally(() => {
      patch(key, {loading: false, at: Date.now()});
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/**
 * A transaction of ours settling is the one change the app can be certain of.
 *
 * Subscribed once, at module scope, rather than from a screen: the write may well have been sent
 * from a sheet that is closed by the time the receipt lands, and the balances it changed belong
 * to every screen, not to the one that happened to still be mounted.
 */
// Seeded with what is already settled, because the store is restored from disk at launch: without
// this the first change of any kind would look like a dozen transactions confirming at once.
let settled = new Set(usePending.getState().txs.filter((t) => t.status === 'confirmed').map((t) => t.hash));
usePending.subscribe((s) => {
  const done = s.txs.filter((t) => t.status === 'confirmed');
  for (const tx of done) {
    if (settled.has(tx.hash)) continue;
    settled.add(tx.hash);
    for (const k of Object.keys(useStore.getState().byKey)) {
      const [net, vault] = k.split(':');
      if (net === tx.network) void load(net as Network, vault as Address);
    }
  }
  // Bounded: the pending store prunes, and this only has to recognise a hash it has just seen.
  if (settled.size > 100) settled = new Set([...settled].slice(-50));
});

/**
 * Owner → predicted vault address → on-chain balances.
 *
 * Prediction is local (no RPC), so the vault address is available immediately even before the
 * first read resolves.
 */
export function useVaultBalances(network: Network): State {
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const key = vault ? keyFor(network, vault) : '';
  const entry = useStore((s) => (key ? s.byKey[key] : undefined));
  const catalogVersion = useCatalogVersion();

  useEffect(() => {
    if (vault) void load(network, vault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, catalogVersion]);

  // Back on screen, and what is on it is old: re-read. This is the only thing that catches tokens
  // somebody else sent the vault, which nothing in the app ever hears about.
  useFocusEffect(
    useCallback(() => {
      if (!vault) return;
      const at = useStore.getState().byKey[key]?.at ?? 0;
      if (Date.now() - at > STALE_MS) void load(network, vault);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]),
  );

  const refresh = useCallback(() => {
    if (vault) void load(network, vault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    vault,
    balances: entry?.balances ?? null,
    // No vault means no request was started, so nothing is loading — the flag has to say so, or a
    // screen waiting on a wallet that is still deriving its owner spins for ever.
    loading: !!vault && !!entry?.loading,
    error: entry?.error ?? null,
    refresh,
  };
}

/**
 * What a settings transaction changed, beyond what its call says on its own — for the history.
 *
 * A call carries the NEW state, not the difference. `setTokenAsGas` names every fee coin that is on
 * afterwards, and `upgrade` names the implementation the vault moves to; neither says what came
 * before. So the line "USDT: network fee off" needs the previous fee-coin change, which is the next
 * older one in the same history, and "Version 1.0.2 → 1.0.3" needs the versions either side, which
 * are read from the chain. Versions are constants of the contracts they belong to, so each is read
 * once and kept.
 */
import {useEffect, useState} from 'react';
import {MMKV} from 'react-native-mmkv';
import {parseAbi, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import type {Operation} from './transactions';
import type {VaultAction} from './tx-actions';
import {formatVersion} from './upgrade-adapter';

/** A fee-coin setting as a call set it: the coins (none = any coin), and the two caps in dollars. */
export type FeeConfig = {assets: string[]; dailyLimit: string; maxFeePerOp: string};

/** Everything a history row's settings lines may need beyond its own call. */
export type OpDetails = {
  /** The fee-coin setting in force before this transaction; null when no earlier one is in the history. */
  feePrev?: FeeConfig | null;
  /** For an upgrade of the vault or of an adapter: the version before and after. */
  versionFrom?: string;
  versionTo?: string;
};

const FEE_CALLS = new Set(['setTokenAsGas', 'setStableCoinAsGas']);
const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

/** The fee-coin setting a transaction's calls leave behind, if any of them set one. */
export function feeConfigOf(actions: VaultAction[] | undefined): FeeConfig | undefined {
  let out: FeeConfig | undefined;
  for (const a of actions ?? []) {
    if (FEE_CALLS.has(a.name)) {
      out = {
        assets: list(a.args.assets).map((x) => x.toLowerCase()),
        dailyLimit: String(a.args.dailyLimit ?? ''),
        maxFeePerOp: String(a.args.maxFeePerOp ?? ''),
      };
    }
  }
  return out;
}

/**
 * For each transaction that sets the fee coins, the setting before it: walked oldest first, so each
 * one sees the last that came ahead of it. `ops` is the history as shown, newest first.
 */
export function feeHistory(ops: Operation[]): Map<string, FeeConfig | null> {
  const out = new Map<string, FeeConfig | null>();
  let last: FeeConfig | null = null;
  for (let i = ops.length - 1; i >= 0; i--) {
    const cfg = feeConfigOf(ops[i].actions);
    if (!cfg) continue;
    out.set(ops[i].txHash.toLowerCase(), last);
    last = cfg;
  }
  return out;
}

const VAULT_VERSION_ABI = parseAbi(['function vaultVersion() view returns (uint256)']);
const PROTOCOL_VERSION_ABI = parseAbi(['function protocolVersion() view returns (uint256)']);
const cache = new MMKV({id: 'bitty.versions'});

/** A contract's version, read once: an implementation's version never changes. */
async function versionOf(network: Network, address: string, kind: 'vault' | 'protocol', blockNumber?: bigint): Promise<string | undefined> {
  const key = `${network}:${kind}:${address.toLowerCase()}${blockNumber !== undefined ? `@${blockNumber}` : ''}`;
  const hit = cache.getString(key);
  if (hit) return hit;
  try {
    const v = (await publicClientFor(network).readContract({
      address: address as Address,
      abi: kind === 'vault' ? VAULT_VERSION_ABI : PROTOCOL_VERSION_ABI,
      functionName: kind === 'vault' ? 'vaultVersion' : 'protocolVersion',
      blockNumber,
    })) as bigint;
    const s = formatVersion(v);
    cache.set(key, s);
    return s;
  } catch {
    // An RPC without the old state, or a contract that does not say: the line goes without it.
    return undefined;
  }
}

/**
 * Before and after versions for every upgrade in `ops`, by lowercase hash.
 *
 * An adapter upgrade names both sides — the adapter the vault used and the one it moves to — and
 * each reports its own version. A vault upgrade names only the new implementation; the version
 * before is the vault's own, read at the block before the upgrade, which needs an RPC that keeps
 * that state and is left out where it does not.
 */
export function useUpgradeVersions(network: Network, vault: Address | null, ops: Operation[]): Map<string, {from?: string; to?: string}> {
  const [out, setOut] = useState<Map<string, {from?: string; to?: string}>>(() => new Map());
  const wanted = ops.filter((op) => op.actions.some((a) => a.name === 'upgrade' || a.name === 'upgradeProtocol'));
  const key = wanted.map((op) => op.txHash).join(',');
  useEffect(() => {
    if (!vault || wanted.length === 0) return;
    let live = true;
    (async () => {
      const found = new Map<string, {from?: string; to?: string}>();
      for (const op of wanted) {
        const a = op.actions.find((x) => x.name === 'upgrade' || x.name === 'upgradeProtocol')!;
        const v =
          a.name === 'upgrade'
            ? {
                from: await versionOf(network, vault, 'vault', BigInt(Math.max(0, op.blockNum - 1))),
                to: await versionOf(network, String(a.args.newImpl), 'vault'),
              }
            : {
                from: await versionOf(network, String(a.args.protocol), 'protocol'),
                to: await versionOf(network, String(a.args.newImplementation), 'protocol'),
              };
        found.set(op.txHash.toLowerCase(), v);
      }
      if (live) setOut(found);
    })();
    return () => {
      live = false;
    };
    // `key` stands for `wanted`: the same hashes are the same work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, vault, key]);
  return out;
}

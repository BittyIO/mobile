/**
 * Delegation — the two ways an owner hands out scoped authority over the vault:
 *
 *  1. Asset manager: a single trading delegate that can route swaps/LP until `expiresAt` (a unix second;
 *     0 = never). Appointing or extending a grant waits out an on-chain change timelock and lands in the
 *     `pending` slot until it applies; revoking or shortening takes effect at once. Read the live state
 *     (current + pending) with getAssetManager; appoint/revoke with setAssetManager.
 *
 *  2. Payout operators: addresses that can PROPOSE payments (and cancel/clean up sends) for the owner to
 *     approve — they can't move funds unilaterally. There's no on-chain list getter, only
 *     `isPayoutOperator(addr)` plus the `PayoutOperatorUpdated` event, so listOperators scans a bounded
 *     window of that event and confirms each candidate against `isPayoutOperator` (the authoritative
 *     current state). Operators set further back than the scan window won't surface — noted as a limit.
 *
 * All writes are relayed & gasless (fee in the vault's stablecoin), Face-ID-gated at signing.
 */
import {getAddress, zeroAddress, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {VAULT_DELEGATE_ABI} from '@/core/abi';
import {relayVaultWrite} from './relay';

type Acct = Parameters<typeof relayVaultWrite>[0]['account'];

const isZero = (a?: string) => !a || /^0x0+$/.test(a);

export type AssetManagerSettings = {
  manager: Address; // active grant (zeroAddress = none)
  expiresAt: bigint; // unix seconds, 0 = never
  pendingManager: Address; // queued grant awaiting the timelock (zeroAddress = none)
  pendingAt: bigint; // unix seconds the pending grant becomes active
};

const NONE: AssetManagerSettings = {
  manager: zeroAddress,
  expiresAt: 0n,
  pendingManager: zeroAddress,
  pendingAt: 0n,
};

/** Current + pending asset-manager grant. Returns NONE for an un-activated vault or a read failure. */
export async function getAssetManager(
  vault: Address,
  network: Network,
): Promise<AssetManagerSettings> {
  try {
    const client = publicClientFor(network);
    const res = (await client.readContract({
      address: vault,
      abi: VAULT_DELEGATE_ABI,
      functionName: 'getAssetManagerSettings',
    })) as readonly [Address, bigint, Address, bigint];
    return {
      manager: res[0],
      expiresAt: res[1],
      pendingManager: res[2],
      pendingAt: res[3],
    };
  } catch {
    return NONE;
  }
}

/**
 * Appoint (or extend) the asset manager until `expiresAt`; pass the zero address (or use
 * revokeAssetManager) to clear it. Appointing/extending queues behind the change timelock.
 */
export async function setAssetManager(o: {
  account: Acct;
  vault: Address;
  network: Network;
  manager: Address;
  expiresAt: bigint;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_DELEGATE_ABI,
    functionName: 'setAssetManager',
    args: [o.manager, o.expiresAt],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Revoke the asset-manager grant (clears both the active and pending slots). Applies immediately. */
export function revokeAssetManager(o: {
  account: Acct;
  vault: Address;
  network: Network;
  stableCoin: Address;
}): Promise<Hex> {
  return setAssetManager({...o, manager: zeroAddress, expiresAt: 0n});
}

/** Add (`add=true`) or remove a payout operator. */
export async function updateOperator(o: {
  account: Acct;
  vault: Address;
  network: Network;
  operator: Address;
  add: boolean;
  stableCoin: Address;
}): Promise<Hex> {
  const {hash} = await relayVaultWrite({
    account: o.account,
    vault: o.vault,
    network: o.network,
    abi: VAULT_DELEGATE_ABI,
    functionName: 'updatePayoutOperator',
    args: [o.operator, o.add],
    stableCoin: o.stableCoin,
  });
  return hash;
}

/** Authoritative check for a single address. */
export async function isOperator(
  vault: Address,
  network: Network,
  account: Address,
): Promise<boolean> {
  try {
    const client = publicClientFor(network);
    return (await client.readContract({
      address: vault,
      abi: VAULT_DELEGATE_ABI,
      functionName: 'isPayoutOperator',
      args: [account],
    })) as boolean;
  } catch {
    return false;
  }
}

// getLogs window / span for the operator-event scan. Free RPCs cap a single getLogs at ~10k blocks, so
// we chunk backward from head. WINDOWS caps the total span (~SCAN_WINDOW*WINDOWS blocks) to keep the
// scan to a handful of requests; operators toggled before that window won't be discovered here.
const SCAN_WINDOW = 9000n;
const SCAN_WINDOWS = 30;

/**
 * Current payout operators, best-effort. Scans a bounded window of `PayoutOperatorUpdated` events for
 * candidate addresses, then confirms each against `isPayoutOperator` (which nets out any add/remove
 * churn). May miss operators added before the scan window — see `operatorScanBounded` for the flag.
 */
export async function listOperators(
  vault: Address,
  network: Network,
): Promise<Address[]> {
  try {
    const client = publicClientFor(network);
    const head = await client.getBlockNumber();
    const candidates = new Set<string>();
    let to = head;
    for (let i = 0; i < SCAN_WINDOWS; i++) {
      const from = to > SCAN_WINDOW ? to - SCAN_WINDOW : 0n;
      try {
        const logs = await client.getLogs({
          address: vault,
          event: VAULT_DELEGATE_ABI.find(
            (x) => x.type === 'event' && x.name === 'PayoutOperatorUpdated',
          ) as any,
          fromBlock: from,
          toBlock: to,
        });
        for (const l of logs) {
          const addr = (l as any).args?.payoutOperator as string | undefined;
          if (addr) candidates.add(addr.toLowerCase());
        }
      } catch {
        // window too wide for this RPC — skip it and keep going.
      }
      if (from === 0n) break;
      to = from - 1n;
    }
    const list = [...candidates];
    if (list.length === 0) return [];

    // Net current state: only addresses that are STILL operators.
    const checks = await client.multicall({
      contracts: list.map((a) => ({
        address: vault,
        abi: VAULT_DELEGATE_ABI,
        functionName: 'isPayoutOperator' as const,
        args: [a as Address],
      })),
      allowFailure: true,
    });
    return list
      .filter((_, i) => checks[i].status === 'success' && checks[i].result === true)
      .map((a) => getAddress(a));
  } catch {
    return [];
  }
}

/** The operator list is derived from a bounded event scan, so it can be incomplete. */
export const operatorScanBounded = true;

export {isZero as isZeroAddress};

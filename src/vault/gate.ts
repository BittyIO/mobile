import {useCallback, useEffect} from 'react';
import {AppState} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {create} from 'zustand';
import {parseAbi, type Address} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {usePending} from '@/vault/pending';
import {runningVaultVersion} from './vault-abi';
import {
  capability,
  type Gate,
  type GateOptions,
  type LockLevel,
  type VaultAction,
  type VaultGateState,
} from './capabilities';

/**
 * What the vault in front will accept right now — its lock, and whether an allowance of 0 has
 * switched sends or market trading off — so a screen can disable a control and say why instead of
 * letting the contract refuse it (see ./capabilities).
 *
 * One store for every screen, keyed by network and vault, so the Trade, Earn and Send screens read
 * the same answer. Read when a screen using it comes into focus, when the app comes back, and when
 * a relayed write settles (a lock made on this device is one). The vault's release comes with it,
 * since a newer one gates more tightly (STRICT_GATES_SINCE).
 *
 * The app always acts as the vault's owner, so the role is fixed: an asset manager uses web.
 */

const GATE_ABI = parseAbi([
  'function lockLevel() view returns (uint8)',
  'function riskSettings() view returns (uint64 timelock, uint64 sendDailyAllowance, uint64 marketTradeDailyLossAllowance)',
]);

const UNKNOWN: VaultGateState = {lockLevel: null, role: 'owner'};

/** One read. A part that fails (a vault not activated yet, a flaky RPC) stays unknown, which allows. */
export async function readVaultGateState(vault: Address, network: Network): Promise<VaultGateState> {
  const [[lock, risk], vaultVersion] = await Promise.all([
    publicClientFor(network).multicall({
      allowFailure: true,
      contracts: [
        {address: vault, abi: GATE_ABI, functionName: 'lockLevel'},
        {address: vault, abi: GATE_ABI, functionName: 'riskSettings'},
      ],
    }),
    runningVaultVersion(vault, network).catch(() => null),
  ]);
  const level = lock.status === 'success' ? Number(lock.result) : null;
  const state: VaultGateState = {
    lockLevel: level === 0 || level === 1 || level === 2 ? (level as LockLevel) : null,
    role: 'owner',
    vaultVersion,
  };
  if (risk.status === 'success') {
    // The effective allowances: never-set reads as the ceiling, so only a real 0 means "off".
    const [, send, marketLoss] = risk.result;
    state.sendAllowanceOff = send === 0n;
    state.marketTradeOff = marketLoss === 0n;
  }
  return state;
}

const keyOf = (vault: Address, network: Network) => `${network}:${vault.toLowerCase()}`;

const useGateStore = create<{
  states: Record<string, VaultGateState>;
  refresh: (vault: Address, network: Network) => Promise<void>;
}>((set) => ({
  states: {},
  refresh: async (vault, network) => {
    try {
      const state = await readVaultGateState(vault, network);
      set((s) => ({states: {...s.states, [keyOf(vault, network)]: state}}));
    } catch {
      // Keep the last answer: a failed read is not news about the vault.
    }
  },
}));

/** The gate state of the vault in front, kept current while the calling screen is shown. */
export function useVaultGate(): VaultGateState {
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const state = useGateStore((s) => (vault ? s.states[keyOf(vault, network)] : undefined));

  const read = useCallback(() => {
    if (vault) void useGateStore.getState().refresh(vault, network);
  }, [vault, network]);
  useFocusEffect(read);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && read());
    return () => sub.remove();
  }, [read]);
  const settled = usePending((s) => s.txs.filter((x) => x.status !== 'pending').length);
  useEffect(read, [settled, read]);

  return state ?? UNKNOWN;
}

/** Whether the vault in front accepts `action` right now, and if not, why. */
export function useCapability(action: VaultAction, opts?: GateOptions): Gate {
  return capability(action, useVaultGate(), opts);
}

/** The sentence for a refusal, as a translation key. */
export const gateReasonKey = (gate: Gate): string | null => (gate.allowed ? null : `vault.gate.${gate.reason}`);

import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

/**
 * Who pays a vault's network fees: the VAULT (the relayer sends the transaction and bills the vault
 * in one of its fee coins — a stablecoin, or WETH from v1.0.2) or the OWNER (the phone sends the
 * transaction itself from the owner address and pays the gas in that address's own ETH).
 *
 * Per network AND vault, like the fee reserve: two vaults are two different owners with two
 * different ETH balances, and the same vault on two chains is two different gas markets. Unset is
 * the vault, which is how every vault worked before there was a choice.
 *
 * Local, like the rest of the fee page. Nothing on chain records it, and nothing needs to: the
 * vault accepts its owner's direct calls and the forwarder's relayed ones alike.
 */
export type FeePayer = 'vault' | 'owner';

const store = new MMKV({id: 'bitty.fee-payer'});

const keyOf = (network: string, vault: string) => `${network}:${vault.toLowerCase()}`;

type State = {
  payers: Record<string, FeePayer>;
  set: (network: string, vault: string, payer: FeePayer) => void;
};

function load(): Record<string, FeePayer> {
  const out: Record<string, FeePayer> = {};
  for (const k of store.getAllKeys()) {
    const v = store.getString(k);
    if (v === 'owner' || v === 'vault') out[k] = v;
  }
  return out;
}

export const useFeePayerStore = create<State>((set, get) => ({
  payers: load(),
  set: (network, vault, payer) => {
    const k = keyOf(network, vault);
    store.set(k, payer);
    set({payers: {...get().payers, [k]: payer}});
  },
}));

/** Who pays on `network` for `vault`, read now — for the write path, which is not a component. */
export function feePayerFor(network: string, vault: string): FeePayer {
  return useFeePayerStore.getState().payers[keyOf(network, vault)] ?? 'vault';
}

/** The same, as a subscription — for the screens that show or change it. */
export function useFeePayer(network: string, vault: string | null | undefined): FeePayer {
  return useFeePayerStore((s) => (vault ? s.payers[keyOf(network, vault)] : undefined)) ?? 'vault';
}

export function setFeePayer(network: string, vault: string, payer: FeePayer): void {
  useFeePayerStore.getState().set(network, vault, payer);
}

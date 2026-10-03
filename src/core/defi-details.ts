import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

const store = new MMKV({id: 'bitty.defi'});
const KEY = 'showDetails';

/**
 * Whether to name the DeFi protocols behind the vault's positions.
 *
 * On, Earn labels each row with the protocol it routes to and the history says "Deposit to Aave".
 * Off, the same screens say what happened — yielding, lending, deposited, withdrew — and leave out
 * who it happened with. The vault picks the venue either way; this only decides whether the user is
 * told, and for someone who holds a stablecoin position because it earns, the venue is noise.
 *
 * Defaults to on, so nothing is hidden from anyone who has not asked for it.
 */
export const useDefiDetails = create<{show: boolean; setShow: (v: boolean) => void}>((set) => ({
  show: store.getBoolean(KEY) ?? true,
  setShow: (show) => {
    store.set(KEY, show);
    set({show});
  },
}));

import {useCallback, useState} from 'react';
import {useFocusEffect} from '@react-navigation/native';
import {useNetwork} from '@/core/network-store';
import {useTronWallet} from './store';
import {readTronStake, type TronStakeState} from './stake';

/** The Tron wallet's stake, read again each time a screen using it comes into focus. */
export function useTronStake() {
  const net = useNetwork((s) => s.tron) ?? 'tron';
  const from = useTronWallet((s) => s.address);
  const [state, setState] = useState<TronStakeState | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!from) return;
    setLoading(true);
    try {
      setState(await readTronStake(net, from));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [from, net]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  return {net, from, state, failed, loading, load};
}

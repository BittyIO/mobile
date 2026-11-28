import {useEffect, useState} from 'react';
import {useIsFocused} from '@react-navigation/native';

/**
 * A count that goes up every `ms` while the screen is on top and not `paused`: a dependency that
 * re-asks a price (the network fee on a Confirm button) every few seconds, so it does not go stale
 * while the page sits open. Kept at seconds, not less: Tron's node (TronGrid) throttles callers.
 */
export function useRefreshTick(ms = 10_000, paused = false): number {
  const focused = useIsFocused();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!focused || paused) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [focused, paused, ms]);
  return n;
}

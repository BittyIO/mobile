import React, {useEffect} from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useNetwork} from '@/core/network-store';
import {usePending, pendingCount} from '@/vault/pending';
import {useStyles, type Colors} from '@/theme';

/**
 * The transactions this device has submitted and the user has not looked at, beside the vault's name.
 *
 * It replaces the per-screen spinners: an action submits, the count goes up, and the user has one
 * place to look. It stays put once a transaction confirms or fails — it is a notice, and opening the
 * Confirming tab is what dismisses it. Hidden at zero, and filtered to the network on screen, since a
 * pending Base transaction is not this chain's business.
 */
export function ConfirmingBadge() {
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const txs = usePending((s) => s.txs);
  const prune = usePending((s) => s.prune);
  const acknowledge = usePending((s) => s.acknowledge);
  const count = pendingCount(txs, network);

  // Drop rows that have lingered long enough, so the badge and the tab stay honest.
  useEffect(() => {
    const id = setInterval(prune, 15_000);
    return () => clearInterval(id);
  }, [prune]);

  if (count === 0) return null;
  return (
    <Pressable
      style={styles.badge}
      hitSlop={8}
      onPress={() => {
        acknowledge();
        nav.navigate('Transactions', {tab: 'confirming'});
      }}>
      <Text style={styles.text}>{count}</Text>
    </Pressable>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    // Sized like a notification count, not a button: it sits beside a 17pt title and should read as
    // a mark on it.
    badge: {
      minWidth: 17,
      height: 17,
      borderRadius: 9,
      paddingHorizontal: 5,
      backgroundColor: c.success,
      alignItems: 'center',
      justifyContent: 'center',
    },
    text: {color: '#FFFFFF', fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums']},
  });

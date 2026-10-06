import React, {useEffect} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {useNetwork} from '@/core/network-store';
import {usePending, pendingCount, submittingCount} from '@/vault/pending';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * The transactions this device has submitted and the user has not looked at, beside the vault's name.
 *
 * It replaces the per-screen spinners: an action submits, the count goes up, and the user has one
 * place to look. It stays put once a transaction confirms or fails — it is a notice, and opening the
 * Confirming tab is what dismisses it. Hidden at zero, and filtered to the network on screen, since a
 * pending Base transaction is not this chain's business.
 *
 * Before the count there is a spinner. A write has no hash for as long as it takes to sign, quote,
 * build and relay it — several seconds on a market trade — and the sheet closes on the first of
 * those, so the corner this badge lives in was empty for the whole of it and the trade looked like
 * it had gone nowhere. While a submission is open the corner says so in words; the moment a hash
 * lands the count takes over, which is the same corner telling the same story one step on.
 */
export function ConfirmingBadge() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const txs = usePending((s) => s.txs);
  const submitting = usePending((s) => s.submitting);
  const prune = usePending((s) => s.prune);
  const acknowledge = usePending((s) => s.acknowledge);
  const count = pendingCount(txs, network);
  const sending = submittingCount(submitting, network);

  // Drop rows that have lingered long enough, so the badge and the tab stay honest.
  useEffect(() => {
    const id = setInterval(prune, 15_000);
    return () => clearInterval(id);
  }, [prune]);

  // Nothing to tap: there is no transaction to open yet. It wins over the count because it is the
  // newer news — the count comes back a moment later with this one added to it.
  if (sending > 0)
    return (
      <View style={styles.sending}>
        <ActivityIndicator size="small" color={c.subtext} />
        <Text style={styles.sendingText} numberOfLines={1}>
          {t('mobile.app.broadcasting')}
        </Text>
      </View>
    );

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
    // Reads as a status line, not a control: the header's own quiet colour, and no ground under it.
    sending: {flexDirection: 'row', alignItems: 'center', gap: 6},
    sendingText: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  });

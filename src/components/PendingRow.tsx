import React, {useEffect} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {ProgressRing, waitDone} from '@/components/ProgressRing';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * One change waiting out the timelock: the ring for how far the wait has run on the left, what it is
 * and its value, and Cancel on the right where it can be called off (through the caller's Face-ID
 * and fee confirm, so a mis-tap spends nothing). The Pending page and the asset manager's page both
 * draw their pending items with this, so the two read alike.
 *
 * ponytail: the chain keeps only when an item lands, not when it was queued, so the ring's start is
 * `at` less today's timelock; exact if the timelock hasn't changed since, else read the queuing
 * event's block time.
 */
export function PendingRow({
  at,
  now,
  timelock,
  title,
  value,
  titleRight,
  detail,
  onPress,
  onCancel,
  cancelling,
  cancelDisabled,
  onMatured,
  last,
}: {
  at: number;
  now: number;
  timelock: number;
  title: string;
  value: string;
  /** Beside the title: an ⓘ for a change that needs explaining. */
  titleRight?: React.ReactNode;
  /** Drawn in place of `value`, for a change one line cannot show (a quantum-safe key change). */
  detail?: React.ReactNode;
  onPress?: () => void;
  onCancel?: () => void;
  cancelling?: boolean;
  cancelDisabled?: boolean;
  /** Once, when the wait runs out while the row is on screen: the page re-reads, and the row goes. */
  onMatured?: () => void;
  last?: boolean;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  // At 0 the change is in force: there is nothing left to cancel.
  const matured = at <= now;
  useEffect(() => {
    if (matured) onMatured?.();
    // Only on the flip: a new `onMatured` identity is not a second maturing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matured]);
  return (
    <Pressable style={[styles.item, !last && styles.divider]} onPress={onPress} disabled={!onPress}>
      <ProgressRing done={waitDone(at, now, timelock)} left={at - now} />
      <View style={styles.itemText}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {titleRight}
        </View>
        {detail ?? <Text style={styles.value}>{value}</Text>}
      </View>
      {onCancel && !matured ? (
        <Pressable
          style={({pressed}) => [styles.cancel, (pressed || cancelDisabled) && styles.pressed]}
          disabled={cancelDisabled}
          onPress={onCancel}>
          {cancelling ? <ActivityIndicator /> : <Text style={styles.cancelText}>{t('common.cancel')}</Text>}
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    item: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: c.card},
    divider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    itemText: {flex: 1, gap: 3},
    title: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    value: {color: c.subtext, fontSize: 13},
    titleLine: {flexDirection: 'row', alignItems: 'center', gap: 6},
    cancel: {paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: c.neutralSoft, minWidth: 64, alignItems: 'center'},
    cancelText: {color: c.danger, fontSize: 13, fontWeight: '700'},
    pressed: {opacity: 0.6},
  });

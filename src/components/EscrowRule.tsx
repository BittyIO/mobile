import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * How an escrow is decided (escrow `decided`): the initiator and the counterparty agreeing settles
 * it; a side paying everything to the other settles it alone; otherwise the arbiter's choice does;
 * and the three things a choice can be. The
 * content of a card on New escrow and on the deal's page.
 */
export function EscrowRule() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const step = (n: number, title: string, body: React.ReactNode) => (
    <View style={styles.step}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{n}</Text>
      </View>
      <View style={styles.stepText}>
        <Text style={styles.title}>{title}</Text>
        {typeof body === 'string' ? <Text style={styles.body}>{body}</Text> : body}
      </View>
    </View>
  );
  return (
    <View style={styles.wrap}>
      {step(1, t('mobile.escrow.rule_agree_title'), t('mobile.escrow.rule_agree'))}
      {/* Escrow d9d06f8: a side paying everything to the other needs no agreement. */}
      {step(2, t('mobile.escrow.rule_give_title'), t('mobile.escrow.rule_give'))}
      {step(3, t('mobile.escrow.rule_disagree_title'), t('mobile.escrow.rule_disagree'))}
      {step(
        4,
        t('mobile.escrow.rule_vote_title'),
        <View style={styles.options}>
          {['to_a', 'to_b', 'refund'].map((k) => (
            <View key={k} style={styles.option}>
              <View style={styles.dot} />
              <Text style={styles.body}>{t(`mobile.escrow.${k}`)}</Text>
            </View>
          ))}
        </View>,
      )}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {gap: 12},
    step: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
    badge: {width: 24, height: 24, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center', marginTop: 1},
    badgeText: {color: c.accent, fontSize: 13, fontWeight: '700'},
    stepText: {flex: 1, gap: 2},
    title: {color: c.text, fontSize: 15, fontWeight: '600'},
    body: {color: c.subtext, fontSize: 13, lineHeight: 18},
    options: {gap: 3, marginTop: 2},
    option: {flexDirection: 'row', alignItems: 'center', gap: 8},
    dot: {width: 4, height: 4, borderRadius: 2, backgroundColor: c.subtext},
  });

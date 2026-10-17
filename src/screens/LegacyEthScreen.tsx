import React from 'react';
import {ScrollView, StyleSheet, Text} from 'react-native';
import {Button} from '@/components/Button';
import {wrapNative} from '@/vault/risk';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';

/**
 * Legacy ETH (Security › Legacy ETH) — wraps native ETH sitting idle in the vault into WETH so it
 * can be traded. ETH that arrives is wrapped as it lands; this is for any that is still idle.
 */
export function LegacyEthScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {busy, ready, run, sheet} = useVaultWrite();

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <Button
        title={busy === 'wrap' ? t('mobile.vault.wrapping') : t('mobile.vault.wrap_idle_eth')}
        variant="secondary"
        loading={busy === 'wrap'}
        disabled={!ready}
        onPress={() => run('wrap', t('mobile.vault.wrap_idle_eth'), wrapNative)}
      />
      <Text style={styles.fine}>{t('mobile.vault.wrap_idle_eth_hint')}</Text>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 20, paddingBottom: 24, gap: 10},
    fine: {color: c.subtext, fontSize: 11, lineHeight: 15},
  });

import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SettingsGroup} from '@/components/SettingsRow';
import {Button} from '@/components/Button';
import {customRpc, rpcServes, setCustomRpc} from '@/core/chain';
import {useNetwork, networkLabel} from '@/core/network-store';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/**
 * Settings › RPC — the node this app reads the chain through, for the network in front.
 *
 * Empty means the public defaults. A URL is checked before it is kept: it has to answer, and answer
 * as THIS network, so a typo or a node for another chain never quietly becomes the source of the
 * vault's address book and pending changes.
 */
export function RpcScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const [saved, setSaved] = useState(() => customRpc(network));
  const [url, setUrl] = useState(saved ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmed = url.trim();
  const save = async () => {
    setErr(null);
    if (!/^https:\/\/\S+$/i.test(trimmed)) return setErr(t('mobile.settings.rpc_invalid'));
    setBusy(true);
    const ok = await rpcServes(trimmed, network);
    setBusy(false);
    if (!ok) return setErr(t('mobile.settings.rpc_wrong_chain', {network: networkLabel(network, t)}));
    setCustomRpc(network, trimmed);
    setSaved(trimmed);
  };
  const reset = () => {
    setCustomRpc(network, null);
    setSaved(null);
    setUrl('');
    setErr(null);
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <SettingsGroup footer={t('mobile.settings.rpc_hint')}>
        <View style={styles.card}>
          <Text style={styles.label}>
            {networkLabel(network, t)} · {saved ? t('mobile.settings.rpc_custom') : t('mobile.settings.rpc_default')}
          </Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://"
            placeholderTextColor={c.subtext}
            value={url}
            onChangeText={setUrl}
          />
          {err ? <Text style={styles.err}>{err}</Text> : null}
        </View>
      </SettingsGroup>
      <Button title={t('vault.save')} onPress={save} loading={busy} disabled={!trimmed || trimmed === saved} />
      {saved ? <Button title={t('mobile.settings.rpc_reset')} variant="secondary" onPress={reset} /> : null}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 16},
    card: {padding: 16, gap: 10},
    label: {color: c.subtext, fontSize: 13},
    input: {height: 44, borderRadius: 10, backgroundColor: c.input, color: c.text, paddingHorizontal: 12, fontSize: 16},
    err: {color: c.danger, fontSize: 13},
  });

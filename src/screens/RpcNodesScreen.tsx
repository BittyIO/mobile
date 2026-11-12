import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {CHAIN_ID} from '@/core/chain';
import {BUILTIN_RPC, isRpcUrl, probeRpc, probeTron, rpcHost, useRpcNodes, type NodeChain, type RpcProbe} from '@/core/rpc-store';
import {isTronNet, TRON_API} from '@/tron/config';
import {SettingsGroup, SettingsRow, makeSettingsStyles} from '@/components/SettingsRow';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import {NETWORKS, TRON_ENABLED, networkLabel} from '@/core/network-store';
import {Sheet} from '@/components/Sheet';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

const NONE: string[] = [];

/** Ask a node which chain it serves and its latest block, the EVM way or the Tron way. */
const probeNode = (url: string, network: NodeChain): Promise<RpcProbe> =>
  isTronNet(network) ? probeTron(url, network) : probeRpc(url, CHAIN_ID[network]);

/** One node: its host, how far it has got (or that it can't be reached), and its control. */
function NodeRow({
  url,
  probe,
  right,
  last,
}: {
  url: string;
  probe: RpcProbe | 'checking' | undefined;
  right: React.ReactNode;
  last?: boolean;
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const status =
    probe === undefined || probe === 'checking'
      ? t('mobile.rpc.checking')
      : probe.ok
        ? t('mobile.rpc.block', {block: probe.block.toLocaleString()})
        : probe.reason === 'wrong_chain'
          ? probe.chainId != null
            ? t('mobile.rpc.wrong_chain', {chain: String(probe.chainId)})
            : t('mobile.rpc.wrong_network')
          : t('mobile.rpc.unreachable');
  const bad = probe !== undefined && probe !== 'checking' && !probe.ok;
  return (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {rpcHost(url)}
        </Text>
        <Text style={[styles.rowSub, bad && styles.bad]}>{status}</Text>
      </View>
      <View style={styles.rowRight}>{right}</View>
    </View>
  );
}

/**
 * Settings › Network › RPC nodes: every network, each opening its own nodes (see {RpcNetworkScreen}).
 * All of them, not only those the picker lists: a network's nodes can be set before it is shown.
 */
export function RpcNodesListScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const chains: NodeChain[] = TRON_ENABLED ? [...NETWORKS.slice(0, 1), 'tron', ...NETWORKS.slice(1)] : NETWORKS;
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.body} contentInsetAdjustmentBehavior="automatic">
      <SettingsGroup>
        {chains.map((n, i) => (
          <SettingsRow
            key={n}
            icon="network"
            leading={<NetworkIcon network={n} size={29} />}
            title={networkLabel(n, t)}
            onPress={() => nav.navigate('RpcNetwork', {network: n})}
            last={i === chains.length - 1}
          />
        ))}
      </SettingsGroup>
    </ScrollView>
  );
}

/**
 * Settings › Network › RPC nodes › a network, for the network in front (the one the network switcher has picked; Tron's
 * wallet when Tron is in front). In the app's section, not the vault's: which nodes this phone asks
 * is a setting of the phone — the same for every vault, no signature, applies at once, seen by no
 * one else. Another network's nodes are set by switching to it first.
 *
 * The built-in public nodes, each with a switch, then the
 * owner's own, then a field to add one.
 *
 * Every node is asked which chain it serves and its latest block when the page opens, so a node
 * that is down, behind, or for the wrong chain shows as one. A node to add is asked the same before
 * it is saved, and refused when it serves another chain. The last node on can't be switched off or
 * removed: reads go only to the nodes that are on, with no quiet fallback to the others.
 */
export function RpcNetworkScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const {network} = useRoute<RouteProp<RootStackParamList, 'RpcNetwork'>>().params;
  // Selected as stored and defaulted after: a fresh [] from the selector would never compare equal.
  const offRaw = useRpcNodes((s) => s.off[network]);
  const customRaw = useRpcNodes((s) => s.custom[network]);
  const off = offRaw ?? NONE;
  const custom = customRaw ?? NONE;
  const {setBuiltin, addCustom, removeCustom, reset} = useRpcNodes.getState();
  const builtin = BUILTIN_RPC[network];
  const onCount = custom.length + builtin.filter((u) => !off.includes(u)).length;

  const [probes, setProbes] = useState<Record<string, RpcProbe | 'checking'>>({});
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  const check = useCallback(
    (urls: string[]) => {
      setProbes((p) => ({...p, ...Object.fromEntries(urls.map((u) => [u, 'checking' as const]))}));
      for (const u of urls) probeNode(u, network).then((r) => setProbes((p) => ({...p, [u]: r})));
    },
    [network],
  );
  useEffect(() => {
    check([...builtin, ...(useRpcNodes.getState().custom[network] ?? [])]);
    // Once per page: the list's own changes probe only what they add.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  const add = async () => {
    const url = draft.trim().replace(/\/+$/, '');
    setError(null);
    if (!isRpcUrl(url)) return setError(t('mobile.rpc.invalid_url'));
    if (builtin.includes(url) || custom.includes(url)) return setError(t('mobile.rpc.duplicate'));
    setAdding(true);
    const r = await probeNode(url, network);
    setAdding(false);
    if (!r.ok) {
      return setError(
        r.reason !== 'wrong_chain'
          ? t('mobile.rpc.unreachable')
          : r.chainId != null
            ? t('mobile.rpc.wrong_chain', {chain: String(r.chainId)})
            : t('mobile.rpc.wrong_network'),
      );
    }
    addCustom(network, url);
    setProbes((p) => ({...p, [url]: r}));
    setDraft('');
  };

  const confirmReset = () =>
    Alert.alert(t('mobile.rpc.reset'), t('mobile.rpc.reset_confirm'), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('mobile.rpc.reset'),
        style: 'destructive',
        onPress: () => {
          reset(network);
          check(builtin);
        },
      },
    ]);

  const changed = off.length > 0 || custom.length > 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.body}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled">
      <SettingsGroup
        label={t('mobile.rpc.builtin')}
        footer={isTronNet(network) && off.includes(TRON_API[network]) ? t('mobile.rpc.tron_history_off') : undefined}>
        {builtin.map((u, i) => {
          const on = !off.includes(u);
          return (
            <NodeRow
              key={u}
              url={u}
              probe={probes[u]}
              last={i === builtin.length - 1}
              right={
                <Switch
                  value={on}
                  // The last node on stays on: with none, the app could not read the chain at all.
                  disabled={on && onCount <= 1}
                  onValueChange={(v) => void setBuiltin(network, u, v)}
                  style={styles.rowSwitch}
                />
              }
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup label={t('mobile.rpc.custom')} labelInfo={() => setInfoOpen(true)}>
        {custom.map((u) => (
          <NodeRow
            key={u}
            url={u}
            probe={probes[u]}
            right={
              <Pressable
                disabled={onCount <= 1}
                hitSlop={8}
                onPress={() => removeCustom(network, u)}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.rpc.remove')}>
                <Text style={[styles.remove, onCount <= 1 && styles.removeOff]}>{t('mobile.rpc.remove')}</Text>
              </Pressable>
            }
          />
        ))}
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={(v) => {
              setDraft(v);
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={add}
            editable={!adding}
          />
          <Pressable
            disabled={adding || draft.trim() === ''}
            onPress={add}
            style={[styles.addBtn, (adding || draft.trim() === '') && styles.addOff]}
            accessibilityRole="button">
            {adding ? <ActivityIndicator color={c.accent} /> : <Text style={[styles.addText, draft.trim() === '' && styles.addTextOff]}>{t('mobile.rpc.add')}</Text>}
          </Pressable>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </SettingsGroup>

      {/* What to know before adding one — who to trust, and that it stays on this phone — behind the
          ⓘ after "Custom nodes", so the page itself is just the nodes. */}
      <Sheet visible={infoOpen} title={t('mobile.rpc.custom')} onClose={() => setInfoOpen(false)}>
        <View style={styles.info}>
          <Text style={styles.infoText}>{t('mobile.rpc.custom_warning')}</Text>
          <Text style={styles.infoText}>{t(isTronNet(network) ? 'mobile.rpc.local_only_tron' : 'mobile.rpc.local_only')}</Text>
        </View>
      </Sheet>

      {changed ? (
        <Pressable onPress={confirmReset} style={styles.resetBtn} accessibilityRole="button">
          <Text style={styles.resetText}>{t('mobile.rpc.reset')}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 24},
    bad: {color: c.danger},
    remove: {color: c.danger, fontSize: 15, fontWeight: '600'},
    removeOff: {color: c.subtext},
    addRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10},
    input: {flex: 1, height: 40, borderRadius: 10, backgroundColor: c.input, color: c.text, paddingHorizontal: 12, fontSize: 16},
    addBtn: {
      height: 40,
      minWidth: 64,
      paddingHorizontal: 16,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
    },
    addOff: {borderColor: c.border, backgroundColor: c.card},
    addText: {color: c.accent, fontSize: 14, fontWeight: '700'},
    addTextOff: {color: c.subtext},
    error: {color: c.danger, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingBottom: 12},
    info: {gap: 12, paddingHorizontal: 4, paddingBottom: 24},
    infoText: {color: c.text, fontSize: 15, lineHeight: 22},
    resetBtn: {alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16},
    resetText: {color: c.danger, fontSize: 15, fontWeight: '600'},
  });

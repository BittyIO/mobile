import React, {useState} from 'react';
import {ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import Svg, {Path} from 'react-native-svg';
import {getAddress, isAddress} from 'viem';
import {useVaults, vaultLabel, type VaultRef} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';
import {networkLabel, useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {useWallet} from '@/wallet/store';
import * as keyring from '@/wallet/keyring';
import {fetchSafe, SafeApiError} from '@/vault/safe';
import {useVaultDirectory, type FoundVault} from '@/vault/owned-vaults';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/** How many of the phrase's accounts are searched for an owner of a Safe being added. */
const SAFE_KEY_SCAN = 10;

/**
 * Settings › Vaults: every vault on this phone, and the ones its keys own that are not on it yet.
 *
 * A key owns the vault the factory derives from it and any vault transferred to it, so one key can
 * stand behind several. Those it was given are found by asking the server which vaults each key
 * owns (vault/owned-vaults), each time the page opens and on a pull, and offered under Found with
 * an Add. A vault that has been transferred AWAY is still listed, greyed and marked as no longer
 * yours, so it does not just vanish; it cannot be chosen, and a long press removes it.
 *
 * Choosing a vault makes it the one in front and goes back. One received on another chain switches
 * to that chain first — it exists nowhere else.
 */
export function VaultListScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
  const network = useNetwork((s) => s.network);
  const setNetwork = useNetwork((s) => s.setNetwork);
  const vaults = useVaults((s) => s.vaults);
  const activeIndex = useVaults((s) => s.activeIndex);
  const rename = useVaults((s) => s.rename);
  const selectVault = useWallet((s) => s.selectVault);

  const [refresh, setRefresh] = useState(0);
  const [pulled, setPulled] = useState(false);
  const {found, notYours} = useVaultDirectory(network, vaults, refresh);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [safeOpen, setSafeOpen] = useState(false);
  const [safeDraft, setSafeDraft] = useState('');
  const [safeError, setSafeError] = useState<string | null>(null);

  const label = (n: number) => t('mobile.app.vault_n', {n});
  const commit = () => {
    if (editing != null) rename(editing, draft);
    setEditing(null);
  };

  const choose = (v: VaultRef) => {
    commit();
    if (!v.owner || notYours.has(v.index)) return;
    if (v.vault && v.network && v.network !== network) setNetwork(v.network as Network);
    selectVault(v.index);
    nav.goBack();
  };

  const askRemove = (v: VaultRef) => {
    if (vaults.length <= 1) return;
    Alert.alert(t('mobile.vaults.remove_title'), t('mobile.vaults.remove_msg'), [
      {text: t('common.cancel'), style: 'cancel'},
      {text: t('mobile.vaults.remove'), style: 'destructive', onPress: () => useVaults.getState().remove(v.index)},
    ]);
  };

  /**
   * Add the next vault: the phrase's next account. One prompt derives every owner up to it, so a
   * device that only ever unlocked the first fills in the addresses it never had. The vault is
   * counterfactual until its first action, like every new one.
   */
  const onAdd = async () => {
    setBusy(true);
    try {
      const next = Math.max(...vaults.map((v) => v.index)) + 1;
      const addrs = await keyring.addressesUpTo(next + 1);
      if (!addrs) return;
      const {setOwner, add} = useVaults.getState();
      vaults.forEach((v) => !v.owner && !v.safe && !v.vault && addrs[v.index] && setOwner(v.index, addrs[v.index]));
      selectVault(add(addrs[next]));
      nav.goBack();
    } finally {
      setBusy(false);
    }
  };

  /** Put a vault this device's key owns by transfer on the list, on this chain, and choose it. */
  const onAddFound = (f: FoundVault) => {
    const index = useVaults.getState().addReceived(f.vault, network, f.key.index, f.key.address);
    selectVault(index);
    nav.goBack();
  };

  /**
   * Add a vault owned by the Safe in the field, read on THIS chain (a Safe is deployed per chain).
   * The key that signs for it is whichever of this phone's accounts is one of its owners; with
   * none, the user is told which address to add to the Safe.
   */
  const onAddSafe = async () => {
    setSafeError(null);
    const raw = safeDraft.trim();
    if (!isAddress(raw)) return setSafeError(t('mobile.safe.invalid_address'));
    const safe = getAddress(raw);
    setBusy(true);
    try {
      let info;
      try {
        info = await fetchSafe(network, safe);
      } catch (e) {
        return setSafeError(e instanceof SafeApiError && e.reason === 'safe-not-found' ? t('mobile.safe.not_found') : String((e as Error)?.message ?? e));
      }
      if (!info.supported) return setSafeError(t('mobile.safe.unsupported', {problems: info.problems.join(', ')}));
      const addrs = await keyring.addressesUpTo(Math.max(SAFE_KEY_SCAN, ...vaults.map((v) => v.index + 1)));
      if (!addrs) return;
      const owners = new Set(info.owners.map((o) => o.toLowerCase()));
      const signerIndex = addrs.findIndex((a) => owners.has(a.toLowerCase()));
      if (signerIndex < 0) return setSafeError(t('mobile.safe.no_owner_key', {address: addrs[0]}));
      selectVault(useVaults.getState().addSafe(safe, signerIndex, addrs[signerIndex]));
      nav.goBack();
    } finally {
      setBusy(false);
    }
  };

  const row = (v: VaultRef, i: number, list: VaultRef[]) => {
    const on = v.index === activeIndex;
    const gone = notYours.has(v.index);
    const address = vaultAddressOf(v, network);
    // A received vault on another chain: say which, since it does not exist on this one.
    const elsewhere = !!v.vault && v.network !== network;
    const tag = v.safe ? t('mobile.vaults.tag_safe') : v.vault ? t('mobile.vaults.tag_received') : null;
    return (
      <Pressable
        key={v.index}
        style={({pressed}) => [styles.vaultRow, i < list.length - 1 && styles.rowDivider, gone && styles.gone, pressed && styles.pressed]}
        onPress={() => choose(v)}
        onLongPress={() => askRemove(v)}
        disabled={editing === v.index}>
        <View style={styles.vaultText}>
          <View style={styles.nameLine}>
            {editing === v.index ? (
              <TextInput
                style={[styles.name, styles.nameInput]}
                value={draft}
                onChangeText={setDraft}
                onBlur={commit}
                onSubmitEditing={commit}
                placeholder={label(v.index + 1)}
                placeholderTextColor={c.subtext}
                returnKeyType="done"
                autoFocus
                maxLength={24}
              />
            ) : (
              <>
                <Text style={styles.name} numberOfLines={1}>
                  {vaultLabel(v, label)}
                </Text>
                <Pressable
                  hitSlop={10}
                  onPress={() => {
                    setDraft(v.name);
                    setEditing(v.index);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('vault.edit')}>
                  <Svg width={14} height={14} viewBox="0 0 24 24">
                    <Path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </Svg>
                </Pressable>
              </>
            )}
            {tag ? <Text style={styles.tag}>{tag}</Text> : null}
          </View>
          <Text style={styles.addr}>
            {elsewhere ? t('mobile.vaults.on_network', {network: networkLabel(v.network as Network, t)}) : (address ?? t('mobile.settings.vault_unlock_first'))}
          </Text>
          {gone ? <Text style={styles.goneText}>{t('mobile.vaults.not_yours')}</Text> : null}
        </View>
        {/* Always laid out, shown only on the one in front, so rows keep their height. */}
        <Text style={[styles.check, !on && styles.checkHidden]}>✓</Text>
      </Pressable>
    );
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={
        <RefreshControl
          refreshing={pulled}
          onRefresh={() => {
            setPulled(true);
            setRefresh((n) => n + 1);
            setTimeout(() => setPulled(false), 800);
          }}
          tintColor={c.text}
        />
      }>
      <SettingsGroup>{vaults.map(row)}</SettingsGroup>

      {found.length > 0 ? (
        <SettingsGroup label={t('mobile.vaults.found')}>
          {found.map((f, i) => (
            <View key={f.vault} style={[styles.vaultRow, i < found.length - 1 && styles.rowDivider]}>
              <View style={styles.vaultText}>
                <Text style={styles.addr}>{f.vault}</Text>
              </View>
              <Pressable onPress={() => onAddFound(f)} hitSlop={8} accessibilityRole="button">
                <Text style={styles.link}>{t('mobile.vaults.add')}</Text>
              </Pressable>
            </View>
          ))}
        </SettingsGroup>
      ) : null}

      <SettingsGroup>
        <Pressable style={[styles.row, styles.rowDivider]} onPress={onAdd} disabled={busy}>
          <Text style={styles.link}>{`＋ ${t('mobile.settings.add_vault')}`}</Text>
          {busy && !safeOpen ? <ActivityIndicator color={c.subtext} /> : null}
        </Pressable>
        <Pressable style={styles.row} onPress={() => setSafeOpen((o) => !o)} disabled={busy}>
          <Text style={styles.link}>{`＋ ${t('mobile.safe.add_safe_vault')}`}</Text>
        </Pressable>
        {safeOpen ? (
          <View style={styles.form}>
            <Text style={styles.intro}>{t('mobile.safe.add_safe_intro')}</Text>
            <TextInput
              style={styles.field}
              value={safeDraft}
              onChangeText={(v) => {
                setSafeDraft(v);
                setSafeError(null);
              }}
              placeholder={t('mobile.safe.safe_address')}
              placeholderTextColor={c.subtext}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            {safeError ? <Text style={styles.error}>{safeError}</Text> : null}
            <Pressable onPress={onAddSafe} disabled={busy}>
              <Text style={styles.link}>{busy ? t('mobile.safe.checking') : t('mobile.safe.add')}</Text>
            </Pressable>
          </View>
        ) : null}
      </SettingsGroup>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 20, paddingBottom: 32},
    vaultRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 56},
    vaultText: {flex: 1, gap: 3},
    nameLine: {flexDirection: 'row', alignItems: 'center', gap: 6},
    name: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    nameInput: {flex: 1, padding: 0, margin: 0},
    tag: {color: c.subtext, fontSize: 11, fontWeight: '600', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden'},
    // Full, and small enough to wrap to two lines rather than be cut: vaults are told apart by
    // their address, and an elided middle is where two would differ.
    addr: {color: c.subtext, fontSize: 11, fontFamily: 'Menlo', lineHeight: 15},
    gone: {opacity: 0.45},
    goneText: {color: c.warning, fontSize: 12},
    pressed: {opacity: 0.6},
    checkHidden: {opacity: 0},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
    form: {gap: 12, paddingHorizontal: 16, paddingBottom: 16},
    intro: {color: c.subtext, fontSize: 13, lineHeight: 18},
    field: {color: c.text, fontSize: 13, fontFamily: 'Menlo', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10},
    error: {color: c.danger, fontSize: 13, lineHeight: 18},
  });

import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import Svg, {Path} from 'react-native-svg';
import {getAddress, isAddress, type Address} from 'viem';
import {useVaults, vaultLabel, type VaultRef} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';
import {networkLabel, useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {useWallet} from '@/wallet/store';
import * as keyring from '@/wallet/keyring';
import {fetchSafe, SafeApiError} from '@/vault/safe';
import {deviceKeys, fetchOwnedVaults, useVaultDirectory, type FoundVault} from '@/vault/owned-vaults';
import {PickerSheet} from '@/components/AssetPicker';
import {acceptOwnership} from '@/vault/ownership';
import {relayGasFor} from '@/vault/fee-quote';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useConfirmAction} from '@/components/ConfirmAction';
import {showToast, showTx} from '@/components/Toast';
import Clipboard from '@react-native-clipboard/clipboard';
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
 *
 * The owner comes first: one of this phone's keys, or a Safe added here. The list below is that
 * owner's vaults alone — the one the factory derives from it, those transferred to it, and any the
 * server finds for it — so a phone with several keys does not show every key's vaults in one heap.
 * It starts on the owner of the vault in front, and changing it asks the server again.
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

  /**
   * Who owns a listed vault: a Safe vault its Safe, every other the key that signs for it. A key
   * whose address has not been derived on this phone yet (that takes Face ID, once) goes by its
   * index until it has one, so its vault is still listed under it.
   */
  const ownerOf = (v: VaultRef): string => (v.safe ?? v.owner)?.toLowerCase() ?? `index:${v.index}`;
  // Every owner this phone can act as: its keys, then the Safes it has added.
  const owners = useMemo(() => {
    const keys: {key: string; address: string | null; keyIndex: number; safe: boolean}[] = deviceKeys(vaults).map((k) => ({
      key: k.address.toLowerCase(),
      address: k.address,
      keyIndex: k.index,
      safe: false,
    }));
    for (const v of vaults)
      if (!v.safe && !v.vault && !v.owner) keys.push({key: `index:${v.index}`, address: null, keyIndex: v.index, safe: false});
    const safes = vaults
      .filter((v) => v.safe)
      .map((v) => ({key: v.safe!.toLowerCase(), address: v.safe!, keyIndex: v.signerIndex ?? 0, safe: true}));
    return [...keys, ...safes.filter((s) => !keys.some((k) => k.key === s.key))].sort((a, b) =>
      a.safe === b.safe ? a.keyIndex - b.keyIndex : a.safe ? 1 : -1,
    );
  }, [vaults]);
  const active = vaults.find((v) => v.index === activeIndex);
  const [owner, setOwner] = useState<string | null>(() => (active ? ownerOf(active) : null));
  const current = owners.find((o) => o.key === owner) ?? owners[0];
  const [ownerOpen, setOwnerOpen] = useState(false);
  const label = (n: number) => t('mobile.app.vault_n', {n});
  /**
   * An owner is named after the vault it was made for — "Owner of Savings" — since that is the name
   * the user gave: a key's own vault (the one the factory derives from it), a Safe's vault. A key
   * with no vault of its own here (it only signs for a Safe, or only received one) keeps its number.
   */
  const ownerLabel = (o: (typeof owners)[number]) => {
    const own = vaults.find((v) => (o.safe ? v.safe?.toLowerCase() === o.key : !v.safe && !v.vault && v.index === o.keyIndex));
    return own ? t('mobile.vaults.owner_of', {name: vaultLabel(own, label)}) : t('mobile.vaults.owner_n', {n: o.keyIndex + 1});
  };
  const {notYours} = useVaultDirectory(network, vaults, refresh);
  const mine = vaults.filter((v) => current && ownerOf(v) === current.key);

  /**
   * What the server says the chosen owner holds on this chain, asked each time the owner changes
   * and on a pull. Every one is offered under it unless that owner's own entry for it is already
   * listed — a vault this phone still lists under the key that GAVE it away (greyed as no longer
   * yours) used to hide it here, which is how a transfer between this phone's own keys went missing.
   */
  const [owned, setOwned] = useState<{owned: Address[]; pending: Address[]} | null>(null);
  useEffect(() => {
    setOwned(null);
    if (!current?.address || current.safe) return;
    let live = true;
    fetchOwnedVaults(network, current.address as Address).then((r) => live && setOwned(r));
    return () => {
      live = false;
    };
  }, [network, current?.key, current?.address, current?.safe, refresh]);
  const listedHere = new Set(mine.map((v) => vaultAddressOf(v, network)?.toLowerCase()).filter(Boolean) as string[]);
  const foundMine: FoundVault[] =
    owned && current?.address
      ? [...owned.owned.map((vault) => ({vault, pending: false})), ...owned.pending.map((vault) => ({vault, pending: true}))]
          .filter((f) => !listedHere.has(f.vault.toLowerCase()))
          .map((f) => ({...f, key: {index: current.keyIndex, address: current.address as Address}}))
      : [];
  // Owned now: listed with the rest. Handed over and waiting to be accepted (the handover older
  // vaults used): offered on their own, since accepting is a signature.
  const received = foundMine.filter((f) => !f.pending);
  const waiting = foundMine.filter((f) => f.pending);
  const [busy, setBusy] = useState(false);
  const [safeOpen, setSafeOpen] = useState(false);
  const [safeDraft, setSafeDraft] = useState('');
  const [safeError, setSafeError] = useState<string | null>(null);
  const stable = useAssetCatalog(network).find((a) => a.kind === 'stable')?.address;
  const {ask, sheet} = useConfirmAction();

  /**
   * Renaming a vault: the pencil opens the system text dialog — the name in a field, the vault's
   * address under the title, Cancel and Save — as an address-book entry is renamed. The name is
   * this phone's; saved empty, the vault goes back to "Vault {n}".
   */
  const renameVault = (v: VaultRef) =>
    Alert.prompt(
      t('mobile.payments.edit_name'),
      vaultAddressOf(v, network) ?? undefined,
      [
        {text: t('common.cancel'), style: 'cancel'},
        {text: t('vault.save'), onPress: (name?: string) => rename(v.index, name ?? '')},
      ],
      'plain-text',
      v.name,
    );

  const choose = (v: VaultRef) => {
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

  /**
   * Take a vault handed to one of this device's keys and not yet accepted — the second step of the
   * two-step handover the vaults deployed today use — then list it and choose it. Signed by THAT
   * key, which need not be the key of the vault in front.
   */
  const onAccept = (f: FoundVault) =>
    ask({
      title: t('mobile.vaults.accept_title'),
      message: f.vault,
      gas: relayGasFor({}),
      run: async () => {
        if (!stable) return;
        const tx = showTx(t('mobile.vaults.accept_title'), network);
        try {
          const account = await keyring.unlock(f.key.index);
          if (!account) return tx.done();
          tx.success(await acceptOwnership({account, vault: f.vault, network, stableCoin: stable}));
          onAddFound(f);
        } catch (e) {
          tx.error(String((e as Error)?.message ?? e));
        }
      },
    });

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

  const row = (v: VaultRef, i: number, count: number) => {
    const on = v.index === activeIndex;
    const gone = notYours.has(v.index);
    const address = vaultAddressOf(v, network);
    // A received vault on another chain: say which, since it does not exist on this one.
    const elsewhere = !!v.vault && v.network !== network;
    const tag = v.safe ? t('mobile.vaults.tag_safe') : v.vault ? t('mobile.vaults.tag_received') : null;
    return (
      <Pressable
        key={v.index}
        style={({pressed}) => [styles.vaultRow, i < count - 1 && styles.rowDivider, gone && styles.gone, pressed && styles.pressed]}
        onPress={() => choose(v)}
        onLongPress={() => askRemove(v)}>
        <View style={styles.vaultText}>
          <View style={styles.nameLine}>
            <Text style={styles.name} numberOfLines={1}>
              {vaultLabel(v, label)}
            </Text>
            <Pressable
              hitSlop={10}
              onPress={() => renameVault(v)}
              accessibilityRole="button"
              accessibilityLabel={t('vault.edit')}>
              <Svg width={14} height={14} viewBox="0 0 24 24">
                <Path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </Svg>
            </Pressable>
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
      {/* The owner first: everything below is its vaults. */}
      {current ? (
        <SettingsGroup label={t('mobile.vaults.owner')}>
          {/* Long press copies the owner's address, as it does on every address in the app. */}
          <Pressable
            style={({pressed}) => [styles.vaultRow, pressed && styles.pressed]}
            onPress={() => setOwnerOpen(true)}
            onLongPress={() => {
              if (!current.address) return;
              Clipboard.setString(current.address);
              showToast('success', t('common.copied'), current.address, 1500);
            }}>
            <View style={styles.vaultText}>
              <Text style={styles.name}>{ownerLabel(current)}</Text>
              <Text style={styles.addr}>{current.address ?? t('mobile.settings.vault_unlock_first')}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </SettingsGroup>
      ) : null}

      {/* The owner's vaults: those on this phone, then those the server says it holds that are not
          on the phone yet — listed the same way, since a transfer needs nothing from the receiver.
          Choosing one of those puts it on the phone's list (nothing on chain) and opens it. */}
      <SettingsGroup label={t('mobile.vaults.vaults_of_owner')}>
        {mine.map((v, i) => row(v, i, mine.length + received.length))}
        {received.map((f, i) => (
          <Pressable
            key={f.vault}
            style={({pressed}) => [styles.vaultRow, i < received.length - 1 && styles.rowDivider, pressed && styles.pressed]}
            onPress={() => onAddFound(f)}>
            <View style={styles.vaultText}>
              <View style={styles.nameLine}>
                <Text style={styles.name} numberOfLines={1}>
                  {/* The name it will have once on the phone's list: the next free index. */}
                  {label(Math.max(...vaults.map((v) => v.index)) + i + 2)}
                </Text>
                <Text style={styles.tag}>{t('mobile.vaults.tag_received')}</Text>
              </View>
              <Text style={styles.addr}>{f.vault}</Text>
            </View>
            <Text style={[styles.check, styles.checkHidden]}>✓</Text>
          </Pressable>
        ))}
      </SettingsGroup>

      {waiting.length > 0 ? (
        <SettingsGroup label={t('mobile.vaults.found')}>
          {waiting.map((f, i) => (
            <View key={f.vault} style={[styles.vaultRow, i < waiting.length - 1 && styles.rowDivider]}>
              <View style={styles.vaultText}>
                <Text style={styles.addr}>{f.vault}</Text>
                {/* Handed to this key and waiting for it to accept: it is not this key's until then. */}
                {f.pending ? <Text style={styles.goneText}>{t('mobile.vaults.pending_note')}</Text> : null}
              </View>
              <Pressable onPress={() => (f.pending ? onAccept(f) : onAddFound(f))} hitSlop={8} accessibilityRole="button">
                <Text style={styles.link}>{t(f.pending ? 'mobile.vaults.accept' : 'mobile.vaults.add')}</Text>
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
      <PickerSheet
        visible={ownerOpen}
        title={t('mobile.vaults.choose_owner')}
        items={owners.map((o) => ({key: o.key, label: ownerLabel(o), sub: o.address ?? undefined}))}
        selected={current?.key}
        onSelect={(k) => {
          setOwner(k);
          setOwnerOpen(false);
        }}
        onClose={() => setOwnerOpen(false)}
      />
      {sheet}
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
    tag: {color: c.subtext, fontSize: 11, fontWeight: '600', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden'},
    // Full, and small enough to wrap to two lines rather than be cut: vaults are told apart by
    // their address, and an elided middle is where two would differ.
    addr: {color: c.subtext, fontSize: 11, fontFamily: 'Menlo', lineHeight: 15},
    gone: {opacity: 0.45},
    goneText: {color: c.warning, fontSize: 12},
    pressed: {opacity: 0.6},
    checkHidden: {opacity: 0},
    chevron: {color: c.subtext, fontSize: 22, fontWeight: '300'},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
    form: {gap: 12, paddingHorizontal: 16, paddingBottom: 16},
    intro: {color: c.subtext, fontSize: 13, lineHeight: 18},
    field: {color: c.text, fontSize: 13, fontFamily: 'Menlo', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10},
    error: {color: c.danger, fontSize: 13, lineHeight: 18},
  });

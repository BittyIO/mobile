import React, {useEffect, useLayoutEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import Svg, {Path} from 'react-native-svg';
import type {Address} from 'viem';
import {SAFE_ENABLED} from '@/core/features';
import {useVaults, vaultLabel, type VaultRef} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';
import {ownerVaultAddress} from '@/vault/read';
import {useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {useWallet} from '@/wallet/store';
import * as keyring from '@/wallet/keyring';
import {deviceKeys, fetchOwnedVaults, useVaultDirectory, type FoundVault} from '@/vault/owned-vaults';
import {acceptOwnership} from '@/vault/ownership';
import {relayGasFor} from '@/vault/fee-quote';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useConfirmAction} from '@/components/ConfirmAction';
import {showToast, showTx} from '@/components/Toast';
import {Sheet} from '@/components/Sheet';
import {MoreIcon} from '@/components/TradeMenu';
import {getPref, setPref} from '@/core/prefs';
import Clipboard from '@react-native-clipboard/clipboard';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {wrappableAddress, asShown} from '@/core/format';
import {useColors, useStyles, type Colors, MONO} from '@/theme';

/**
 * Settings › Vaults: every vault on this phone, and the ones its keys own that are not on it yet.
 *
 * A key owns the vault the factory derives from it and any vault transferred to it, so one key can
 * stand behind several. Those it was given are found by asking the server which vaults each key
 * owns (vault/owned-vaults), each time the page opens and on a pull, and offered under Found with
 * an Add. A vault that has been transferred AWAY is still listed, greyed and marked as no longer
 * yours, so it does not just vanish; it cannot be opened. A long press on any vault, or on an
 * owner's header, copies the address.
 *
 * Choosing a vault makes it the one in front and goes back. One received on another chain switches
 * to that chain first — it exists nowhere else.
 *
 * One list of every vault, grouped by the owner that holds it — a key on this phone, or a Safe added
 * here — under that owner's address. Choosing a vault is one tap whatever its owner; the grouping
 * only says whose it is.
 */
const SHOW_OWNERS = 'vaults.showOwners';
const SHOW_TRANSFERRED = 'vaults.showTransferred';
const SHOW_SAFE = 'vaults.showSafe';

/**
 * The Vaults page's header-right: a ⋯ like the Trade screen's, opening how the list is shown (see
 * the sheet in {VaultListScreen}). Owner addresses are a detail most people never need, so the list
 * is one plain list of vaults until "Show owners" is turned on; Safe vaults, and adding one, show
 * only with "Show Safe multi-sig vaults". Remembered on this phone. Module scope so the header's
 * right side keeps one element type across renders.
 *
 * Only the button is in the header. The sheet and its switches live in the screen: a header item is
 * re-rendered by the native header when its options change, and a switch inside it read its new
 * value a render late, so each one took two taps to turn.
 */
function VaultsMenuButton({onPress}: {onPress: () => void}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={onPress} style={styles.moreBtn} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('mobile.trade.more')}>
      <MoreIcon color={c.text} />
    </Pressable>
  );
}

export function VaultListScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const setNetwork = useNetwork((s) => s.setNetwork);
  const vaults = useVaults((s) => s.vaults);
  const activeIndex = useVaults((s) => s.activeIndex);
  const rename = useVaults((s) => s.rename);
  const selectVault = useWallet((s) => s.selectVault);

  const [refresh, setRefresh] = useState(0);
  // Owner headers only on request (the ⋯ menu); remembered on this phone.
  const [showOwners, setShowOwners] = useState(() => getPref(SHOW_OWNERS) === '1');
  const toggleOwners = (on: boolean) => {
    setShowOwners(on);
    setPref(SHOW_OWNERS, on ? '1' : '0');
  };
  // Vaults transferred away: hidden unless asked for (the ⋯ menu); remembered on this phone.
  const [showTransferred, setShowTransferred] = useState(() => getPref(SHOW_TRANSFERRED) === '1');
  const toggleTransferred = (on: boolean) => {
    setShowTransferred(on);
    setPref(SHOW_TRANSFERRED, on ? '1' : '0');
  };
  // Safe vaults, and adding one: hidden unless asked for (the ⋯ menu). Until it has been set, on for
  // a phone that already lists a Safe vault, so none it has goes missing.
  // Never while Safe vaults are switched off app-wide (see SAFE_ENABLED).
  const [showSafe, setShowSafe] = useState(() => {
    if (!SAFE_ENABLED) return false;
    const p = getPref(SHOW_SAFE);
    return p == null ? vaults.some((v) => v.safe) : p === '1';
  });
  const toggleSafe = (on: boolean) => {
    setShowSafe(on);
    setPref(SHOW_SAFE, on ? '1' : '0');
  };
  const [menuOpen, setMenuOpen] = useState(false);
  useLayoutEffect(() => {
    nav.setOptions({headerRight: () => <VaultsMenuButton onPress={() => setMenuOpen(true)} />});
  }, [nav]);
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
      .filter((v) => v.safe && showSafe)
      .map((v) => ({key: v.safe!.toLowerCase(), address: v.safe!, keyIndex: v.signerIndex ?? 0, safe: true}));
    return [...keys, ...safes.filter((s) => !keys.some((k) => k.key === s.key))].sort((a, b) =>
      a.safe === b.safe ? a.keyIndex - b.keyIndex : a.safe ? 1 : -1,
    );
  }, [vaults, showSafe]);
  const label = (n: number) => t('mobile.app.vault_n', {n});
  const {notYours, transferredTo} = useVaultDirectory(network, vaults, refresh);

  /**
   * What the server says each of this phone's keys holds on this chain, asked when the page opens,
   * when the chain or the keys change, and on a pull. A vault one of them holds is listed under it
   * unless that key's own entry for it already is — a vault the phone still lists under the key
   * that GAVE it away (greyed, no longer yours) must not hide it from the key that has it now.
   */
  const [held, setHeld] = useState<Record<string, {owned: Address[]; pending: Address[]}>>({});
  const keySig = owners.filter((o) => !o.safe && o.address).map((o) => o.key).join(',');
  useEffect(() => {
    let live = true;
    const keys = owners.filter((o) => !o.safe && o.address);
    Promise.all(keys.map((o) => fetchOwnedVaults(network, o.address as Address))).then((rs) => {
      if (live) setHeld(Object.fromEntries(keys.map((o, i) => [o.key, rs[i]])));
    });
    return () => {
      live = false;
    };
    // `keySig` stands for the keys: the same keys are the same question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, keySig, refresh]);

  /**
   * Every vault, grouped by the owner that holds it: those on this phone, then those the server says
   * it holds that are not on the phone yet (listed the same way — a transfer needs nothing from the
   * receiver), and any handover still waiting for that owner to accept. An owner with none is left out.
   */
  const groups = owners
    .map((o) => {
      // A vault transferred away is listed only with "Show transferred vaults" on.
      const listed = vaults.filter((v) => ownerOf(v) === o.key && (showTransferred || !notYours.has(v.index)));
      const here = new Set(listed.map((v) => vaultAddressOf(v, network)?.toLowerCase()).filter(Boolean) as string[]);
      const key = {index: o.keyIndex, address: (o.address ?? '0x') as Address};
      const h = held[o.key];
      const received: FoundVault[] = (h?.owned ?? []).filter((v) => !here.has(v.toLowerCase())).map((vault) => ({vault, key, pending: false}));
      const waiting: FoundVault[] = (h?.pending ?? []).filter((v) => !here.has(v.toLowerCase())).map((vault) => ({vault, key, pending: true}));
      return {owner: o, listed, received, waiting};
    })
    .filter((g) => g.listed.length + g.received.length + g.waiting.length > 0);
  // The name a vault not on the phone yet will have once it is: the next free indexes, in order.
  const nextIndex = Math.max(...vaults.map((v) => v.index)) + 1;
  let pendingName = 0;

  /** An address shortened to its first and last six: 0x111111…000000. */
  const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
  /**
   * Who a received vault came from, where this phone can tell: one of its own keys whose own vault
   * (the one the factory derives from it) this is. A vault from anyone else stays just "Received" —
   * the vault does not record its previous owner.
   */
  const fromOf = (vault: string): string | null =>
    owners.find((o) => !o.safe && o.address && ownerVaultAddress(o.address as Address, network).toLowerCase() === vault.toLowerCase())
      ?.address ?? null;

  const copyAddress = (address: string | null) => {
    if (!address) return;
    Clipboard.setString(asShown(address));
    showToast('success', t('common.copied'), asShown(address), 1500);
  };
  const [busy, setBusy] = useState(false);
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
    // Transferred away: it cannot be opened.
    if (!v.owner || notYours.has(v.index)) return;
    if (v.vault && v.network && v.network !== network) setNetwork(v.network as Network);
    selectVault(v.index);
    nav.goBack();
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

  const row = (v: VaultRef, i: number, count: number) => {
    const on = v.index === activeIndex;
    const gone = notYours.has(v.index);
    const address = vaultAddressOf(v, network);
    // A received vault on another chain: its own address, the one it has there.
    const elsewhere = !!v.vault && v.network !== network;
    const from = v.vault && !elsewhere ? fromOf(v.vault) : null;
    const tag = v.safe ? t('mobile.vaults.tag_safe') : v.vault && !from ? t('mobile.vaults.tag_received') : null;
    return (
      <Pressable
        key={v.index}
        style={({pressed}) => [styles.vaultRow, i < count - 1 && styles.rowDivider, gone && styles.gone, pressed && styles.pressed]}
        onPress={() => choose(v)}
        // Long press copies the vault's address, as it does on every address in the app.
        onLongPress={() => address && copyAddress(address)}>
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
            {/* The one in front, at the end of its name's line — the address below gets the
                row's full width. */}
            {on ? <Text style={[styles.check, styles.checkEnd]}>✓</Text> : null}
          </View>
          {/* Full: vaults are told apart by their address, so none of it is cut. Where the row is
              too narrow for one line it wraps to a second at the same size — shrinking it to fit
              left an address too small to read and compare. */}
          <Text style={styles.addr} numberOfLines={2}>
            {elsewhere ? wrappableAddress(v.vault!) : address ? wrappableAddress(address) : t('mobile.settings.vault_unlock_first')}
          </Text>
          {from ? <Text style={styles.fromText}>{t('mobile.vaults.transferred_from', {address: shortAddr(from)})}</Text> : null}
          {/* Transferred away: to whom, in full, so it can be checked against the receiving key. */}
          {gone ? <Text style={styles.goneText}>{t('mobile.vaults.transferred_to', {address: transferredTo.get(v.index) ?? ''})}</Text> : null}
        </View>
      </Pressable>
    );
  };

  /**
   * One owner's rows — its vaults on the phone, those the server says it holds, any handover still
   * waiting — numbered from `start` of `total`, so the divider logic holds whether the rows stand in
   * their own group or run on in one list.
   */
  const groupRows = (g: (typeof groups)[number], start: number, total: number) => {
    const {listed, received, waiting} = g;
    const last = (k: number) => start + k >= total - 1;
    return [
      ...listed.map((v, i) => row(v, start + i, total)),
      ...received.map((f, i) => (
        <Pressable
          key={f.vault}
          style={({pressed}) => [styles.vaultRow, !last(listed.length + i) && styles.rowDivider, pressed && styles.pressed]}
          onPress={() => onAddFound(f)}
          onLongPress={() => copyAddress(f.vault)}>
          <View style={styles.vaultText}>
            <View style={styles.nameLine}>
              <Text style={styles.name} numberOfLines={1}>
                {label(nextIndex + pendingName++ + 1)}
              </Text>
              {fromOf(f.vault) ? null : <Text style={styles.tag}>{t('mobile.vaults.tag_received')}</Text>}
            </View>
            <Text style={styles.addr} numberOfLines={2}>
              {wrappableAddress(f.vault)}
            </Text>
            {fromOf(f.vault) ? (
              <Text style={styles.fromText}>{t('mobile.vaults.transferred_from', {address: shortAddr(fromOf(f.vault)!)})}</Text>
            ) : null}
          </View>
        </Pressable>
      )),
      // Handed to this owner and waiting for it to accept (older vaults): a signature.
      ...waiting.map((f, i) => (
        <View key={f.vault} style={[styles.vaultRow, !last(listed.length + received.length + i) && styles.rowDivider]}>
          <View style={styles.vaultText}>
            <Text style={styles.addr}>{f.vault}</Text>
            <Text style={styles.goneText}>{t('mobile.vaults.pending_note')}</Text>
          </View>
          <Pressable onPress={() => onAccept(f)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>{t('mobile.vaults.accept')}</Text>
          </Pressable>
        </View>
      )),
    ];
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
      {/* Every vault on one list, grouped by owner: switching is one tap from anywhere, and the
          header is the address of the key — or Safe — that holds them. Long press it to copy. */}
      {/* Every vault on one list: grouped under each owner's address when "Show owners" is on
          (the ⋯ in the header), otherwise one plain list. Long press a header to copy it. */}
      {showOwners ? (
        groups.map((g) => {
          const o = g.owner;
          return (
            <View key={o.key} style={styles.section}>
              <Pressable onLongPress={() => copyAddress(o.address)} hitSlop={4}>
                {/* A key whose address is not derived yet goes by its number until it is. */}
                <Text style={[styles.groupLabel, o.address && styles.ownerAddr]}>
                  {o.address ? t('mobile.vaults.owner_header', {address: shortAddr(o.address)}) : t('mobile.vaults.owner_n', {n: o.keyIndex + 1})}
                </Text>
              </Pressable>
              <View style={styles.group}>{groupRows(g, 0, g.listed.length + g.received.length + g.waiting.length)}</View>
            </View>
          );
        })
      ) : (
        <View style={styles.section}>
          <View style={styles.group}>
            {(() => {
              const total = groups.reduce((n, g) => n + g.listed.length + g.received.length + g.waiting.length, 0);
              let at = 0;
              return groups.map((g) => {
                const out = groupRows(g, at, total);
                at += g.listed.length + g.received.length + g.waiting.length;
                return <React.Fragment key={g.owner.key}>{out}</React.Fragment>;
              });
            })()}
          </View>
        </View>
      )}

      <SettingsGroup>
        <Pressable style={styles.row} onPress={onAdd} disabled={busy}>
          <Text style={styles.link}>{`＋ ${t('mobile.settings.add_vault')}`}</Text>
          {busy ? <ActivityIndicator color={c.subtext} /> : null}
        </Pressable>
      </SettingsGroup>
      {/* Its own group and its own page: a Safe vault is signed for by a key imported for it, which
          is a different thing to set up from the phrase's next vault. */}
      {showSafe ? (
        <SettingsGroup footer={t('mobile.safe.add_safe_footer')}>
          <Pressable style={styles.row} onPress={() => nav.navigate('AddSafeVault')} disabled={busy}>
            <Text style={styles.link}>{`＋ ${t('mobile.safe.add_safe_vault')}`}</Text>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        </SettingsGroup>
      ) : null}
      <Sheet visible={menuOpen} title={t('mobile.settings.choose_vault')} onClose={() => setMenuOpen(false)}>
        <View style={styles.menuCard}>
          <View style={[styles.menuRow, styles.rowDivider]}>
            <Text style={styles.menuLabel}>{t('mobile.vaults.show_owners')}</Text>
            <Switch value={showOwners} onValueChange={toggleOwners} />
          </View>
          {/* Vaults given away stay on the phone's list; they are shown only when asked for. */}
          <View style={[styles.menuRow, SAFE_ENABLED && styles.rowDivider]}>
            <Text style={styles.menuLabel}>{t('mobile.vaults.show_transferred')}</Text>
            <Switch value={showTransferred} onValueChange={toggleTransferred} />
          </View>
          {SAFE_ENABLED ? (
            <View style={styles.menuRow}>
              <Text style={styles.menuLabel}>{t('mobile.vaults.show_safe')}</Text>
              <Switch value={showSafe} onValueChange={toggleSafe} />
            </View>
          ) : null}
        </View>
      </Sheet>
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
    addr: {color: c.subtext, fontSize: 13, fontFamily: MONO, fontWeight: '700', lineHeight: 18},
    // Pushed to the end of the name's line.
    checkEnd: {marginLeft: 'auto'},
    // A group's header when it is an address: the address font, small enough to fit on one line.
    ownerAddr: {fontSize: 13, fontFamily: MONO, fontWeight: '400'},
    gone: {opacity: 0.45},
    goneText: {color: c.warning, fontSize: 12},
    // A pushed screen's header: sized to the bar's 44, as the Trade screen's ⋯ (see TradeMenu).
    moreBtn: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
    menuCard: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    menuRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56},
    menuLabel: {color: c.text, fontSize: 16, fontWeight: '600'},
    fromText: {color: c.subtext, fontSize: 12},
    pressed: {opacity: 0.6},
    checkHidden: {opacity: 0},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
  });

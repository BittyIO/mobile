import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Alert, InteractionManager, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {useIsFocused, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import Svg, {Path} from 'react-native-svg';
import type {Address} from 'viem';
import {IMPORTED_SECTION, nextAccountOf, nextNumberOf, phraseOf, useVaults, vaultLabel, type VaultRef} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';
import {ownerVaultAddress} from '@/vault/read';
import {NETWORKS, useNetwork} from '@/core/network-store';
import {NATIVE, type Network} from '@/core/chain';
import {useWallet} from '@/wallet/store';
import * as keyring from '@/wallet/keyring';
import {deviceKeys, fetchOneTimeKeyVaults, fetchOwnedVaults, recall, remember, useVaultDirectory, type FoundVault} from '@/vault/owned-vaults';
import {acceptOwnership} from '@/vault/ownership';
import {CopyButton} from '@/components/CopyButton';
import {fetchSafe} from '@/vault/safe';
import {relayGasFor} from '@/vault/fee-quote';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useConfirmAction} from '@/components/ConfirmAction';
import {showTx} from '@/components/Toast';
import {Sheet} from '@/components/Sheet';
import {MoreIcon} from '@/components/TradeMenu';
import {getPref, setPref} from '@/core/prefs';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {asShown} from '@/core/format';
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
/** The section for vaults signed for by a private key imported on its own, outside every phrase. */
const IMPORTED = IMPORTED_SECTION;
/** The section multisig (Safe) vaults are listed in, after Imported private keys, whoever signs for them. */
const MULTISIG = 'multisig';
const SHOW_TRANSFERRED = 'vaults.showTransferred';

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
  const {t, language} = useT();
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
  // The recovery phrases on this phone, in their order; vaults are listed under each when there is more than one.
  // Read again on coming back to the page as well: a phrase deleted (or added) with no vaults of its
  // own changes no vault, and its section would otherwise stay, empty, until something else did.
  const focused = useIsFocused();
  /**
   * Each multisig's "signatures needed / owners", read from the Safe on this chain (its chain of
   * record when not deployed here), so the row says 2/3 beside its tag. Read again on coming back:
   * an owner or threshold change made on the multisig page shows at once.
   */
  const [quorum, setQuorum] = useState<Record<string, string>>({});
  const safeKey = vaults.filter((v) => v.safe).map((v) => `${v.safe}:${v.network ?? ''}`).join(',');
  useEffect(() => {
    if (!focused) return;
    let live = true;
    for (const v of vaults) {
      if (!v.safe) continue;
      const safe = v.safe;
      const tries = [network, ...(v.network && v.network !== network ? [v.network as Network] : [])];
      (async () => {
        for (const n of tries) {
          try {
            const info = await fetchSafe(n, safe);
            if (live && info.owners.length) setQuorum((q) => ({...q, [safe.toLowerCase()]: `${info.threshold}/${info.owners.length}`}));
            return;
          } catch {}
        }
      })();
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeKey, network, focused]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const phrases = useMemo(() => keyring.listPhrases(), [vaults, focused]);
  const phraseRank = (id: string) => {
    const i = phrases.findIndex((p) => p.id === id);
    return i < 0 ? phrases.length : i;
  };
  // Every owner this phone can act as: its keys, then the Safes it has added.
  const owners = useMemo(() => {
    const keys: {key: string; address: string | null; keyIndex: number; safe: boolean; phrase: string}[] = deviceKeys(vaults).map((k) => ({
      key: k.address.toLowerCase(),
      address: k.address,
      keyIndex: k.index,
      safe: false,
      phrase: k.phrase,
    }));
    for (const v of vaults)
      if (!v.safe && !v.vault && !v.owner) keys.push({key: `index:${v.index}`, address: null, keyIndex: v.account ?? v.index, safe: false, phrase: phraseOf(v)});
    const safes = vaults
      .filter((v) => v.safe)
      .map((v) => ({key: v.safe!.toLowerCase(), address: v.safe!, keyIndex: v.signerIndex ?? 0, safe: true, phrase: MULTISIG}));
    return [...keys, ...safes.filter((s) => !keys.some((k) => k.key === s.key))].sort((a, b) =>
      a.phrase !== b.phrase ? phraseRank(a.phrase) - phraseRank(b.phrase) : a.safe === b.safe ? a.keyIndex - b.keyIndex : a.safe ? 1 : -1,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaults, phrases]);
  const label = (n: number) => t('mobile.app.vault_n', {n});
  const {notYours, transferredTo, ownerNow} = useVaultDirectory(network, vaults, refresh);

  /**
   * What the server says each of this phone's keys holds on this chain, asked when the page opens,
   * when the chain or the keys change, and on a pull. A vault one of them holds is listed under it
   * unless that key's own entry for it already is — a vault the phone still lists under the key
   * that GAVE it away (greyed, no longer yours) must not hide it from the key that has it now.
   */
  type Held = Record<string, Awaited<ReturnType<typeof fetchOwnedVaults>>>;
  // From the last answer for this chain, so a vault already received is in its owner's section at once.
  const [held, setHeld] = useState<Held>(() => recall<Held>('held', network) ?? {});
  const keySig = owners.filter((o) => !o.safe && o.address).map((o) => o.key).join(',');
  useEffect(() => {
    let live = true;
    const keys = owners.filter((o) => !o.safe && o.address);
    setHeld((h) => recall<Held>('held', network) ?? h);
    Promise.all(keys.map((o) => fetchOwnedVaults(network, o.address as Address))).then((rs) => {
      if (!live) return;
      const next = Object.fromEntries(keys.map((o, i) => [o.key, rs[i]]));
      setHeld(next);
      remember('held', network, next);
    });
    return () => {
      live = false;
    };
    // `keySig` stands for the keys: the same keys are the same question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, keySig, refresh]);

  /**
   * The vaults of each phrase key's one-time keys (quantum-safe keys) on this chain, which the
   * server cannot know of: above all one not created yet that a bridge has paid into, since a bridge
   * out of a quantum-safe vault pays the vault of the one-time key that owns it now. Found from the
   * phone's own keys and the chain (vault/owned-vaults `fetchOneTimeKeyVaults`).
   */
  // Only what a bridge pays out: the stablecoins and the wrapped native coin (see fetchOneTimeKeyVaults).
  const catalog = useAssetCatalog(network);
  const wrapped = NATIVE[network]?.wrapped?.toUpperCase();
  const bridgeTokens = catalog.filter((a) => a.kind === 'stable' || a.symbol.toUpperCase() === wrapped).map((a) => a.address as Address);
  const tokenSig = bridgeTokens.join(',');
  const [oneTime, setOneTime] = useState<Record<string, {vault: Address; key: Address}[]>>({});
  /** The refresh last scanned for: a pull to refresh reads the chain again rather than the cache. */
  const scannedRefresh = useRef(refresh);
  useEffect(() => {
    let live = true;
    const force = scannedRefresh.current !== refresh;
    scannedRefresh.current = refresh;
    const keys = owners.filter((o) => !o.safe && o.address && o.phrase !== IMPORTED_SECTION);
    // After the page has come up, so the scan never competes with the transition into it.
    const task = InteractionManager.runAfterInteractions(() => {
      Promise.all(keys.map((o) => fetchOneTimeKeyVaults(network, o.keyIndex, o.phrase, bridgeTokens, force))).then((rs) => {
        if (live) setOneTime(Object.fromEntries(keys.map((o, i) => [o.key, rs[i]])));
      });
    });
    return () => {
      live = false;
      task.cancel();
    };
    // `keySig` and `tokenSig` stand for the keys and the coins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, keySig, tokenSig, refresh]);
  // Every vault already on the phone for this chain, whoever it is listed under: a one-time key's
  // vault, once added, is its own owner's row and must not be offered again under the account.
  const onPhone = new Set(vaults.map((v) => vaultAddressOf(v, network)?.toLowerCase()).filter(Boolean) as string[]);

  /**
   * Every vault, grouped by the owner that holds it: those on this phone, then those the server says
   * it holds that are not on the phone yet (listed the same way — a transfer needs nothing from the
   * receiver), and any handover still waiting for that owner to accept. An owner with none is left out.
   */
  const grouped = owners
    .map((o) => {
      // A vault transferred away is listed only with "Show transferred vaults" on.
      const listed = vaults.filter((v) => ownerOf(v) === o.key && (showTransferred || !notYours.has(v.index)));
      const here = new Set(listed.map((v) => vaultAddressOf(v, network)?.toLowerCase()).filter(Boolean) as string[]);
      const key = {index: o.keyIndex, address: (o.address ?? '0x') as Address, phrase: o.phrase};
      const h = held[o.key];
      const received: FoundVault[] = (h?.owned ?? []).filter((v) => !here.has(v.toLowerCase())).map((vault) => ({vault, key, pending: false}));
      // Owned by (or waiting to be created for) one of this account's one-time keys: that key signs.
      for (const f of oneTime[o.key] ?? []) {
        const at = f.vault.toLowerCase();
        if (onPhone.has(at) || received.some((r) => r.vault.toLowerCase() === at)) continue;
        received.push({vault: f.vault, key: {...key, address: f.key}, pending: false});
      }
      const waiting: FoundVault[] = (h?.pending ?? []).filter((v) => !here.has(v.toLowerCase())).map((vault) => ({vault, key, pending: true}));
      // Transferred to this owner and still in the vault's timelock: listed now, with when it arrives.
      const incoming: FoundVault[] = (h?.queued ?? [])
        .filter((q) => !here.has(q.vault.toLowerCase()))
        .map((q) => ({vault: q.vault, key, pending: true, readyAt: q.readyAt}));
      return {owner: o, listed, received, waiting, incoming};
    });
  /**
   * Transferred to another owner on this phone, the vault is that owner's now, and only there: it is
   * listed in the new owner's section (received, or its own entry once added) and taken out of the old
   * one's, "Show transferred vaults" or not. Listing it in both put the same address on the page twice,
   * once under a key that can no longer open it.
   *
   * Decided by who owns it on the chain now, not by `notYours`: a vault handed to one of the old key's
   * own one-time keys still counts as the old account's there, yet when that key has a section of its
   * own on this page the vault is listed in it, and must not stay under the old one as well. A vault
   * given to a key that has no section here stays where it was, as before. Per chain: a transfer moves
   * the vault on this chain only.
   */
  const shownUnder = new Map<string, Set<string>>();
  const showUnder = (vault: string, owner: string) => {
    const at = vault.toLowerCase();
    shownUnder.set(at, (shownUnder.get(at) ?? new Set()).add(owner));
  };
  for (const g of grouped) {
    for (const v of g.listed) {
      const a = vaultAddressOf(v, network);
      if (a) showUnder(a, g.owner.key);
    }
    for (const f of [...g.received, ...g.incoming]) showUnder(f.vault, g.owner.key);
  }
  const movedHere = (v: VaultRef, owner: string) => {
    const now = ownerNow.get(v.index)?.toLowerCase();
    if (!now || now === owner) return false;
    return !!shownUnder.get(vaultAddressOf(v, network)?.toLowerCase() ?? '')?.has(now);
  };
  const groups = grouped
    .map((g) => ({...g, listed: g.listed.filter((v) => !movedHere(v, g.owner.key))}))
    .filter((g) => g.listed.length + g.received.length + g.waiting.length + g.incoming.length > 0);
  /**
   * The name a vault already has on this phone, by its address on this chain: a vault moved to another
   * of the phone's owners keeps the name it was given under the old one.
   */
  /** The address of the vault in front, on this chain. */
  const activeAt = (() => {
    const v = vaults.find((x) => x.index === activeIndex);
    return v ? vaultAddressOf(v, network)?.toLowerCase() ?? null : null;
  })();
  const nameAt = (vault: string): string => {
    const at = vault.toLowerCase();
    return vaults.find((v) => v.name && vaultAddressOf(v, network)?.toLowerCase() === at)?.name ?? '';
  };
  // The name a vault not on the phone yet will have once it is: its phrase's next numbers, in order.
  const promised: Record<string, number> = {};
  const pendingLabel = (section: string) => {
    promised[section] = (promised[section] ?? -1) + 1;
    return label(nextNumberOf(vaults, section, promised[section]));
  };

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
    // Never onto a network this build does not offer (Tron, in a store release).
    if (v.vault && v.network && v.network !== network && NETWORKS.includes(v.network as Network)) setNetwork(v.network as Network);
    selectVault(v.index);
    nav.goBack();
  };

  /**
   * Add the next vault: the phrase's next account. One prompt derives every owner up to it, so a
   * device that only ever unlocked the first fills in the addresses it never had. The vault is
   * counterfactual until its first action, like every new one.
   *
   * Each phrase counts its own accounts: the next one past the highest its vaults use, so a phrase's
   * vaults are Vault 1, 2, 3… whatever else the phone holds.
   */
  const onAdd = async (phrase: string = keyring.MAIN_PHRASE) => {
    setBusy(true);
    try {
      const {setOwner, add} = useVaults.getState();
      const account = nextAccountOf(vaults, phrase);
      // Every account of the phrase still without an address is filled in by the same prompt.
      const missing = vaults.filter((v) => !v.owner && !v.safe && !v.vault && phraseOf(v) === phrase);
      const upTo = Math.max(account, ...missing.map((v) => v.account ?? v.index)) + 1;
      const addrs = await keyring.addressesUpTo(upTo, phrase);
      if (!addrs) return;
      missing.forEach((v) => addrs[v.account ?? v.index] && setOwner(v.index, addrs[v.account ?? v.index]));
      selectVault(add(addrs[account], {phrase, account}));
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
          const account = f.key.phrase === IMPORTED ? await keyring.unlockImported(f.key.address) : await keyring.unlock(f.key.index, f.key.phrase);
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
    const index = useVaults.getState().addReceived(f.vault, network, f.key.index, f.key.address, f.key.phrase);
    // The name it had under its old owner goes with it.
    const name = nameAt(f.vault);
    if (name && !useVaults.getState().vaults.find((v) => v.index === index)?.name) rename(index, name);
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
        onPress={() => choose(v)}>
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
            {v.safe && quorum[v.safe.toLowerCase()] ? <Text style={styles.tag}>{quorum[v.safe.toLowerCase()]}</Text> : null}
            {/* The row's top right corner, at the end of the name's line so the address below gets
                the row's full width: the check on the one in front, which needs no copy button (the
                overview's own copies it); on every other vault its address's copy button. The row's
                own tap chooses the vault. */}
            <View style={styles.nameEnd}>
              {on ? (
                <Text style={styles.check}>✓</Text>
              ) : elsewhere ? (
                <CopyButton address={v.vault!} />
              ) : address ? (
                <CopyButton address={address} />
              ) : null}
            </View>
          </View>
          {/* Full: vaults are told apart by their address, so none of it is cut. One line where it
              fits; where it does not (the accessibility text sizes) it fills the first line and
              runs on to the next, at the same size. Never shrunk to fit: iOS shrank some rows'
              addresses far smaller than others' of the same length. */}
          <Text style={styles.addr}>
            {elsewhere ? asShown(v.vault!) : address ? asShown(address) : t('mobile.settings.vault_unlock_first')}
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
    const {listed, received, waiting, incoming} = g;
    const last = (k: number) => start + k >= total - 1;
    return [
      ...listed.map((v, i) => row(v, start + i, total)),
      ...received.map((f, i) => (
        <Pressable
          key={f.vault}
          style={({pressed}) => [styles.vaultRow, !last(listed.length + i) && styles.rowDivider, pressed && styles.pressed]}
          onPress={() => onAddFound(f)}>
          <View style={styles.vaultText}>
            <View style={styles.nameLine}>
              <Text style={styles.name} numberOfLines={1}>
                {nameAt(f.vault) || pendingLabel(g.owner.phrase)}
              </Text>
              {fromOf(f.vault) ? null : <Text style={styles.tag}>{t('mobile.vaults.tag_received')}</Text>}
              {/* The vault in front, moved here from its old owner's section: the check goes with it. */}
              <View style={styles.nameEnd}>
                {activeAt === f.vault.toLowerCase() ? <Text style={styles.check}>✓</Text> : <CopyButton address={f.vault} />}
              </View>
            </View>
            <Text style={styles.addr}>
              {asShown(f.vault)}
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
            <View style={styles.addrLine}>
              <Text style={[styles.addr, styles.addrText]}>{f.vault}</Text>
              <CopyButton address={f.vault} />
            </View>
            <Text style={styles.goneText}>{t('mobile.vaults.pending_note')}</Text>
          </View>
          <Pressable onPress={() => onAccept(f)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>{t('mobile.vaults.accept')}</Text>
          </Pressable>
        </View>
      )),
      // Transferred to this owner, still in the vault's timelock: nothing to do but wait, so no
      // button — the vault becomes this key's by itself, and is then listed like any received one.
      ...incoming.map((f, i) => (
        <Pressable
          key={f.vault}
          style={[styles.vaultRow, !last(listed.length + received.length + waiting.length + i) && styles.rowDivider]}>
          <View style={styles.vaultText}>
            <View style={styles.nameLine}>
              <Text style={styles.name} numberOfLines={1}>
                {pendingLabel(g.owner.phrase)}
              </Text>
              <Text style={styles.tag}>{t('mobile.vaults.tag_received')}</Text>
              <View style={styles.nameEnd}>
                <CopyButton address={f.vault} />
              </View>
            </View>
            <Text style={styles.addr}>
              {asShown(f.vault)}
            </Text>
            <Text style={styles.goneText}>
              {t('mobile.vaults.arriving', {date: new Date((f.readyAt ?? 0) * 1000).toLocaleString(language, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})})}
            </Text>
          </View>
        </Pressable>
      )),
    ];
  };

  const groupSize = (g: (typeof groups)[number]) => g.listed.length + g.received.length + g.waiting.length + g.incoming.length;

  /**
   * Some owners' groups: under each owner's address with "Show owners" on, otherwise as one plain
   * list. With `addTo`, that phrase's "＋ Add vault" ends the list.
   */
  const renderGroups = (gs: typeof groups, addTo: string | null) => {
    // Run on under the vaults it divides from them; on its own card (with owners shown) it needs no divider.
    const add = addTo ? (
      <Pressable key="add" style={[styles.row, gs.length > 0 && !showOwners && styles.addTop]} onPress={() => onAdd(addTo)} disabled={busy}>
        <Text style={styles.link}>{`＋ ${t('mobile.settings.add_vault')}`}</Text>
        {busy ? <ActivityIndicator color={c.subtext} /> : null}
      </Pressable>
    ) : null;
    if (showOwners) {
      // Spaced like the page's own groups: the Add card sat flush under the last owner's vaults.
      return (
        <View style={styles.ownersStack}>
          {gs.map((g) => {
            const o = g.owner;
            return (
              <View key={o.key} style={styles.section}>
                {/* The owner, and after it the copy button for its full address. A key whose address
                    is not derived yet goes by its number until it is, with nothing to copy. */}
                <View style={styles.groupLabelLine}>
                  <Text style={[styles.groupLabel, styles.groupLabelInline, o.address && styles.ownerAddr]}>
                    {o.address ? t('mobile.vaults.owner_header', {address: shortAddr(o.address)}) : t('mobile.vaults.owner_n', {n: o.keyIndex + 1})}
                  </Text>
                  {o.address ? <CopyButton address={o.address} size={13} /> : null}
                </View>
                <View style={styles.group}>{groupRows(g, 0, groupSize(g))}</View>
              </View>
            );
          })}
          {add ? <View style={styles.group}>{add}</View> : null}
        </View>
      );
    }
    const total = gs.reduce((n, g) => n + groupSize(g), 0);
    let at = 0;
    return (
      <View style={styles.group}>
        {gs.map((g) => {
          const out = groupRows(g, at, total);
          at += groupSize(g);
          return <React.Fragment key={g.owner.key}>{out}</React.Fragment>;
        })}
        {add}
      </View>
    );
  };

  // One section per recovery phrase (its name, its vaults), and one for Safes signed by imported keys.
  const phraseName = (n: number) => t('mobile.phrases.phrase_n', {n});
  const sections = [
    ...phrases.map((p) => ({id: p.id, label: keyring.phraseLabel(p, phraseName), groups: groups.filter((g) => g.owner.phrase === p.id)})),
    ...(groups.some((g) => g.owner.phrase === IMPORTED)
      ? [{id: IMPORTED, label: t('mobile.phrases.imported_keys'), groups: groups.filter((g) => g.owner.phrase === IMPORTED)}]
      : []),
  ];
  // Last: every multisig vault, under the multisig's address, whichever key signs for it.
  const multisig = groups.filter((g) => g.owner.phrase === MULTISIG);

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
      {/* Every vault on one list: grouped under each owner's address when "Show owners" is on
          (the ⋯ in the header), otherwise one plain list. Long press a header to copy it. With more
          than one recovery phrase, each phrase's vaults are listed under its name, with its own Add. */}
      {sections.length > 1 ? (
        sections.map((sec) => (
          <View key={sec.id} style={styles.section}>
            {/* The header opens what it names: the phrase's page (reveal, rename, delete), or the
                list of imported keys (copy, delete). */}
            <Pressable
              hitSlop={4}
              style={({pressed}) => [styles.sectionHead, pressed && styles.pressed]}
              onPress={() => (sec.id === IMPORTED ? nav.navigate('RecoveryPhrases') : nav.navigate('VaultRecoveryPhrase', {phrase: sec.id}))}
              accessibilityRole="button">
              <Text style={[styles.groupLabel, styles.sectionLabel]}>{sec.label}</Text>
              <Text style={styles.sectionChev}>›</Text>
            </Pressable>
            {renderGroups(sec.groups, sec.id === IMPORTED ? null : sec.id)}
          </View>
        ))
      ) : (
        <>
          {/* Multisig vaults are not the phrase's: they have their own section below. */}
          {renderGroups(groups.filter((g) => g.owner.phrase !== MULTISIG), null)}
          <SettingsGroup>
            <Pressable style={styles.row} onPress={() => onAdd(sections[0]?.id ?? keyring.MAIN_PHRASE)} disabled={busy}>
              <Text style={styles.link}>{`＋ ${t('mobile.settings.add_vault')}`}</Text>
              {busy ? <ActivityIndicator color={c.subtext} /> : null}
            </Pressable>
          </SettingsGroup>
        </>
      )}
      {multisig.length > 0 ? (
        <View style={styles.section}>
          {/* Opens the multisig page: choosing one, approvals, taking one off the phone. */}
          <Pressable
            hitSlop={4}
            style={({pressed}) => [styles.sectionHead, pressed && styles.pressed]}
            onPress={() => nav.navigate('SafeVaults')}
            accessibilityRole="button">
            <Text style={[styles.groupLabel, styles.sectionLabel]}>{t('mobile.safemode.section')}</Text>
            <Text style={styles.sectionChev}>›</Text>
          </Pressable>
          {renderGroups(multisig, null)}
        </View>
      ) : null}
      {/* A key imported on its own lists its vault under Imported private keys, a multisig its vault
          under Multisig vaults. Creating, importing, naming and deleting recovery phrases has its own page. */}
      <SettingsGroup>
        <Pressable style={[styles.row, styles.rowDivider]} onPress={() => nav.navigate('ImportPrivateKey')}>
          <Text style={styles.link}>{t('mobile.phrases.import_key')}</Text>
          <Text style={styles.chev}>›</Text>
        </Pressable>
        <Pressable style={[styles.row, styles.rowDivider]} onPress={() => nav.navigate('AddSafeVault')}>
          <Text style={styles.link}>{t('mobile.safemode.import')}</Text>
          <Text style={styles.chev}>›</Text>
        </Pressable>
        <Pressable style={styles.row} onPress={() => nav.navigate('RecoveryPhrases')}>
          <Text style={styles.link}>{t('mobile.phrases.manage')}</Text>
          <Text style={styles.chev}>›</Text>
        </Pressable>
      </SettingsGroup>
      <Sheet visible={menuOpen} title={t('mobile.settings.choose_vault')} onClose={() => setMenuOpen(false)}>
        <View style={styles.menuCard}>
          <View style={[styles.menuRow, styles.rowDivider]}>
            <Text style={styles.menuLabel}>{t('mobile.vaults.show_owners')}</Text>
            <Switch value={showOwners} onValueChange={toggleOwners} />
          </View>
          {/* Vaults given away stay on the phone's list; they are shown only when asked for. */}
          <View style={[styles.menuRow, styles.rowDivider]}>
            <Text style={styles.menuLabel}>{t('mobile.vaults.show_transferred')}</Text>
            <Switch value={showTransferred} onValueChange={toggleTransferred} />
          </View>
          {/* Last: the Safe vaults' own page — adding one (the owner's key, the Safe's address),
              choosing one, taking one off the phone. */}
          <Pressable
            style={({pressed}) => [styles.menuRow, pressed && styles.pressed]}
            onPress={() => {
              setMenuOpen(false);
              nav.navigate('SafeVaults');
            }}
            accessibilityRole="button">
            <Text style={styles.menuLabel}>{t('mobile.safemode.menu')}</Text>
            <Text style={styles.chev}>›</Text>
          </Pressable>
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
    // A row with no name line (a handover to accept): the address, its copy button at the top right.
    addrLine: {flexDirection: 'row', alignItems: 'flex-start', gap: 6},
    addrText: {flexShrink: 1},
    addr: {color: c.subtext, fontSize: 13, fontFamily: MONO, fontWeight: '700', lineHeight: 18},
    // Pushed to the end of the name's line.
    // The name line's right end, top right: the check on the vault in front, else the copy button.
    nameEnd: {marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 12},
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
    ownersStack: {gap: 16},
    sectionHead: {flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 6, paddingRight: 16},
    sectionLabel: {flexShrink: 1, marginTop: 0, marginBottom: 0},
    sectionChev: {color: c.subtext, fontSize: 18, fontWeight: '300', marginLeft: 4},
    addTop: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  });

import React, {useLayoutEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {useNetwork} from '@/core/network-store';
import {nextAccountOf, phraseOf, useVaults, type VaultRef} from '@/core/vault-store';
import {useAccountModes, useActiveAccount, useHiddenWallets, walletAddressOf, walletNumber} from '@/core/account-mode';
import {followActiveVault} from '@/core/active-vault';
import {asShown} from '@/core/format';
import * as keyring from '@/wallet/keyring';
import {useWallet} from '@/wallet/store';
import {CopyButton} from '@/components/CopyButton';
import {SwipeRow} from '@/components/SwipeRow';
import {Sheet} from '@/components/Sheet';
import {MoreIcon} from '@/components/TradeMenu';
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {MONO, useColors, useStyles, type Colors} from '@/theme';

export type WalletRow = {address: Address; number: number; entry: VaultRef};

/**
 * Every wallet the phone's list holds, one per KEY: a key's own vault and a vault it received are
 * two entries but one wallet. Safe vaults have none; entries removed from Choose vault are left out.
 * `which` picks the side of ⋯ › Hidden wallets to list.
 */
export function walletRows(vaults: VaultRef[], hidden: string[], which: 'shown' | 'hidden'): WalletRow[] {
  const byKey = new Map<string, WalletRow>();
  for (const v of vaults) {
    if (v.hidden) continue;
    const address = walletAddressOf(v, vaults);
    if (!address) continue;
    const key = address.toLowerCase();
    if (hidden.includes(key) !== (which === 'hidden')) continue;
    const seen = byKey.get(key);
    // The key's own vault's entry over a received one: it is the entry the key was created as.
    if (!seen || (seen.entry.vault && !v.vault)) byKey.set(key, {address, number: walletNumber(v, vaults), entry: v});
  }
  return [...byKey.values()].sort((a, b) => a.number - b.number);
}

/** The header's ⋯, as on Choose vault: module scope so the header keeps one element type. */
function WalletsMenuButton({onPress}: {onPress: () => void}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={onPress} style={styles.moreBtn} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('mobile.trade.more')}>
      <MoreIcon color={c.text} />
    </Pressable>
  );
}

/**
 * Choose wallet: the header's page in wallet mode, laid out as Choose vault is — one card of
 * wallets, each with its address and a copy button (the one in front a check), swiped left to
 * remove; ＋ Add wallet on a card of its own; ⋯ at the top right for Hidden wallets.
 *
 * Choosing one puts its entry in front and keeps the page in wallet mode — the choice is per wallet
 * (core/account-mode), and on an EVM chain a wallet never shown before would otherwise open on its
 * vault. Removing one only takes it off this list (core/account-mode `useHiddenWallets`); its vault
 * stays on Choose vault.
 */
export function WalletListScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const vaults = useVaults((s) => s.vaults);
  const hidden = useHiddenWallets((s) => s.hidden);
  const current = useActiveAccount(network).wallet;
  const [busy, setBusy] = useState(false);
  const [swipeOpen, setSwipeOpen] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const rows = useMemo(() => walletRows(vaults, hidden, 'shown'), [vaults, hidden]);
  const anyHidden = useMemo(() => walletRows(vaults, hidden, 'hidden').length > 0, [vaults, hidden]);

  useLayoutEffect(() => {
    nav.setOptions({headerRight: () => <WalletsMenuButton onPress={() => setMenuOpen(true)} />});
  }, [nav]);

  const choose = (r: WalletRow) => {
    useAccountModes.getState().set(network, r.address, 'wallet');
    useWallet.getState().selectVault(r.entry.index);
    // On this chain the entry in front is whichever holds the vault here (a received one, say).
    followActiveVault(network);
    nav.goBack();
  };

  /**
   * A new wallet: the phrase's next account key. It is the same key a new vault would be created
   * from — one account, its wallet and its vault — so it is listed under Choose vault as well, and
   * restored with the phrase like every other. One Face ID prompt derives it (and fills in any
   * account of the phrase still without an address), as adding a vault does.
   */
  const onAdd = async (phrase: string = keyring.MAIN_PHRASE) => {
    setBusy(true);
    try {
      const {setOwner, add} = useVaults.getState();
      const account = nextAccountOf(vaults, phrase);
      const missing = vaults.filter((v) => !v.owner && !v.safe && !v.vault && phraseOf(v) === phrase);
      const upTo = Math.max(account, ...missing.map((v) => v.account ?? v.index)) + 1;
      const addrs = await keyring.addressesUpTo(upTo, phrase);
      if (!addrs?.[account]) return;
      missing.forEach((v) => addrs[v.account ?? v.index] && setOwner(v.index, addrs[v.account ?? v.index]));
      const index = add(addrs[account], {phrase, account});
      useAccountModes.getState().set(network, addrs[account], 'wallet');
      useWallet.getState().selectVault(index);
      nav.goBack();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Remove, asked first: off this list only. The one in front hands over to the next wallet on the
   * list; with none left, the page goes back to the vault (a hidden wallet is not offered).
   */
  const remove = (r: WalletRow) => {
    const label = t('mobile.account.wallet_n', {n: r.number});
    Alert.alert(t('mobile.vaults.remove_title', {name: label}), t('mobile.account.remove_wallet_body'), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('mobile.vaults.remove'),
        style: 'destructive',
        onPress: () => {
          setSwipeOpen(null);
          const wasFront = !!current && current.toLowerCase() === r.address.toLowerCase();
          useHiddenWallets.getState().hide(r.address);
          if (!wasFront) return;
          const next = rows.find((x) => x.address !== r.address);
          if (next) {
            useAccountModes.getState().set(network, next.address, 'wallet');
            useWallet.getState().selectVault(next.entry.index);
            followActiveVault(network);
          }
        },
      },
    ]);
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      {rows.length ? (
        <View style={styles.group}>
          {rows.map((r, i) => {
            const on = !!current && current.toLowerCase() === r.address.toLowerCase();
            return (
              <SwipeRow
                key={r.address}
                open={swipeOpen === r.address}
                onOpen={() => setSwipeOpen(r.address)}
                onClose={() => setSwipeOpen((o) => (o === r.address ? null : o))}
                actionLabel={t('mobile.vaults.remove')}
                onAction={() => remove(r)}>
                <Pressable
                  style={({pressed}) => [styles.walletRow, i < rows.length - 1 && styles.rowDivider, pressed && styles.pressed]}
                  // A row slid open closes on a tap, rather than choosing the wallet under the finger.
                  onPress={() => (swipeOpen != null ? setSwipeOpen(null) : choose(r))}>
                  <View style={styles.walletText}>
                    <View style={styles.nameLine}>
                      <Text style={styles.name} numberOfLines={1}>
                        {t('mobile.account.wallet_n', {n: r.number})}
                      </Text>
                      <View style={styles.nameEnd}>{on ? <Text style={styles.check}>✓</Text> : <CopyButton address={asShown(r.address)} />}</View>
                    </View>
                    <Text style={styles.addr}>{asShown(r.address)}</Text>
                  </View>
                </Pressable>
              </SwipeRow>
            );
          })}
        </View>
      ) : null}
      <SettingsGroup>
        <Pressable style={styles.row} onPress={() => onAdd()} disabled={busy} accessibilityRole="button">
          <Text style={styles.link}>{`＋ ${t('mobile.account.add_wallet')}`}</Text>
          {busy ? <ActivityIndicator color={c.subtext} /> : null}
        </Pressable>
      </SettingsGroup>
      <Sheet visible={menuOpen} title={t('mobile.account.choose_wallet')} onClose={() => setMenuOpen(false)}>
        <View style={styles.menuCard}>
          <Pressable
            style={({pressed}) => [styles.menuRow, pressed && styles.pressed, !anyHidden && styles.menuOff]}
            disabled={!anyHidden}
            onPress={() => {
              setMenuOpen(false);
              nav.navigate('HiddenWallets');
            }}
            accessibilityRole="button">
            <Text style={styles.menuLabel}>{t('mobile.account.hidden_wallets')}</Text>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        </View>
      </Sheet>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 20, paddingBottom: 32},
    walletRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 56},
    walletText: {flex: 1, gap: 3},
    nameLine: {flexDirection: 'row', alignItems: 'center', gap: 6},
    name: {color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
    nameEnd: {marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 12},
    addr: {color: c.subtext, fontSize: 13, fontFamily: MONO, fontWeight: '700', lineHeight: 18},
    moreBtn: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
    menuCard: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    menuRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56},
    menuLabel: {color: c.text, fontSize: 16, fontWeight: '600'},
    menuOff: {opacity: 0.4},
    pressed: {opacity: 0.6},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
  });

import React, {useCallback, useEffect, useLayoutEffect, useMemo, useState} from 'react';
import Svg, {Path} from 'react-native-svg';
import {ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {useVaults} from '@/core/vault-store';
import {useNetwork} from '@/core/network-store';
import {useWallet} from '@/wallet/store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {fetchWhitelist, removeWhitelisted, type WhitelistedRecipient} from '@/vault/payments';
import {WHITELIST_STATUS} from '@/core/abi';
import {getRiskConfig, type RiskConfig} from '@/vault/risk';
import {fmtAllowance} from '@/components/riskFormat';
import Clipboard from '@react-native-clipboard/clipboard';
import {showToast} from '@/components/Toast';
import {ProgressRing, leftUnit, waitDone} from '@/components/ProgressRing';
import {useVaultWrite} from '@/components/useVaultWrite';
import {usePending} from '@/vault/pending';
import {useRecipientNames, recipientName} from '@/core/recipient-names';
import {useRecipientPick} from '@/core/recipient-pick';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {vaultAddressOf} from '@/core/active-vault';

/**
 * Who to pay, as its own page, in two groups: the whitelisted address book, each entry under its
 * name; and the owner's other vaults. "New recipient" is the + in the header ({NewRecipientScreen}).
 * The book is also pruned here (the ✕ on each entry, through the Face-ID and fee confirm).
 *
 * Hands its answer back through {useRecipientPick} and then calls `goBack`. A route param would
 * have to be delivered by `navigate`, which is as willing to push a second Send page as it is to
 * return to the first; `goBack` can only unwind, which is the behaviour this page wants.
 */
/**
 * Security › Whitelisted addresses: the same book, to manage rather than to pay from. A tap does not
 * choose (long press still copies), your own vaults are not listed, and + adds to the book.
 */
export function WhitelistScreen() {
  return <SelectRecipientScreen manage />;
}

export function SelectRecipientScreen({manage = false}: {manage?: boolean}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = useActiveVaultAddress(network);
  const vaults = useVaults((s) => s.vaults);
  const activeIndex = useVaults((s) => s.activeIndex);

  /**
   * The book as the vault reports it, each entry with its status. An entry whose removal is queued
   * is not taken off at once — it stays payable until then, and a lock voids the removal — so its
   * row says when instead of offering the ✕ again, which would only start the wait over. One still
   * waiting out its timelock says when it becomes payable, and one a lock voided says it never will.
   */
  const [book, setBook] = useState<WhitelistedRecipient[]>([]);
  /**
   * Loading until the chain answers.
   *
   * The empty state used to show while the read was still in flight, so every open of this page
   * began by saying the whitelist was empty and then contradicting itself. "Empty" is a claim
   * about what came back, and until something has, there is nothing to claim.
   */
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  // Read again whenever a relayed write lands: an add or a removal is only in the book once mined,
  // and the write's own callback fires when the relayer accepted it, before that.
  const settled = usePending((s) => s.txs.filter((x) => x.status !== 'pending').length);
  useEffect(() => {
    if (settled > 0) setReload((n) => n + 1);
  }, [settled]);
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  useEffect(() => {
    if (vault) getRiskConfig(vault, network).then(setRisk);
  }, [vault, network]);
  useEffect(() => {
    if (!vault) return;
    let live = true;
    setLoading(true);
    fetchWhitelist(vault, network)
      .then((rows) => {
        if (live) setBook(rows);
      })
      .catch(() => live && setBook([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [vault, network, reload]);

  // Removing an entry is a relayed write: confirmed first, so a mis-tap cannot spend anything.
  const {busy, ready, run, sheet} = useVaultWrite(useCallback(() => setReload((n) => n + 1), []));
  const removeEntry = (b: WhitelistedRecipient) =>
    run(
      `rm-${b.id}`,
      `${t('vault.remove')} · ${t('vault.address_book')}`,
      (base) => removeWhitelisted({...base, id: b.id}),
      b.recipientAddress,
    );

  /**
   * The owner's OTHER vaults on this chain.
   *
   * Moving between your own vaults is the one transfer nobody should have to copy an address
   * for, and the app already knows every one of them. The active vault is left out — a vault
   * cannot pay itself — and so is any entry whose owner has never been derived.
   */
  const mine = useMemo(
    () =>
      vaults
        .filter((v) => v.index !== activeIndex)
        .map((v) => ({
          index: v.index,
          name: v.name || t('mobile.app.vault_n', {n: v.index + 1}),
          // Received vaults exist on one chain only; elsewhere this is null and the row is left out.
          address: vaultAddressOf(v, network),
        }))
        .filter((v): v is typeof v & {address: `0x${string}`} => v.address !== null),
    [vaults, activeIndex, network, t],
  );

  const setPicked = useRecipientPick((st) => st.set);
  const names = useRecipientNames((st) => st.names);
  const setName = useRecipientNames((st) => st.setName);

  /**
   * Renaming an entry: the pencil after its name opens a dialog with the name in a field and the
   * address under the title, so the row never turns into a form. The name is this device's (see
   * core/recipient-names), a local edit with no signature and no fee; saving it empty falls back to
   * the entry's place in the book.
   */
  const rename = (address: string, current: string | undefined) =>
    Alert.prompt(
      t('mobile.payments.edit_name'),
      address,
      [
        {text: t('common.cancel'), style: 'cancel'},
        {text: t('vault.save'), onPress: (v?: string) => setName(network, address, v ?? '')},
      ],
      'plain-text',
      current ?? '',
    );

  const pick = (address: string, label?: string) => {
    // Send to new in 24 hours at $0: the vault pays only a whitelisted address whose wait is over.
    // Choosing any other would only fail at the payment, so say why here instead of choosing it.
    if (risk?.read && risk.sendDailyAllowance === 0n && !whitelisted(address)) {
      Alert.alert(t('mobile.payments.cant_pay_title'), t('mobile.payments.cant_pay_sends_off'));
      return;
    }
    setPicked({address: address as Address, label, addToBook: false});
    nav.goBack();
  };

  /** One book entry: its name, the full address, a status note where it has one, and the ✕. */
  // Long press any address to copy it.
  const copy = (a: string) => {
    Clipboard.setString(a);
    showToast('success', t('common.copied'), a, 1500);
  };

  // A clock for the pending rings, ticking while the page is up.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const entryRow = (b: WhitelistedRecipient, i: number, list: WhitelistedRecipient[]) => {
    const named = recipientName(names, network, b.recipientAddress);
    const removeAt = b.status === WHITELIST_STATUS.removalQueued ? b.removeAt : undefined;
    const waitUntil = removeAt ?? (b.status === WHITELIST_STATUS.pending ? b.effectiveAt : undefined);
    const note = b.status === WHITELIST_STATUS.voided ? t('mobile.payments.voided_by_lock') : null;
    return (
      <Pressable
        key={b.id}
        style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, i === list.length - 1 && styles.rowLast, pressed && styles.pressed]}
        // Managing the book, a tap chooses nothing.
        disabled={manage}
        onPress={() => pick(b.recipientAddress, named)}
        onLongPress={() => copy(b.recipientAddress)}>
        {/* Every entry under a name: the one saved on this device, or its place in the
            book where none was given. The full address below, since that is what gets paid. */}
        <View style={styles.entryCol}>
          <View style={styles.nameLine}>
            <Text style={[styles.entryName, !named && styles.entryNameOff]} numberOfLines={1}>
              {named ?? t('mobile.payments.recipient_n', {n: b.id})}
            </Text>
            {/* Its own target, like the ✕: a tap on the row chooses the recipient. */}
            <Pressable
              hitSlop={10}
              onPress={() => rename(b.recipientAddress, named)}
              accessibilityRole="button"
              accessibilityLabel={t('vault.edit')}
              style={({pressed}) => pressed && styles.pressed}>
              <Svg width={14} height={14} viewBox="0 0 24 24">
                <Path
                  d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
                  stroke={c.subtext}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </Svg>
            </Pressable>
            {/* Still waiting out the timelock, to be added or to be removed: how far it has run,
                and in one phrase what happens when. */}
            {waitUntil ? (
              <>
                <ProgressRing size={16} done={waitDone(waitUntil, now, Number(risk?.timelock ?? 0))} left={waitUntil - now} />
                <Text style={styles.left}>
                  {t(removeAt ? 'mobile.payments.removed_in' : 'mobile.payments.added_in', {time: leftUnit(waitUntil - now, t).join(' ')})}
                </Text>
              </>
            ) : null}
          </View>
          <Text style={styles.addrMuted}>{b.recipientAddress}</Text>
          {note ? (
            <Text style={[styles.sub, b.status === WHITELIST_STATUS.voided && styles.subWarn]} numberOfLines={1}>
              {note}
            </Text>
          ) : null}
        </View>
        {busy === `rm-${b.id}` ? (
          <ActivityIndicator color={c.subtext} />
        ) : removeAt ? null : (
          <Pressable
            hitSlop={10}
            disabled={!ready}
            onPress={() => removeEntry(b)}
            accessibilityRole="button"
            accessibilityLabel={t('vault.remove')}
            style={({pressed}) => [styles.remove, (pressed || !ready) && styles.pressed]}>
            <Text style={styles.removeText}>✕</Text>
          </Pressable>
        )}
      </Pressable>
    );
  };

  // Payable now (a queued removal still is, until it lands) vs still waiting out the timelock, or
  // voided by a lock. An entry with no status (from the server) is payable.
  const isPending = (b: WhitelistedRecipient) => b.status === WHITELIST_STATUS.pending || b.status === WHITELIST_STATUS.voided;
  const live = book.filter((b) => !isPending(b));
  const waiting = book.filter(isPending);
  const allowance = risk ? t('mobile.payments.max_send_daily', {value: fmtAllowance(risk.sendDailyAllowance, t)}) : null;
  const whitelisted = (a: string) => live.some((b) => b.recipientAddress.toLowerCase() === a.toLowerCase());

  // New recipient in the header: always in reach, however long the book grows.
  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => nav.navigate(manage ? 'VaultWhitelistAdd' : 'NewRecipient')}
          hitSlop={10}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.payments.new_recipient')}>
          <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
            <Path d="M12 5v14M5 12h14" stroke={c.accent} strokeWidth={2.2} strokeLinecap="round" />
          </Svg>
        </Pressable>
      ),
    });
  }, [nav, t, c, styles, manage]);

  return (
    <ScrollView
      style={styles.flex}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      // A PUSHED screen: the header inset is the system's to apply, so this and nothing else.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.body}>
      {/* The whitelist first, and always — even with nothing in it: paying somewhere this vault
          already pays is the common case, and an empty list still says the vault HAS one. */}
      <Text style={styles.section}>
        {t('mobile.payments.whitelisted_book')} · {t('mobile.payments.max_send_none')}
      </Text>
      <View style={styles.card}>
        {loading ? (
          <View style={[styles.row, styles.rowFirst, styles.rowLast, styles.centered]}>
            <ActivityIndicator color={c.accent} />
          </View>
        ) : live.length === 0 ? (
          <View style={[styles.row, styles.rowFirst, styles.rowLast]}>
            <Text style={styles.emptyText}>{t('mobile.payments.book_empty_title')}</Text>
          </View>
        ) : (
          live.map((b, i) => entryRow(b, i, live))
        )}
      </View>

      {/* Not payable as whitelisted yet: until then, a send to one of these is held to the daily
          send allowance, which the title says. */}
      {waiting.length > 0 ? (
        <>
          <Text style={styles.section}>
            {t('mobile.payments.pending_whitelisted')}
            {allowance ? ` · ${allowance}` : ''}
          </Text>
          <View style={styles.card}>{waiting.map((b, i) => entryRow(b, i, waiting))}</View>
        </>
      ) : null}

      {!manage && mine.length > 0 ? (
        <>
          {/* Your own vaults are paid like anyone else: no limit once whitelisted, else the allowance. */}
          <Text style={styles.section}>
            {t('mobile.payments.my_vaults')}
            {allowance ? ` · ${allowance}` : ''}
          </Text>
          <View style={styles.card}>
            {mine.map((v, i) => (
              <Pressable
                key={v.index}
                style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, i === mine.length - 1 && styles.rowLast, pressed && styles.pressed]}
                onPress={() => pick(v.address, v.name)}
                onLongPress={() => copy(v.address)}>
                <View style={styles.entryCol}>
                  <Text style={styles.entryName} numberOfLines={1}>{v.name}</Text>
                  <Text style={styles.addrMuted}>{v.address}</Text>
                  {whitelisted(v.address) ? (
                    <Text style={styles.sub}>
                      {t('mobile.payments.whitelisted_book')} · {t('mobile.payments.max_send_none')}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, paddingBottom: 32},
    section: {color: c.subtext, fontSize: 13, fontWeight: '600', paddingHorizontal: 4, paddingTop: 18, paddingBottom: 8},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    // The same row metrics the asset picker uses, so a list is a list.
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 56,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    rowFirst: {borderTopWidth: 0, paddingTop: 16},
    rowLast: {paddingBottom: 16},
    pressed: {opacity: 0.6},
    entryCol: {flex: 1, gap: 2, minWidth: 0},
    nameLine: {flexDirection: 'row', alignItems: 'center', gap: 6},
    entryName: {color: c.text, fontSize: 16, fontWeight: '600', flexShrink: 1},
    left: {color: c.subtext, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums']},
    entryNameOff: {color: c.subtext},
    // Sized to the bar's 44, as the Pending page's lock: the native bar anchors a custom view by its bottom.
    headerBtn: {width: 44, height: 44, paddingBottom: 9, alignItems: 'center', justifyContent: 'center'},
    addrMuted: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums']},
    sub: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
    subWarn: {color: c.danger},
    emptyText: {color: c.subtext, fontSize: 15},
    centered: {justifyContent: 'center'},
    remove: {width: 28, height: 28, borderRadius: 14, backgroundColor: c.neutralSoft, alignItems: 'center', justifyContent: 'center'},
    removeText: {color: c.subtext, fontSize: 13, fontWeight: '700'},
  });

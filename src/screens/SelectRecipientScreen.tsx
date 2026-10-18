import React, {useCallback, useEffect, useLayoutEffect, useMemo, useState} from 'react';
import Svg, {Path} from 'react-native-svg';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {useVaults} from '@/core/vault-store';
import {useNetwork} from '@/core/network-store';
import {useWallet} from '@/wallet/store';
import {ownerVaultAddress} from '@/vault/read';
import {fetchWhitelist, removeWhitelisted, type WhitelistedRecipient} from '@/vault/payments';
import {WHITELIST_STATUS} from '@/core/abi';
import {getRiskConfig, type RiskConfig} from '@/vault/risk';
import {fmtAllowance} from '@/components/riskFormat';
import {useAssetCatalog} from '@/core/asset-catalog';
import Clipboard from '@react-native-clipboard/clipboard';
import {showToast} from '@/components/Toast';
import {ProgressRing, leftUnit, waitDone} from '@/components/ProgressRing';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useRecipientNames, recipientName} from '@/core/recipient-names';
import {useRecipientPick} from '@/core/recipient-pick';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Who to pay, as its own page, in two groups: the whitelisted address book, each entry under its
 * name; and the owner's other vaults. "New recipient" is the + in the header ({NewRecipientScreen}).
 * The book is also pruned here (the ✕ on each entry, through the Face-ID and fee confirm).
 *
 * Hands its answer back through {useRecipientPick} and then calls `goBack`. A route param would
 * have to be delivered by `navigate`, which is as willing to push a second Send page as it is to
 * return to the first; `goBack` can only unwind, which is the behaviour this page wants.
 */
export function SelectRecipientScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
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
  const symbol = useAssetCatalog(network).find((a) => a.kind === 'stable')?.symbol;
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
        .filter((v) => v.index !== activeIndex && v.owner)
        .map((v) => ({
          index: v.index,
          name: v.name || t('mobile.app.vault_n', {n: v.index + 1}),
          address: ownerVaultAddress(v.owner as `0x${string}`, network),
        })),
    [vaults, activeIndex, network, t],
  );

  const setPicked = useRecipientPick((st) => st.set);
  const names = useRecipientNames((st) => st.names);

  const pick = (address: string, label?: string) => {
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
    const onDate = (at: number) => t('mobile.vault.on_date', {date: new Date(at * 1000).toLocaleDateString()});
    const note = removeAt
      ? t('mobile.payments.removal_pending', {when: onDate(removeAt)})
      : b.status === WHITELIST_STATUS.voided
          ? t('mobile.payments.voided_by_lock')
          : null;
    return (
      <Pressable
        key={b.id}
        style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, i === list.length - 1 && styles.rowLast, pressed && styles.pressed]}
        onPress={() => pick(b.recipientAddress, named)}
        onLongPress={() => copy(b.recipientAddress)}>
        {/* Every entry under a name: the one saved on this device, or its place in the
            book where none was given. The full address below, since that is what gets paid. */}
        <View style={styles.entryCol}>
          <View style={styles.nameLine}>
            <Text style={[styles.entryName, !named && styles.entryNameOff]} numberOfLines={1}>
              {named ?? t('mobile.payments.recipient_n', {n: b.id})}
            </Text>
            {/* Still waiting out the timelock: how far it has run, and what is left. */}
            {b.status === WHITELIST_STATUS.pending && b.effectiveAt ? (
              <>
                <ProgressRing size={16} done={waitDone(b.effectiveAt, now, Number(risk?.timelock ?? 0))} left={b.effectiveAt - now} />
                <Text style={styles.left}>{leftUnit(b.effectiveAt - now, t).join(' ')}</Text>
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
  // voided by a lock. A v1.0.3 entry carries no status and is payable.
  const isPending = (b: WhitelistedRecipient) => b.status === WHITELIST_STATUS.pending || b.status === WHITELIST_STATUS.voided;
  const live = book.filter((b) => !isPending(b));
  const waiting = book.filter(isPending);
  const allowance = risk ? t('mobile.payments.max_send_daily', {value: fmtAllowance(risk.sendDailyAllowance, risk, symbol, t)}) : null;
  const whitelisted = (a: string) => live.some((b) => b.recipientAddress.toLowerCase() === a.toLowerCase());

  // New recipient in the header: always in reach, however long the book grows.
  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => nav.navigate('NewRecipient')}
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
  }, [nav, t, c, styles]);

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

      {mine.length > 0 ? (
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

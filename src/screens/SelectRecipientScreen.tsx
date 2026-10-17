import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {Sheet} from '@/components/Sheet';
import {isPayableAddress, isTokenAddress} from '@/core/asset-catalog';
import {useVaults} from '@/core/vault-store';
import {useNetwork} from '@/core/network-store';
import {useWallet} from '@/wallet/store';
import {ownerVaultAddress} from '@/vault/read';
import {fetchRemovals, fetchWhitelist, removeWhitelisted, type WhitelistedRecipient} from '@/vault/payments';
import {useVaultWrite} from '@/components/useVaultWrite';
import {shortAddress} from '@/core/format';
import {useRecipientNames, recipientName} from '@/core/recipient-names';
import {useRecipientPick} from '@/core/recipient-pick';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Who to pay, as its own page — and the one place the address book is kept: chosen from, added to
 * (a typed address with "Add to whitelist" on is written in with the send), and pruned (the ✕ on
 * each entry, through the Face-ID and fee confirm).
 *
 * It was a sheet, and outgrew one: the book, the owner's other vaults, an address to type and a
 * decision to make about it do not fit in something you dismiss by dragging. A page can also be
 * backed out of without losing a half-typed address to a stray gesture.
 *
 * The vaults are a sheet WITHIN the page rather than a third list down it. They are the one
 * section whose rows are interchangeable — pick one and you are done — and inlining four of them
 * pushed the thing most people came here to do, typing a new address, below the fold.
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
  const {slot} = useRoute<RouteProp<RootStackParamList, 'SelectRecipient'>>().params;
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const vaults = useVaults((s) => s.vaults);
  const activeIndex = useVaults((s) => s.activeIndex);

  const [book, setBook] = useState<WhitelistedRecipient[]>([]);
  /**
   * Entries whose removal is queued, and when it lands. An entry the vault can already pay is not
   * taken off at once — it stays payable until then, and a lock voids the removal — so its row says
   * so instead of offering the ✕ again, which would only start the wait over.
   */
  const [removals, setRemovals] = useState<Record<string, number>>({});
  /**
   * Loading until the chain answers.
   *
   * The empty state used to show while the read was still in flight, so every open of this page
   * began by saying the whitelist was empty and then contradicting itself. "Empty" is a claim
   * about what came back, and until something has, there is nothing to claim.
   */
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!vault) return;
    let live = true;
    setLoading(true);
    fetchWhitelist(vault, network)
      .then(async (rows) => {
        const queued = await fetchRemovals(
          vault,
          network,
          rows.map((r) => r.id),
        );
        if (!live) return;
        setBook(rows);
        setRemovals(queued);
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
      shortAddress(b.recipientAddress),
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
  const setName = useRecipientNames((st) => st.setName);

  const [vaultSheet, setVaultSheet] = useState(false);
  const [draft, setDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  /**
   * Whether a typed address is written into the book.
   *
   * On by default, because a vault with new-payment protection enabled will refuse to pay an
   * address it has never seen, and the common reason to type one is that you intend to use it.
   * It is a choice and not a side effect, though: a one-off payment to an address you will never
   * use again should not leave an entry behind, and turning this off is how that is said.
   */
  const [addToBook, setAddToBook] = useState(true);

  const pick = (address: string, label?: string, add = false) => {
    setPicked({slot, address: address as Address, label, addToBook: add});
    nav.goBack();
  };

  /** A typed address, with whatever it was called — the name is written here, on this device. */
  const useTyped = () => {
    const given = nameDraft.trim();
    if (given) setName(network, draft, given);
    pick(draft, given || undefined, addToBook);
  };

  const valid = isPayableAddress(draft, network);
  const isToken = isTokenAddress(draft, network);

  return (
    <ScrollView
      style={styles.flex}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      // A PUSHED screen: the header inset is the system's to apply, so this and nothing else.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.body}
      // Drag the page and the keyboard goes with it; `handled` keeps a tap on a row working on
      // the first try rather than spending it on the dismiss.
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled">
      {/* A tap on the page, anywhere that is not a control, puts the keyboard away. The nested
          pressables and the fields win the gesture before this does. */}
      <Pressable accessible={false} onPress={Keyboard.dismiss} style={styles.dismiss}>
      {/* The whitelist first, and always — even with nothing in it.
      
          Paying somewhere this vault has already paid is the common case, and the whole reason
          not to make someone type an address. Hiding the section when it is empty also hides
          the fact that the vault HAS a whitelist, which is what someone needs to know before
          deciding whether the address they are about to type belongs on it. */}
      <Text style={styles.section}>{t('vault.address_book')}</Text>
      <View style={styles.card}>
        {loading ? (
          <View style={[styles.row, styles.rowOnly, styles.centered]}>
            <ActivityIndicator color={c.accent} />
          </View>
        ) : book.length === 0 ? (
          <View style={[styles.row, styles.rowOnly]}>
            <Text style={styles.emptyText}>{t('mobile.payments.book_empty_title')}</Text>
          </View>
        ) : (
          book.map((b, i) => {
            const named = recipientName(names, network, b.recipientAddress);
            const removeAt = removals[b.id];
            return (
              <Pressable
                key={b.id}
                style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, i === book.length - 1 && styles.rowLast, pressed && styles.pressed]}
                onPress={() => pick(b.recipientAddress, named)}>
                {/* Name and address across one line, as on the Send card: the name is what the
                    user recognises and the address is what gets paid, so the row shows both.
                    The name yields first; the address is the part that must stay whole. */}
                <View style={styles.entryCol}>
                  <View style={styles.entry}>
                    {named ? (
                      <Text style={styles.entryName} numberOfLines={1}>
                        {named}
                      </Text>
                    ) : null}
                    <Text style={named ? styles.addrMuted : styles.addr} numberOfLines={1}>
                      {shortAddress(b.recipientAddress)}
                    </Text>
                  </View>
                  {removeAt ? (
                    <Text style={styles.sub} numberOfLines={1}>
                      {t('mobile.payments.removal_pending', {
                        when: t('mobile.vault.on_date', {date: new Date(removeAt * 1000).toLocaleDateString()}),
                      })}
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
          })
        )}
      </View>

      {mine.length > 0 ? (
        <>
          <Text style={styles.section}>{t('mobile.payments.my_vaults')}</Text>
          <View style={styles.card}>
            <Pressable
              style={({pressed}) => [styles.row, styles.rowOnly, pressed && styles.pressed]}
              onPress={() => setVaultSheet(true)}>
              <Text style={styles.rowLabel}>{t('mobile.settings.choose_vault')}</Text>
              <Text style={styles.count}>{mine.length}</Text>
              <Text style={styles.chev}>›</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {/* Typing last: the exception, and the only one of the three that can go wrong. */}
      <Text style={styles.section}>{t('mobile.payments.new_recipient')}</Text>
      <View style={styles.card}>
        <TextInput
          style={[styles.input, draft.length > 0 && !valid && styles.inputErr]}
          placeholder={t('mobile.vault.enter_address')}
          placeholderTextColor={c.subtext}
          autoCapitalize="none"
          autoCorrect={false}
          value={draft}
          onChangeText={setDraft}
        />
        {/* Named, not just refused: a well-formed address the field rejects looks like a bug
            unless the screen says what is wrong with it. */}
        {isToken ? <Text style={styles.warn}>{t('mobile.payments.token_address_warning')}</Text> : null}
        {/* The name is all there is to add: an entry accepts any asset, since a locked vault pays
            out only through this list and cannot trade into a narrower one. The name is local. */}
        <TextInput
          style={[styles.input, styles.nameInput]}
          placeholder={t('mobile.payments.recipient_name')}
          placeholderTextColor={c.subtext}
          autoCapitalize="words"
          value={nameDraft}
          onChangeText={setNameDraft}
        />
        <Text style={styles.note}>{t('mobile.payments.name_local_only')}</Text>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>{t('mobile.payments.add_to_whitelist')}</Text>
          <Switch value={addToBook} onValueChange={setAddToBook} style={styles.switch} />
        </View>
        <Pressable
          style={({pressed}) => [styles.use, !valid && styles.useOff, pressed && styles.pressed]}
          disabled={!valid}
          onPress={useTyped}>
          <Text style={[styles.useText, !valid && styles.useTextOff]}>{t('vault.confirm')}</Text>
        </Pressable>
      </View>

      {/* The vaults, in a sheet: one tap to open, one to choose, and the page behind it keeps
          whatever was typed. */}
      <Sheet visible={vaultSheet} title={t('mobile.settings.choose_vault')} onClose={() => setVaultSheet(false)}>
        <ScrollView showsVerticalScrollIndicator={false} style={styles.sheetScroll}>
          <View style={styles.card}>
            {mine.map((v, i) => (
              <Pressable
                key={v.index}
                style={({pressed}) => [styles.row, i === 0 && styles.rowFirst, i === mine.length - 1 && styles.rowLast, pressed && styles.pressed]}
                onPress={() => {
                  setVaultSheet(false);
                  pick(v.address, v.name);
                }}>
                <View style={styles.rowText}>
                  <Text style={styles.rowLabel}>{v.name}</Text>
                  <Text style={styles.sub}>{shortAddress(v.address)}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </Sheet>
      {sheet}
      </Pressable>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, paddingBottom: 32},
    dismiss: {flex: 1},
    section: {color: c.subtext, fontSize: 13, fontWeight: '600', paddingHorizontal: 4, paddingTop: 18, paddingBottom: 8},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    sheetScroll: {flexGrow: 0},

    input: {height: 48, borderRadius: 12, backgroundColor: c.input, color: c.text, paddingHorizontal: 12, fontSize: 15, marginTop: 16},
    nameInput: {width: '100%'},
    inputErr: {borderWidth: 1, borderColor: c.danger},
    warn: {color: c.danger, fontSize: 12, lineHeight: 17, marginTop: 8},
    note: {color: c.subtext, fontSize: 12, lineHeight: 17, marginTop: 6, paddingHorizontal: 2},
    toggleRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14},
    // A chevron's glyph sits a few points inside its box; a switch fills its own exactly, so
    // without this it looks nearer the card's edge than everything above it.
    switch: {marginRight: 10},
    toggleLabel: {color: c.text, fontSize: 15, fontWeight: '600', flex: 1},
    use: {height: 44, borderRadius: 12, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 16},
    useOff: {backgroundColor: c.neutralSoft},
    useText: {color: '#fff', fontSize: 15, fontWeight: '700'},
    useTextOff: {color: c.subtext},

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
    rowOnly: {borderTopWidth: 0, paddingTop: 16, paddingBottom: 16},
    pressed: {opacity: 0.6},
    rowText: {flex: 1, gap: 2},
    rowLabel: {color: c.text, fontSize: 16, fontWeight: '600', flex: 1},
    entryCol: {flex: 1, gap: 2, minWidth: 0},
    entry: {flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0},
    entryName: {color: c.text, fontSize: 16, fontWeight: '600', flexShrink: 1},
    addrMuted: {color: c.subtext, fontSize: 13, fontVariant: ['tabular-nums']},
    sub: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
    addr: {color: c.text, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums']},
    emptyText: {color: c.subtext, fontSize: 15},
    centered: {justifyContent: 'center'},
    count: {color: c.subtext, fontSize: 14, fontVariant: ['tabular-nums']},
    chev: {color: c.subtext, fontSize: 20, fontWeight: '300'},
    remove: {width: 28, height: 28, borderRadius: 14, backgroundColor: c.neutralSoft, alignItems: 'center', justifyContent: 'center'},
    removeText: {color: c.subtext, fontSize: 13, fontWeight: '700'},
  });

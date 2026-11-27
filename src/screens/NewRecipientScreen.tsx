import {displayAddress, parseAddress} from '@/core/address';
import {useVaults, vaultLabel, type VaultRef} from '@/core/vault-store';
import {vaultAddressOf} from '@/core/active-vault';
import {readVaultBalances} from '@/vault/read';
import {shortAddress} from '@/core/format';
import {SettingsGroup, SettingsRow} from '@/components/SettingsRow';
import {NO_LIMIT} from '@/vault/capabilities';
import React, {useEffect, useState} from 'react';
import {Alert, Keyboard, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {isPayableAddress, isTokenAddress} from '@/core/asset-catalog';
import {NETWORKS, networkLabel, useNetwork} from '@/core/network-store';
import {CHAIN_ID, isTestnet, isTronNetwork, type Network} from '@/core/chain';
import {BRIDGE_TO_SINCE, versionAtLeast} from '@/vault/capabilities';
import {runningVaultVersion} from '@/vault/vault-abi';
import {plannedVaultUpgrade} from '@/vault/auto-upgrade';
import {acrossServes} from '@/vault/bridge';
import {Sheet} from '@/components/Sheet';
import {NetworkIcon} from '@/components/NetworkSwitcher';
import Svg, {Circle, Path} from 'react-native-svg';
import {useWallet} from '@/wallet/store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {getRiskConfig, type RiskConfig} from '@/vault/risk';
import {fmtAllowance, fmtWait} from '@/components/riskFormat';
import {useRecipientNames} from '@/core/recipient-names';
import {useRecipientPick} from '@/core/recipient-pick';
import {usePayeeAdding} from '@/vault/payees';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {useVaultWrite} from '@/components/useVaultWrite';
import {useAccountWrite} from '@/account/useAccountWrite';
import {accountBook, accountRiskConfig} from '@/account/guard-evm';
import {addPayeeCall, readGuard} from '@/account/guard';
import {addWhitelisted, addWhitelistedOn, fetchWhitelist, type WhitelistedRecipient} from '@/vault/payments';
import {WHITELIST_STATUS} from '@/core/abi';
import {GateHint, LockIcon, useLockLevel} from '@/components/LockNotice';
import {useCapability} from '@/vault/gate';
import {QrScanner} from '@/components/QrScanner';
import {ScanButton} from '@/components/ScanIcon';

/**
 * Select recipient › New recipient — an address to type, a name for it on this device, and whether
 * it goes into the whitelist with the payment. The most the payment can be follows that choice: a
 * whitelisted address has no cap, any other is held to the vault's daily send allowance.
 *
 * Confirming hands the address back through {useRecipientPick} and unwinds past the picker straight
 * to the Send card, which is where the choice is used.
 */
/**
 * Security › Whitelisted addresses › + — the same form, without the payment: the address always goes
 * into the book, through the Face-ID and fee confirm, and the page closes once it is submitted.
 */
export function AddWhitelistedScreen() {
  return <NewRecipientScreen manage />;
}

export function NewRecipientScreen({manage = false}: {manage?: boolean}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const owner = useWallet((s) => s.address);
  const vault = useActiveVaultAddress(network);
  const setPicked = useRecipientPick((st) => st.set);
  const setName = useRecipientNames((st) => st.setName);

  const [draft, setDraft] = useState('');
  /**
   * Where the payee is paid (vault 1.2.1, managing the book only): on this network, the same
   * address on every EVM network, or on one other network, paid there only by a bridge.
   */
  const [onChain, setOnChain] = useState<'here' | 'evm' | Network>('here');
  const [chainPicker, setChainPicker] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (manage && vault) runningVaultVersion(vault, network).then(setVersion);
  }, [manage, vault, network]);
  const planned = vault ? plannedVaultUpgrade(vault, network) : null;
  const onOthers = manage && (versionAtLeast(version, BRIDGE_TO_SINCE) || (!!planned && versionAtLeast(planned, BRIDGE_TO_SINCE)));
  const otherNets = NETWORKS.filter((n) => n !== network && acrossServes(n) && isTestnet(n) === isTestnet(network));
  /** The network the address is written for: this one, or the other network picked. */
  const addrNet: Network = onChain === 'here' || onChain === 'evm' ? network : onChain;
  const chainName = (v: 'here' | 'evm' | Network) =>
    v === 'here' ? networkLabel(network, t) : v === 'evm' ? t('mobile.payments.chain_all_evm') : networkLabel(v, t);
  const [scanning, setScanning] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  // On by default: a vault with new-payment protection refuses an address it has never seen, and
  // the usual reason to type one is to keep using it. Off is a one-off payment that leaves no entry.
  const [addToBook, setAddToBook] = useState(true);
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  // The Tron smart wallet in front: its timelock, limit, lock and payees, each add relayed.
  const acct = useAccountWrite(() => nav.goBack());
  const smart = acct.account != null;
  const [acctLocked, setAcctLocked] = useState(false);
  useEffect(() => {
    if (acct.account) {
      accountRiskConfig(network, acct.account).then(setRisk).catch(() => {});
      readGuard(network, acct.account).then((g) => setAcctLocked(g.locked)).catch(() => {});
      return;
    }
    if (vault) getRiskConfig(vault, network).then(setRisk);
  }, [vault, network, acct.account]);
  // With sends to new addresses off, a typed address can be paid only if it is already in the book
  // and past its wait — so the book is read to tell.
  const sendsOff = !manage && !!risk?.read && risk.sendDailyAllowance === 0n;
  // Locked, the same holds — the vault pays only the book — and nothing can be added to it.
  const vaultSendGate = useCapability('send');
  const vaultAddGate = useCapability('addWhitelistedRecipient');
  const smartGate = acctLocked ? ({allowed: false, reason: 'locked'} as unknown as typeof vaultAddGate) : ({allowed: true} as typeof vaultAddGate);
  const sendGate = smart ? smartGate : vaultSendGate;
  const addGate = smart ? smartGate : vaultAddGate;
  const lockLevel = useLockLevel();
  const lockedSends = !manage && !sendGate.allowed && sendGate.reason !== 'send_allowance_off';
  const bookOnly = sendsOff || lockedSends;
  // The lock refuses what this page does: adding to the book, or paying a new address.
  const lockedHere = lockLevel > 0 && (manage ? !addGate.allowed : lockedSends);
  // With sends to new addresses off, a new address can only be paid once it is in the book and past
  // its wait, so confirming here adds it to the book on chain, as Security › Whitelisted does.
  const addsOnChain = manage || (sendsOff && !lockedSends);
  const [book, setBook] = useState<WhitelistedRecipient[]>([]);
  useEffect(() => {
    if (acct.account) {
      accountBook(network, acct.account).then(setBook).catch(() => setBook([]));
      return;
    }
    if (bookOnly && vault) fetchWhitelist(vault, network).then(setBook).catch(() => setBook([]));
  }, [bookOnly, vault, network, acct.account]);

  /**
   * The user's other smart wallets holding something on this chain: one tap fills the address and,
   * as the payee's name, the wallet's own. Empty ones are left out — nothing to move between them yet.
   */
  const vaults = useVaults((s) => s.vaults);
  const [own, setOwn] = useState<{v: VaultRef; address: Address}[]>([]);
  useEffect(() => {
    let live = true;
    const others = vaults.flatMap((v) => {
      const address = v.hidden ? null : vaultAddressOf(v, network);
      return address && address.toLowerCase() !== vault?.toLowerCase() ? [{v, address}] : [];
    });
    Promise.all(
      others.map((o) =>
        readVaultBalances(o.address, network)
          .then((b) => b.native.raw > 0n || b.tokens.some((x) => x.raw > 0n))
          .catch(() => false),
      ),
    ).then((has) => live && setOwn(others.filter((_, i) => has[i])));
    return () => {
      live = false;
    };
  }, [vaults, network, vault]);
  const walletName = (n: number) => t('mobile.account.wallet_n', {n});

  const self = acct.account ?? vault;
  const isSelf = (smart || onChain !== 'here') && !!self && parseAddress(addrNet, draft)?.toLowerCase() === self.toLowerCase();
  const valid = isPayableAddress(draft, addrNet) && !isSelf;
  /**
   * The key that owns this smart wallet, typed as a payee. Payees are paid with no daily limit, so
   * whoever steals the key could empty the smart wallet to it in one go — the guard would protect
   * nothing. Allowed, but warned under the field and confirmed before it is added.
   */
  const isOwner = !!owner && parseAddress(addrNet, draft)?.toLowerCase() === owner.toLowerCase();
  const isToken = isTokenAddress(draft, addrNet);
  const max = addToBook || addsOnChain
    ? t('mobile.payments.max_send_none')
    : risk
      ? risk.sendDailyAllowance === 0n || risk.sendDailyAllowance === NO_LIMIT
        ? fmtAllowance(risk.sendDailyAllowance, t)
        : t('mobile.payments.max_send_daily', {value: fmtAllowance(risk.sendDailyAllowance, t)})
      : '…';

  const markAdding = usePayeeAdding((st) => st.mark);
  // Accepted by the relayer: the payee is on its way, so the Overview's "no payees" dot can go now.
  const write = useVaultWrite(() => {
    if (vault) markAdding(vault);
    nav.goBack();
  });
  // Whether Confirm puts the address on the payee list (now, or with the send it starts).
  const addsPayee = () => {
    const to = parseAddress(addrNet, draft);
    if (!to) return false;
    if (manage) return true;
    const listed = book.some((b) => b.recipientAddress.toLowerCase() === to.toLowerCase());
    return !listed && (addsOnChain || (addToBook && addGate.allowed));
  };
  const confirm = () => {
    if (isOwner && addsPayee()) {
      Alert.alert(t('mobile.payments.payee_owner_title'), t('mobile.payments.payee_is_owner'), [
        {text: t('common.cancel'), style: 'cancel'},
        {text: t('mobile.payments.payee_owner_add_anyway'), style: 'destructive', onPress: confirmNow},
      ]);
      return;
    }
    confirmNow();
  };
  const confirmNow = () => {
    // What was typed, as the 0x… the vault takes: on Tron the T… form is what people paste.
    const to = parseAddress(addrNet, draft);
    if (!to) return;
    const given = nameDraft.trim();
    if (given) setName(addrNet, to, given);
    if (manage && onChain !== 'here') {
      const chain = onChain === 'evm' ? ('evm' as const) : CHAIN_ID[onChain];
      write.run('add', `${t('vault.add')} · ${t('vault.address_book')}`, (base) => addWhitelistedOn({...base, chain, recipient: to}));
      return;
    }
    const listed = book.find((b) => b.recipientAddress.toLowerCase() === to.toLowerCase());
    if (acct.account && (manage || (addsOnChain && !listed))) {
      void acct.run('add', `${t('vault.add')} · ${t('vault.address_book')}`, [addPayeeCall(acct.account, to)], undefined, () => markAdding(acct.account!));
      return;
    }
    if (manage || (addsOnChain && !listed)) {
      write.run('add', `${t('vault.add')} · ${t('vault.address_book')}`, (base) =>
        addWhitelisted({...base, recipient: to}),
      );
      return;
    }
    const payable =
      !!listed &&
      (listed.status === undefined || listed.status === WHITELIST_STATUS.payable || listed.status === WHITELIST_STATUS.removalQueued);
    if (bookOnly && !payable) {
      if (lockedSends) Alert.alert(t('mobile.payments.cant_pay_title'), t('mobile.vault.lock_send_book_only'));
      else
        Alert.alert(t('mobile.payments.cant_pay_title'), t('mobile.payments.cant_pay_sends_off'), [
          {text: t('common.cancel'), style: 'cancel'},
          {text: t('mobile.payments.cant_pay_settings'), onPress: () => nav.navigate('VaultRiskValue', {field: 'sendDailyAllowance'})},
        ]);
      return;
    }
    setPicked({address: to, label: given || undefined, addToBook: addToBook && addGate.allowed});
    // Back past the picker to the Send card; from the Overview's Payees there is none, so open one.
    if (nav.getState().routes.some((r) => r.name === 'Payments')) nav.pop(2);
    else nav.replace('Payments');
  };
  const canConfirm = valid && (!addsOnChain || ((smart ? acct.ready : write.ready) && addGate.allowed));

  // No timelock: a new payee is payable at once, so the Payee after row is left out.
  const noWait = risk?.timelock === 0n;
  return (
    <ScrollView
      style={styles.flex}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.body}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled">
      <Pressable accessible={false} onPress={Keyboard.dismiss} style={styles.dismiss}>
        {/* Two full-width fields in one group, as Settings rows: the address, then the name. */}
        <View style={styles.fields}>
          <View style={[styles.addrRow, styles.divider]}>
            <TextInput
              style={[styles.input, styles.addrInput, draft.length > 0 && !valid && styles.inputErr]}
              placeholder={t('mobile.vault.enter_address')}
              placeholderTextColor={c.subtext}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              value={draft}
              onChangeText={setDraft}
            />
            <ScanButton onPress={() => setScanning(true)} />
          </View>
          <TextInput
            style={styles.input}
            placeholder={`${t('mobile.payments.recipient_name')} · ${t('mobile.payments.name_local_only')}`}
            placeholderTextColor={c.subtext}
            autoCapitalize="words"
            value={nameDraft}
            onChangeText={setNameDraft}
          />
          {onOthers ? (
            <Pressable
              style={({pressed}) => [styles.netRow, pressed && styles.pressed]}
              onPress={() => (Keyboard.dismiss(), setChainPicker(true))}
              accessibilityRole="button">
              <Text style={styles.rowLabel}>{t('mobile.payments.payee_network')}</Text>
              <Text style={styles.rowValue} numberOfLines={1}>
                {chainName(onChain)}
              </Text>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                <Path d="M9 6l6 6-6 6" stroke={c.subtext} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
            </Pressable>
          ) : null}
        </View>
        {onOthers && onChain !== 'here' ? (
          <Text style={styles.note}>
            {t(onChain === 'evm' ? 'mobile.payments.chain_all_evm_note' : 'mobile.payments.chain_other_note', {network: chainName(onChain)})}
          </Text>
        ) : null}
        {isSelf ? <Text style={styles.warn}>{t('mobile.payments.payee_is_vault')}</Text> : null}
        {isOwner ? <Text style={styles.warn}>{t('mobile.payments.payee_is_owner')}</Text> : null}
        {isToken ? <Text style={styles.warn}>{t('mobile.payments.token_address_warning')}</Text> : null}
        {own.length > 0 ? (
          <View style={styles.gap}>
            <SettingsGroup label={t('mobile.payments.own_wallets')}>
              {own.map(({v, address}, i) => (
                <SettingsRow
                  key={v.index}
                  icon="vault"
                  title={vaultLabel(v, walletName)}
                  sub={shortAddress(displayAddress(network, address))}
                  chevron={false}
                  onPress={() => {
                    setDraft(displayAddress(network, address));
                    setNameDraft(vaultLabel(v, walletName));
                  }}
                  last={i === own.length - 1}
                />
              ))}
            </SettingsGroup>
          </View>
        ) : null}
        {/* Adding a payee: one this device does not hold the key to is the safer choice. */}

        <View style={[styles.card, styles.gap]}>
          {/* Managing the book there is no payment: no switch, and no cap to show. */}
          {addsOnChain ? null : (
            <>
              <View style={[styles.row, styles.divider]}>
                <Text style={styles.rowLabel}>{t('mobile.payments.add_to_whitelist')}</Text>
                <Switch
                  value={addToBook && addGate.allowed}
                  disabled={!addGate.allowed}
                  onValueChange={setAddToBook}
                  style={styles.switch}
                />
              </View>
              <View style={[styles.row, addToBook && noWait === false && styles.divider]}>
                <Text style={styles.rowLabel}>{t('mobile.payments.max_send')}</Text>
                <Text style={styles.rowValue}>{max}</Text>
              </View>
            </>
          )}
          {/* A new whitelist entry waits out the timelock before it can be paid; with none, no row. */}
          {(addToBook || addsOnChain) && !noWait ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>{t('mobile.payments.whitelist_wait')}</Text>
              <Text style={styles.rowValue}>{risk ? fmtWait(risk.timelock, t) : '…'}</Text>
            </View>
          ) : null}
        </View>

        <Pressable
          style={({pressed}) => [styles.use, (!canConfirm || lockedHere) && styles.useOff, pressed && styles.pressed]}
          disabled={!canConfirm || lockedHere}
          onPress={confirm}>
          <View style={styles.useRow}>
            {lockedHere ? <LockIcon level={lockLevel as 1 | 2} /> : null}
            <Text style={[styles.useText, (!canConfirm || lockedHere) && styles.useTextOff]}>{t('vault.confirm')}</Text>
          </View>
        </Pressable>
        {addsOnChain && !lockedHere ? <GateHint gate={addGate} style={styles.gap} /> : null}
      </Pressable>
      {write.sheet}
      {acct.sheet}
      <Sheet visible={chainPicker} title={t('mobile.payments.payee_network')} onClose={() => setChainPicker(false)}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {([
            'here',
            // The same address on every EVM network: not from Tron, whose addresses are its own.
            ...(isTronNetwork(network) ? [] : (['evm'] as const)),
            ...otherNets,
          ] as ('here' | 'evm' | Network)[]).map((v) => (
            <Pressable
              key={v}
              style={({pressed}) => [styles.pickRow, pressed && styles.pressed]}
              onPress={() => {
                setOnChain(v);
                setChainPicker(false);
              }}>
              {/* Every EVM network is no one network: a globe, not this network's mark. */}
              {v === 'evm' ? <AllNetsIcon color={c.subtext} bg={c.neutralSoft} /> : <NetworkIcon network={v === 'here' ? network : v} size={30} />}
              <View style={styles.pickCol}>
                <Text style={styles.pickLabel}>{chainName(v)}</Text>
                {v === 'here' ? <Text style={styles.pickSub}>{t('mobile.payments.chain_here_sub')}</Text> : null}
              </View>
              {onChain === v ? (
                <Svg width={18} height={18} viewBox="0 0 24 24">
                  <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </Svg>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
      <QrScanner
        visible={scanning}
        onScan={(a) => {
          setScanning(false);
          setDraft(displayAddress(addrNet, a));
        }}
        onClose={() => setScanning(false)}
      />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    flex: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, paddingBottom: 32},
    dismiss: {flex: 1},
    card: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    gap: {marginTop: 24},
    fields: {backgroundColor: c.card, borderRadius: 20, overflow: 'hidden'},
    input: {width: '100%', minHeight: 52, color: c.text, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15},
    inputErr: {color: c.danger},
    warn: {color: c.danger, fontSize: 12, lineHeight: 17, marginTop: 6, paddingHorizontal: 16},
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52},
    divider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    addrRow: {flexDirection: 'row', alignItems: 'stretch'},
    // The scan button takes the right-hand end, so the field gives up its width and its right inset.
    addrInput: {width: undefined, flex: 1, paddingRight: 0},
    rowLabel: {color: c.text, fontSize: 15, fontWeight: '600', flex: 1},
    rowValue: {color: c.subtext, fontSize: 14, fontVariant: ['tabular-nums']},
    // A switch fills its box exactly, where a chevron's glyph sits inside; this lines them up.
    switch: {marginRight: 10},
    use: {minHeight: 52, paddingVertical: 8, borderRadius: 26, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginTop: 24},
    useOff: {backgroundColor: c.neutralSoft},
    useRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
    useText: {color: '#fff', fontSize: 15, fontWeight: '700'},
    useTextOff: {color: c.subtext},
    pressed: {opacity: 0.6},
    netRow: {flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    note: {color: c.subtext, fontSize: 12, lineHeight: 17, marginTop: 6, paddingHorizontal: 16},
    pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 4},
    pickCol: {flex: 1, minWidth: 0, gap: 2},
    pickLabel: {color: c.text, fontSize: 16, fontWeight: '600'},
    pickSub: {color: c.subtext, fontSize: 13},
  });

/** "All EVM networks": a globe in a disc the size of a network icon. */
function AllNetsIcon({color, bg}: {color: string; bg: string}) {
  return (
    <View style={{width: 30, height: 30, borderRadius: 15, backgroundColor: bg, alignItems: 'center', justifyContent: 'center'}}>
      <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
        <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={1.8} />
        <Path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      </Svg>
    </View>
  );
}

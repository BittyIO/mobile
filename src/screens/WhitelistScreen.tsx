import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {isAddress, type Address} from 'viem';
import {ConfirmButton} from '@/components/Button';
import {useConfirmAction} from '@/components/ConfirmAction';
import {shortAddress} from '@/core/format';
import {relayGasFor} from '@/vault/fee-quote';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {
  fetchWhitelist,
  addWhitelisted,
  removeWhitelisted,
  sendToWhitelisted,
  type WhitelistedRecipient,
} from '@/vault/payments';
import {ASSETS, assetMeta} from '@/core/assets';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {CopyAddress} from '@/components/CopyAddress';
import {useColors, useStyles, type Colors} from '@/theme';
import {displaySymbol} from '@/core/format';

/**
 * Address book — whitelisted recipients. Add/remove/list, and pay one by id (needed when a vault
 * restricts sends to booked recipients; otherwise the plain Send works too). Gasless, Face-ID-gated.
 */
export function WhitelistScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const account = useWallet((s) => s.account);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const assets = ASSETS[network];
  const stable = assets.find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [to, setTo] = useState('');
  const [list, setList] = useState<WhitelistedRecipient[]>([]);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(() => {
    if (vault) fetchWhitelist(vault, network).then(setList);
  }, [vault, network]);
  useEffect(load, [load]);

  const {ask, sheet} = useConfirmAction();

  const withSigner = async (id: string, title: string, fn: (acct: Awaited<ReturnType<typeof getSigner>>) => Promise<string>) => {
    setActing(id);
    const tx = showTx(title, network);
    try {
      const acct = await getSigner();
      tx.success(await fn(acct));
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setActing(null);
    }
  };

  const onAdd = async () => {
    if (!vault || !stable || !isAddress(to)) return;
    setBusy(true);
    const tx = showTx(t('vault.add_recipient'), network);
    try {
      const acct = await getSigner();
      tx.success(await addWhitelisted({account: acct, vault, network, recipient: to as Address, stableCoin: stable.address}));
      setTo('');
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // A relayed write behind a small row button: confirm first, so a mis-tap cannot spend anything.
  const onRemove = (r: WhitelistedRecipient) =>
    ask({
      title: `${t('vault.remove')} · ${t('vault.address_book')}`,
      message: shortAddress(r.recipientAddress),
      gas: relayGasFor({}),
      run: () =>
        withSigner(r.id, `${t('vault.remove')} · ${t('vault.address_book')}`, (acct) =>
          removeWhitelisted({account: acct, vault: vault!, network, id: r.id, stableCoin: stable!.address}),
        ).then(() => undefined),
    });

  const onPay = (r: WhitelistedRecipient) => {
    if (!stable) return;
    Alert.prompt(
      t('mobile.payments.pay_recipient'),
      t('mobile.payments.amount_in', {symbol: displaySymbol(stable.symbol)}),
      (value) => {
        if (!value || !(Number(value) > 0)) return;
        ask({
          title: `${t('vault.send')} ${value} ${displaySymbol(stable.symbol)}`,
          message: shortAddress(r.recipientAddress),
          gas: relayGasFor({transfer: 1}),
          run: () =>
        withSigner(r.id, `${t('vault.send')} ${value} ${displaySymbol(stable.symbol)}`, (acct) =>
          sendToWhitelisted({
            account: acct,
            vault: vault!,
            network,
            id: r.id,
            asset: stable.address,
            amount: value,
            stableCoin: stable.address,
          }),
            ).then(() => undefined),
        });
      },
      'plain-text',
      '',
      'decimal-pad',
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* The scroll view is the whole page, so a drag anywhere scrolls; the button holds the bottom. */}
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {list.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.label}>{t('mobile.payments.recipients')}</Text>
            {list.map((r) => {
              const anyAsset = /^0x0+$/.test(r.allowedAsset);
              return (
                <View key={r.id} style={styles.item}>
                  <CopyAddress address={r.recipientAddress} label={`${r.recipientAddress.slice(0, 8)}…${r.recipientAddress.slice(-6)}`} textStyle={styles.itemText} />
                  <Text style={styles.itemSub}>
                    {anyAsset ? t('vault.any_asset') : displaySymbol(assetMeta(network, r.allowedAsset as Address).symbol)}
                  </Text>
                  <View style={styles.btns}>
                    <Pressable disabled={acting !== null} onPress={() => onPay(r)} style={[styles.smBtn, styles.payBtn]}>
                      <Text style={styles.payText}>{acting === r.id ? '…' : t('vault.pay')}</Text>
                    </Pressable>
                    <Pressable disabled={acting !== null} onPress={() => onRemove(r)} style={[styles.smBtn, styles.rmBtn]}>
                      <Text style={styles.rmText}>{t('vault.remove')}</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        <Text style={styles.label}>{t('vault.add_recipient')}</Text>
        <TextInput
          style={[styles.input, to.length > 0 && !isAddress(to) && styles.inputErr]}
          placeholder={t('mobile.vault.enter_address')}
          placeholderTextColor={c.subtext}
          autoCapitalize="none"
          autoCorrect={false}
          value={to}
          onChangeText={setTo}
        />
        <Text style={styles.hint}>{t('mobile.payments.whitelist_hint')}</Text>
      </ScrollView>

      <View style={styles.footer}>
      <ConfirmButton onPress={onAdd} disabled={!account || !vault || !stable || !isAddress(to) || busy} />
      {sheet}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  scroll: {flex: 1},
  body: {flexGrow: 1, padding: 20, gap: 10, paddingBottom: 16},
  footer: {paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20},
  section: {gap: 8, marginBottom: 8},
  label: {color: c.subtext, fontSize: 13, fontWeight: '600', marginTop: 8},
  item: {backgroundColor: c.card, borderRadius: 20, padding: 12, gap: 4},
  itemText: {color: c.text, fontSize: 14, fontFamily: 'Menlo'},
  itemSub: {color: c.subtext, fontSize: 12},
  btns: {flexDirection: 'row', gap: 8, marginTop: 4},
  smBtn: {paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1},
  payBtn: {borderColor: c.accent, backgroundColor: c.accentSoft},
  payText: {color: c.accent, fontSize: 13, fontWeight: '700'},
  rmBtn: {borderColor: c.danger},
  rmText: {color: c.danger, fontSize: 13, fontWeight: '700'},
  input: {
    height: 44,
    borderRadius: 10,
    backgroundColor: c.input,
    color: c.text,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: 'Menlo',
  },
  inputErr: {borderColor: c.danger},
  hint: {color: c.subtext, fontSize: 13, marginTop: 4},
});

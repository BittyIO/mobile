import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {isAddress, type Address} from 'viem';
import {ConfirmButton} from '@/components/Button';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {ASSETS} from '@/core/assets';
import {listOperators, updateOperator, operatorScanBounded} from '@/vault/delegate';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {CopyAddress} from '@/components/CopyAddress';
import {shortAddress} from '@/core/format';
import {useColors, useStyles, type Colors} from '@/theme';

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/**
 * Payout operators (Settings › Team) — addresses that can propose payments (and tidy up sends) for the
 * owner to approve; they cannot move funds on their own. All writes gasless, Face-ID-gated on-device.
 * The asset manager is set from a dialog on the Settings row itself (useAssetManagerRow).
 */
export function DelegationScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const account = useWallet((s) => s.account);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = ASSETS[network].find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [ops, setOps] = useState<Address[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);

  const [op, setOp] = useState('');

  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!vault) return;
    setOpsLoading(true);
    listOperators(vault, network)
      .then(setOps)
      .finally(() => setOpsLoading(false));
  }, [vault, network]);
  useEffect(load, [load]);

  const {ask, sheet} = useConfirmAction();

  const run = async (
    key: string,
    title: string,
    fn: (acct: Awaited<ReturnType<typeof getSigner>>) => Promise<string>,
  ): Promise<boolean> => {
    if (!vault || !stable) return false;
    setBusy(key);
    const tx = showTx(title, network);
    try {
      const acct = await getSigner();
      tx.success(await fn(acct));
      load();
      return true;
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const onAddOp = () => {
    if (!isAddress(op)) return;
    run('add-op', t('vault.add_payout_operator'), (acct) =>
      updateOperator({account: acct, vault: vault!, network, operator: op as Address, add: true, stableCoin: stable!.address}),
    ).then((ok) => ok && setOp(''));
  };

  // Removing an operator is a relayed write and a mis-tap on a row would have sent it, so it asks.
  const onRemoveOp = (addr: Address) =>
    ask({
      title: `${t('vault.remove')} · ${t('vault.payout_operators')}`,
      message: shortAddress(addr),
      gas: relayGasFor({}),
      run: () =>
        run(`rm-${addr}`, `${t('vault.remove')} · ${t('vault.payout_operators')}`, (acct) =>
          updateOperator({account: acct, vault: vault!, network, operator: addr, add: false, stableCoin: stable!.address}),
        ).then(() => undefined),
    });

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <Text style={styles.hint}>{t('mobile.vault.payout_operators_hint')}</Text>

      {opsLoading ? (
        <Text style={styles.none}>{t('vault.loading')}</Text>
      ) : ops.length > 0 ? (
        ops.map((a) => (
          <View key={a} style={styles.item}>
            <CopyAddress address={a} label={short(a)} textStyle={styles.mono} />
            <Pressable
              disabled={busy !== null}
              onPress={() => onRemoveOp(a)}
              style={[styles.smBtn, styles.rmBtn]}>
              <Text style={styles.rmText}>{busy === `rm-${a}` ? '…' : t('vault.remove')}</Text>
            </Pressable>
          </View>
        ))
      ) : (
        <Text style={styles.none}>{t('vault.no_payout_operators')}</Text>
      )}
      {operatorScanBounded ? (
        <Text style={styles.fine}>{t('mobile.vault.recent_operators_only')}</Text>
      ) : null}

      <Text style={styles.label}>{t('vault.add_payout_operator')}</Text>
      <TextInput
        style={[styles.input, op.length > 0 && !isAddress(op) && styles.inputErr]}
        placeholder={t('mobile.vault.enter_address')}
        placeholderTextColor={c.subtext}
        autoCapitalize="none"
        autoCorrect={false}
        value={op}
        onChangeText={setOp}
      />
      <ConfirmButton onPress={onAddOp} disabled={!account || !vault || !stable || !isAddress(op) || busy !== null} />
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  body: {flexGrow: 1, padding: 20, paddingBottom: 24, gap: 10},
  hint: {color: c.subtext, fontSize: 13, lineHeight: 18},
  label: {color: c.subtext, fontSize: 13, fontWeight: '600', marginTop: 8},
  none: {color: c.subtext, fontSize: 14, fontStyle: 'italic', marginVertical: 4},
  fine: {color: c.subtext, fontSize: 11, marginTop: 2},
  card: {backgroundColor: c.card, borderRadius: 20, padding: 14, gap: 4},
  pending: {borderWidth: 1, borderColor: c.accent},
  cardLabel: {color: c.subtext, fontSize: 11, fontWeight: '700'},
  cardSub: {color: c.subtext, fontSize: 12},
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.card,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  mono: {color: c.text, fontSize: 14, fontFamily: 'Menlo'},
  smBtn: {paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, alignSelf: 'flex-start', marginTop: 6},
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
});

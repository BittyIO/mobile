import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View, ScrollView} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {RouteProp} from '@react-navigation/native';
import {useRoute} from '@react-navigation/native';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {AmountInput, exceedsMax} from '@/components/AmountInput';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {ownerVaultAddress, balanceOfSymbol} from '@/vault/read';
import {depositToProtocol, withdrawFromProtocol} from '@/vault/actions';
import {ASSETS} from '@/core/assets';
import {TokenIcon} from '@/components/TokenIcon';
import {adapterByName} from '@/core/protocols';
import type {RootStackParamList} from '@/App';
import {useStyles, type Colors} from '@/theme';
import {displaySymbol, fmtNum} from '@/core/format';
import {useT} from '@/i18n';

/**
 * Deposit / Withdraw. `route.params.mode` picks the action. When protocol+asset are passed (a
 * per-position withdraw from the Earn/Lend list) it targets THAT position; otherwise it's the default
 * Sky stable-coin flow with a coin picker. Signed in-app, gasless.
 */
export function EarnActionScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const {params} = useRoute<RouteProp<RootStackParamList, 'EarnAction'>>();
  const isDeposit = params.mode === 'deposit';
  const specific = !!(params.protocol && params.asset);

  const account = useWallet((s) => s.account);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);

  const stablecoins = ASSETS[network].filter((a) => a.kind === 'stable');
  const [coin, setCoin] = useState(stablecoins[0]?.symbol ?? 'USDC');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const selected = stablecoins.find((s) => s.symbol === coin) ?? stablecoins[0];
  const protocol = specific
    ? (params.protocol as `0x${string}`)
    : adapterByName(network, 'Sky');
  const targetAsset = specific ? (params.asset as `0x${string}`) : selected?.address;
  const targetDecimals = specific ? params.decimals ?? 18 : selected?.decimals ?? 18;
  const targetSymbol = specific ? params.symbol ?? 'token' : coin;
  const feeCoin = selected?.address ?? targetAsset; // relay fee always paid in a stable coin
  const bal = useVaultBalances(network);
  // Deposit max = free balance of the coin; withdraw max = the position's amount (passed in params).
  const max = isDeposit ? balanceOfSymbol(bal.balances, targetSymbol) : params.max;
  const canSubmit =
    !!account && !!owner && !!protocol && !!targetAsset && !!feeCoin && Number(amount) > 0 && status !== 'busy' && !exceedsMax(amount, max);

  const onSubmit = async () => {
    if (!account || !owner || !protocol || !targetAsset || !feeCoin) return;
    setStatus('busy');
    setErr(null);
    const tx = showTx(`${title} · ${amount} ${displaySymbol(targetSymbol)}`, network);
    try {
      const acct = await getSigner();
      const vault = ownerVaultAddress(owner, network);
      const run = isDeposit ? depositToProtocol : withdrawFromProtocol;
      const h = await run({
        account: acct,
        vault,
        network,
        protocol,
        asset: targetAsset,
        amount,
        decimals: targetDecimals,
        stableCoin: feeCoin,
      });
      tx.success(h);
      setStatus('done');
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      tx.error(msg);
      setErr(msg);
      setStatus('error');
    }
  };

  const title = t(isDeposit ? 'mobile.home.deposit_to' : 'mobile.home.withdraw_from', {name: specific ? targetSymbol : 'Sky'});

  return (
    <View style={styles.container}>
      {/* Scrolls (and bounces) like every other page, with the button held at the bottom. */}
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <View style={styles.body}>
        <Text style={styles.label}>{title}</Text>

        {!specific ? (
          <View style={styles.coins}>
            {stablecoins.map((s) => {
              const on = s.symbol === coin;
              return (
                <Pressable
                  key={s.symbol}
                  onPress={() => setCoin(s.symbol)}
                  style={[styles.coin, on && styles.coinOn]}>
                  <TokenIcon symbol={s.symbol} size={18} />
                  <Text style={[styles.coinText, on && styles.coinTextOn]}>{displaySymbol(s.symbol)}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <AmountInput
          value={amount}
          onChangeText={setAmount}
          placeholder={t('vault.amount')}
          max={max}
          maxLabel={max ? `${fmtNum(Number(max))} ${displaySymbol(targetSymbol)}` : undefined}
        />


        {status === 'error' && err ? <Text style={styles.err}>{err}</Text> : null}
      </View>
      </ScrollView>

      <SafeAreaView edges={['bottom']} style={styles.footer}>
      <ConfirmButton onPress={onSubmit} disabled={!canSubmit} />
      </SafeAreaView>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  flex: {flex: 1},
  footer: {padding: 20, paddingTop: 8},
  scroll: {flexGrow: 1, padding: 20},
  body: {gap: 14},
  label: {color: c.text, fontSize: 18, fontWeight: '700'},
  coins: {flexDirection: 'row', gap: 10},
  coin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  coinOn: {borderColor: c.accent, backgroundColor: c.accentSoft},
  coinText: {color: c.subtext, fontSize: 15, fontWeight: '600'},
  coinTextOn: {color: c.text},
  input: {
    height: 44,
    borderRadius: 10,
    backgroundColor: c.input,
    color: c.text,
    paddingHorizontal: 12,
    fontSize: 17,
  },
  hint: {color: c.subtext, fontSize: 13, lineHeight: 18},
  ok: {color: c.success, fontSize: 13, fontFamily: 'Menlo'},
  err: {color: c.danger, fontSize: 13},
});

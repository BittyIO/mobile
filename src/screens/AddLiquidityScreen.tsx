import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {ConfirmButton} from '@/components/Button';
import {showTx} from '@/components/Toast';
import {AmountInput, exceedsMax} from '@/components/AmountInput';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {ownerVaultAddress, balanceOfSymbol} from '@/vault/read';
import {addLiquidityFullRange} from '@/vault/lp-actions';
import {ASSETS} from '@/core/assets';
import {useStyles, type Colors} from '@/theme';
import {displaySymbol, fmtNum} from '@/core/format';
import {useT} from '@/i18n';

const FEE_TIERS = [500, 3000, 10000] as const;

/**
 * Add full-range liquidity to a Uniswap V3 pair via the vault's AMM adapter, relayed gaslessly. No
 * price-range picker — liquidity spans the whole range, so the user just provides both amounts.
 */
export function AddLiquidityScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const account = useWallet((s) => s.account);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const assets = ASSETS[network];

  const [aSym, setASym] = useState('WETH');
  const [bSym, setBSym] = useState('USDC');
  const [fee, setFee] = useState<number>(3000);
  const [amtA, setAmtA] = useState('');
  const [amtB, setAmtB] = useState('');
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const bal = useVaultBalances(network);
  const tokenA = assets.find((a) => a.symbol === aSym);
  const tokenB = assets.find((a) => a.symbol === bSym);
  const stable = assets.find((a) => a.kind === 'stable');
  const canSubmit =
    !!account && !!owner && !!tokenA && !!tokenB && !!stable && aSym !== bSym &&
    Number(amtA) > 0 && Number(amtB) > 0 && status !== 'busy' &&
    !exceedsMax(amtA, balanceOfSymbol(bal.balances, aSym)) && !exceedsMax(amtB, balanceOfSymbol(bal.balances, bSym));

  const onSubmit = async () => {
    if (!account || !owner || !tokenA || !tokenB || !stable) return;
    setStatus('busy');
    setErr(null);
    const tx = showTx(`${t('vault.add_liquidity')} ${displaySymbol(aSym)}/${displaySymbol(bSym)}`, network);
    try {
      const acct = await getSigner();
      const vault = ownerVaultAddress(owner, network);
      const h = await addLiquidityFullRange({
        account: acct,
        vault,
        network,
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        amountA: amtA,
        amountB: amtB,
        fee,
        stableCoin: stable.address,
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

  const TokenRow = ({value, onChange}: {value: string; onChange: (s: string) => void}) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
      {assets.map((a) => {
        const on = a.symbol === value;
        return (
          <Pressable key={a.symbol} onPress={() => onChange(a.symbol)} style={[styles.chip, on && styles.chipOn]}>
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{displaySymbol(a.symbol)}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.flex} contentContainerStyle={styles.body}>
        <Text style={styles.label}>{t('mobile.home.token_a')}</Text>
        <TokenRow value={aSym} onChange={setASym} />
        <AmountInput
          value={amtA}
          onChangeText={setAmtA}
          placeholder={t('mobile.home.amount_in', {symbol: aSym})}
          max={balanceOfSymbol(bal.balances, aSym)}
          maxLabel={bal.balances ? `${fmtNum(Number(balanceOfSymbol(bal.balances, aSym)))} ${displaySymbol(aSym)}` : undefined}
        />

        <Text style={styles.label}>{t('mobile.home.token_b')}</Text>
        <TokenRow value={bSym} onChange={setBSym} />
        <AmountInput
          value={amtB}
          onChangeText={setAmtB}
          placeholder={t('mobile.home.amount_in', {symbol: bSym})}
          max={balanceOfSymbol(bal.balances, bSym)}
          maxLabel={bal.balances ? `${fmtNum(Number(balanceOfSymbol(bal.balances, bSym)))} ${displaySymbol(bSym)}` : undefined}
        />

        <Text style={styles.label}>{t('vault.fee_tier')}</Text>
        <View style={styles.fees}>
          {FEE_TIERS.map((f) => (
            <Pressable key={f} onPress={() => setFee(f)} style={[styles.chip, fee === f && styles.chipOn]}>
              <Text style={[styles.chipText, fee === f && styles.chipTextOn]}>{(f / 10000).toFixed(2)}%</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.hint}>{t('mobile.home.lp_hint')}</Text>

        {status === 'error' && err ? <Text style={styles.err}>{err}</Text> : null}
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
  body: {flexGrow: 1, padding: 20, gap: 10, paddingBottom: 16},
  label: {color: c.subtext, fontSize: 13, fontWeight: '600', marginTop: 8},
  chips: {gap: 8, paddingVertical: 2},
  fees: {flexDirection: 'row', gap: 8},
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  chipOn: {borderColor: c.accent, backgroundColor: c.accentSoft},
  chipText: {color: c.subtext, fontSize: 14, fontWeight: '600'},
  chipTextOn: {color: c.text},
  input: {
    height: 44,
    borderRadius: 10,
    backgroundColor: c.input,
    color: c.text,
    paddingHorizontal: 12,
    fontSize: 17,
  },
  hint: {color: c.subtext, fontSize: 13, lineHeight: 18, marginTop: 4},
  ok: {color: c.success, fontSize: 13, fontFamily: 'Menlo'},
  err: {color: c.danger, fontSize: 13},
});

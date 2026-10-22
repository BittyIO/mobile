import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {zeroAddress, type Address} from 'viem';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {getAutoYields, setAutoYield} from '@/vault/autoyield';
import {triggerAutoYield} from '@/vault/risk';
import {assetMeta} from '@/core/assets';
import {TokenIcon} from '@/components/TokenIcon';
import {yieldAdapters} from '@/core/protocols';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {useStyles, type Colors} from '@/theme';
import {displaySymbol} from '@/core/format';
import {useAssetCatalog} from '@/core/asset-catalog';

/**
 * Auto-yield — pick a default yield protocol per asset. Idle balances of that asset are swept into the
 * protocol by the keeper, so deposits earn without a manual step. "None" clears the route. Relayed.
 */
export function AutoYieldScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const assets = useAssetCatalog(network);
  const yields = yieldAdapters(network);
  const stable = assets.find((a) => a.kind === 'stable');
  const vault = useActiveVaultAddress(network);

  const [routes, setRoutes] = useState<Map<string, Address>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (vault) getAutoYields(vault, network, assets.map((a) => a.address)).then(setRoutes);
  }, [vault, network]);
  useEffect(load, [load]);

  // Only offer protocols that can actually take the asset.
  const optionsFor = (sym: string) =>
    yields.filter((y) => {
      const n = y.name.toLowerCase();
      if (n.includes('sky')) return sym === 'USDC';
      if (n.includes('lido')) return sym === 'WETH';
      return true; // Aave etc.
    });

  const {ask, sheet} = useConfirmAction();

  // Both of these are relayed writes reached from a plain row, so each asks before it signs.
  const askSet = (asset: Address, protocol: Address, key: string, label: string) =>
    ask({
      title: t('mobile.actions.auto_yield_set', {token: assetMeta(network, asset).symbol}),
      message: label,
      gas: relayGasFor({}),
      run: () => onSet(asset, protocol, key),
    });
  const askSweep = (asset: Address, key: string) =>
    ask({
      title: t('mobile.vault.sweep_now'),
      message: assetMeta(network, asset).symbol,
      gas: relayGasFor({supply: 1}),
      run: () => onSweep(asset, key),
    });

  const onSet = async (asset: Address, protocol: Address, key: string) => {
    if (!vault || !stable) return;
    setBusy(key);
    const tx = showTx(t('mobile.actions.auto_yield_set', {token: assetMeta(network, asset).symbol}), network);
    try {
      const acct = await getSigner();
      tx.success(await setAutoYield({account: acct, vault, network, asset, protocol, stableCoin: stable.address}));
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  // Manually sweep an asset's idle balance into its configured route now (the keeper does this
  // automatically; this forces it).
  const onSweep = async (asset: Address, key: string) => {
    if (!vault || !stable) return;
    setBusy(key);
    const tx = showTx(t('mobile.vault.sweep_now'), network);
    try {
      const acct = await getSigner();
      tx.success(await triggerAutoYield({account: acct, vault, network, asset, stableCoin: stable.address}));
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <Text style={styles.hint}>{t('mobile.vault.auto_yield_hint')}</Text>

      {assets.map((a) => {
        const current = routes.get(a.address.toLowerCase()) ?? zeroAddress;
        const opts = optionsFor(a.symbol);
        const noneOn = /^0x0+$/.test(current);
        return (
          <View key={a.address} style={styles.row}>
            <View style={styles.symRow}>
              <TokenIcon symbol={a.symbol} size={20} />
              <Text style={styles.sym}>{displaySymbol(a.symbol)}</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              <Pressable
                disabled={busy !== null}
                onPress={() => askSet(a.address, zeroAddress, `${a.symbol}-none`, t('vault.none'))}
                style={[styles.chip, noneOn && styles.chipOn]}>
                <Text style={[styles.chipText, noneOn && styles.chipTextOn]}>
                  {busy === `${a.symbol}-none` ? '…' : t('vault.none')}
                </Text>
              </Pressable>
              {opts.map((y) => {
                const on = y.address.toLowerCase() === current.toLowerCase();
                const key = `${a.symbol}-${y.address}`;
                return (
                  <Pressable
                    key={y.address}
                    disabled={busy !== null}
                    onPress={() => askSet(a.address, y.address, key, y.name)}
                    style={[styles.chip, on && styles.chipOn]}>
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>
                      {busy === key ? '…' : y.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
              {!noneOn ? (
                <Pressable
                  disabled={busy !== null}
                  onPress={() => askSweep(a.address, `${a.symbol}-sweep`)}
                  style={styles.sweepBtn}>
                  <Text style={styles.sweepText}>
                    {busy === `${a.symbol}-sweep` ? t('mobile.vault.sweeping') : t('mobile.vault.sweep_now')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  body: {flexGrow: 1, padding: 20, paddingBottom: 20, gap: 14},
  hint: {color: c.subtext, fontSize: 14, lineHeight: 20},
  row: {gap: 8},
  symRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  sym: {color: c.text, fontSize: 15, fontWeight: '700'},
  chips: {gap: 8, paddingVertical: 2},
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
  sweepBtn: {alignSelf: 'flex-start', paddingVertical: 4},
  sweepText: {color: c.accent, fontSize: 13, fontWeight: '600'},
});

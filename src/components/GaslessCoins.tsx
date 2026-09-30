import React, {useCallback, useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {Address} from 'viem';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {isActivated} from '@/vault/activate';
import {getGaslessConfig, setGaslessCoins, disableGasless, GASLESS_MAX_DAILY, GASLESS_MAX_PER_OP, type GaslessConfig} from '@/vault/gasless';
import {ASSETS} from '@/core/assets';
import {TokenIcon} from '@/components/TokenIcon';
import {PendingSwitch} from '@/components/PendingSwitch';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {useStyles, type Colors} from '@/theme';
import {displaySymbol} from '@/core/format';

/**
 * Gasless config as one section card — which stable coins may pay the relay fee. Empty allowlist = any
 * coin (the default); turning them all off disables relaying. Mobile always relays (no wallet
 * fallback), so this is the only gasless control it needs. Each change is itself a gasless, Face-ID-
 * gated write. Rendered inline on the Services page.
 */
export function GaslessCoins() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stablecoins = ASSETS[network].filter((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [cfg, setCfg] = useState<GaslessConfig | null | 'loading'>('loading');
  // Deployed yet? A counterfactual vault has no config to read: it shows the defaults it will start
  // with, and the coin that will pay its activation fee.
  const [activated, setActivated] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Changing a fee coin is a relayed write, so it asks before it signs like everything else.
  const {ask, sheet} = useConfirmAction();

  const load = useCallback(() => {
    if (!vault) return;
    isActivated(vault, network).then(setActivated).catch(() => setActivated(null));
    getGaslessConfig(vault, network).then(setCfg);
  }, [vault, network]);
  useEffect(load, [load]);

  // Before activation every gasless setting is the system default: any stablecoin, $100/day, $10/op.
  const DEFAULTS: GaslessConfig = {
    stableCoins: [],
    dailyLimit: BigInt(GASLESS_MAX_DAILY),
    maxFeePerOp: BigInt(GASLESS_MAX_PER_OP),
    remaining: BigInt(GASLESS_MAX_DAILY) * BigInt(10) ** BigInt(18),
    usedToday: BigInt(0),
    configured: true,
  };
  const preActivation = activated === false;

  const allowed = (coin: Address): boolean => {
    if (preActivation) return true;
    if (cfg === 'loading' || cfg === null) return false;
    return cfg.stableCoins.length === 0 || cfg.stableCoins.some((c) => c.toLowerCase() === coin.toLowerCase());
  };

  const onToggle = async (coin: Address, on: boolean) => {
    if (!vault || cfg === 'loading' || cfg === null) return;
    const allCoins = stablecoins.map((a) => a.address);
    const current = cfg.stableCoins.length ? cfg.stableCoins : allCoins;
    const next = on
      ? [...current, coin]
      : current.filter((c) => c.toLowerCase() !== coin.toLowerCase());

    setBusy(coin);
    const tx = showTx(`${displaySymbol(stablecoins.find((s) => s.address === coin)?.symbol ?? '')} · ${t('mobile.settings.gas_token')}`, network);
    try {
      const acct = await getSigner();
      const fee = stablecoins[0]?.address ?? coin;
      if (next.length === 0) {
        tx.success(await disableGasless({account: acct, vault, network, stableCoin: fee}));
      } else {
        // Covering every coin IS the default — write [] to leave it un-narrowed (cheaper).
        const coversAll = allCoins.every((c) => next.some((n) => n.toLowerCase() === c.toLowerCase()));
        tx.success(
          await setGaslessCoins({
            account: acct,
            vault,
            network,
            coins: (coversAll ? [] : next) as Address[],
            dailyLimit: cfg.dailyLimit,
            maxFeePerOp: cfg.maxFeePerOp,
            stableCoin: fee,
          }),
        );
      }
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  // Nothing is writable until the vault exists; its first action activates it with the defaults.
  const locked = preActivation || busy !== null;

  const rows = stablecoins.length;
  return (
    <View style={styles.wrap}>
      <View style={styles.group}>
        {stablecoins.map((a, i) => (
          <View key={a.address} style={[styles.row, i === 0 && styles.rowFirst, i === rows - 1 && styles.rowLast]}>
            <View style={styles.symRow}>
              <TokenIcon symbol={a.symbol} size={22} />
              <Text style={styles.sym}>{displaySymbol(a.symbol)}</Text>
            </View>
            <PendingSwitch
              value={allowed(a.address)}
              pending={busy === a.address}
              disabled={locked || cfg === 'loading'}
              onValueChange={(v) =>
                ask({
                  title: t('mobile.settings.gas_token'),
                  message: `${displaySymbol(a.symbol)} · ${t(v ? 'vault.enabled' : 'vault.disabled')}`,
                  gas: relayGasFor({}),
                  run: () => onToggle(a.address, v),
                })
              }
            />
          </View>
        ))}
      </View>
      {sheet}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {gap: 8},
    
    // The same section card as the allow lists: the card carries the side padding, rows draw a hairline
    // on their top edge, and the first/last rows drop their outer padding.
    group: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 12,
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    rowFirst: {borderTopWidth: 0, paddingTop: 16},
    rowLast: {paddingBottom: 16},
    symRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
    sym: {color: c.text, fontSize: 15, fontWeight: '600'},
    busy: {color: c.subtext, fontSize: 16},
  });

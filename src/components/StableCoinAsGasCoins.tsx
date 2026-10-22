import React, {useCallback, useEffect, useState} from 'react';
import {Animated, Pressable, StyleSheet, Text, View} from 'react-native';
import type {Address} from 'viem';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {isActivated} from '@/vault/activate';
import {getStableCoinAsGasConfig, setStableCoinAsGasCoins, STABLE_COIN_AS_GAS_MAX_DAILY, STABLE_COIN_AS_GAS_MAX_PER_OP, type StableCoinAsGasConfig} from '@/vault/stableCoinAsGas';

import {TokenIcon} from '@/components/TokenIcon';
import {PendingSwitch} from '@/components/PendingSwitch';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {useStyles, type Colors} from '@/theme';
import {displaySymbol} from '@/core/format';
import {useAssetCatalog} from '@/core/asset-catalog';
import {inFeeCoinOrder, setFeeCoinOrder} from '@/core/prefs';
import {useReorder} from '@/components/useReorder';

/**
 * StableCoinAsGas config as one section card — which stable coins (and the vault's WETH, from v1.0.2) may pay the relay fee. Empty allowlist = any
 * coin (the default); turning them all off disables relaying. Mobile always relays (no wallet
 * fallback), so this is the only stablecoin-as-gas control it needs. Each change is itself a gasless, Face-ID-
 * gated write. Rendered inline on the Services page.
 */
/**
 * `onDragging` lets the page stop scrolling while a coin is in hand: the rows are long-press-and-drag
 * to set the order of preference (see {feeCoinOrder}) — the first is the coin the relayer is asked
 * to bill and the first to hold the fee reserve.
 */
export function StableCoinAsGasCoins({
  onDragging,
  trailing,
}: {
  onDragging: (active: boolean) => void;
  /**
   * A row drawn after the coins in the same card — the page's fee reserve, which is held in the
   * first of these coins and so belongs with them. Not draggable: it is not a coin.
   */
  trailing?: {title: string; value: string; onPress: () => void};
}) {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stablecoins = useAssetCatalog(network).filter((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const [cfg, setCfg] = useState<StableCoinAsGasConfig | null | 'loading'>('loading');
  // Deployed yet? A counterfactual vault has no config to read: it shows the defaults it will start
  // with, and the coin that will pay its activation fee.
  const [activated, setActivated] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Changing a fee coin is a relayed write, so it asks before it signs like everything else.
  const {ask, sheet} = useConfirmAction();

  const load = useCallback(() => {
    if (!vault) return;
    isActivated(vault, network).then(setActivated).catch(() => setActivated(null));
    getStableCoinAsGasConfig(vault, network).then(setCfg);
  }, [vault, network]);
  useEffect(load, [load]);

  // Before activation every stablecoin-as-gas setting is the system default: any stablecoin, $100/day, $10/op.
  const DEFAULTS: StableCoinAsGasConfig = {
    stableCoins: [],
    dailyLimit: BigInt(STABLE_COIN_AS_GAS_MAX_DAILY),
    maxFeePerOp: BigInt(STABLE_COIN_AS_GAS_MAX_PER_OP),
    remaining: BigInt(STABLE_COIN_AS_GAS_MAX_DAILY) * BigInt(10) ** BigInt(18),
    usedToday: BigInt(0),
    configured: true,
    weth: null,
  };
  const preActivation = activated === false;
  /** A config was actually read. Anything else — still loading, or unreadable — is not an answer. */
  const known = cfg !== 'loading' && cfg !== null;
  // From v1.0.2 the vault's WETH pays too, and an empty allowlist covers it along with the stablecoins.
  const listed = known && cfg.weth ? [...stablecoins, {address: cfg.weth, symbol: 'WETH'}] : stablecoins;
  // The order is local and the owner's, so it can be set before activation, and re-read on a drop.
  const [, setOrdered] = useState(0);
  const coins = inFeeCoinOrder(network, vault, listed);
  const drag = useReorder({
    items: coins,
    enabled: true,
    onReorder: (next) => {
      setFeeCoinOrder(network, vault, next.map((a) => a.symbol));
      setOrdered((n) => n + 1);
    },
    onDragging,
  });

  /**
   * Unknown is not "none".
   *
   * An empty allowlist means ANY coin to the contract, and that is what a vault is born with, so
   * every state where there is no config to read shows every coin on: before activation, while
   * the chain is still answering, and when the read failed. It used to return false for those,
   * which drew each switch OFF — on a chain with a single fee coin, like Robinhood's USDG, that
   * said the vault had no way to pay for anything, and on a slow endpoint it said it for as long
   * as the read took. Nothing can be WRITTEN in those states either (see `locked`), so this only
   * decides what is shown.
   */
  const allowed = (coin: Address): boolean => {
    if (!known) return true;
    return cfg.stableCoins.length === 0 || cfg.stableCoins.some((c) => c.toLowerCase() === coin.toLowerCase());
  };

  const onToggle = async (coin: Address, on: boolean) => {
    if (!vault || cfg === 'loading' || cfg === null) return;
    const allCoins = coins.map((a) => a.address);
    const current = cfg.stableCoins.length ? cfg.stableCoins : allCoins;
    const next = on
      ? [...current, coin]
      : current.filter((c) => c.toLowerCase() !== coin.toLowerCase());
    /**
     * The last coin cannot be turned off.
     *
     * An empty allowlist does not mean "no coins" to the contract, it means relaying is OFF — and
     * relaying is how this app signs everything. A vault with no fee coin cannot trade, deposit,
     * send or even cancel; the only way back would be a wallet this app does not have. The switch
     * for the last one is disabled, and this is the same rule where the write happens, so no
     * future caller can route around the UI.
     */
    if (next.length === 0) return;

    setBusy(coin);
    const tx = showTx(`${displaySymbol(coins.find((s) => s.address === coin)?.symbol ?? '')} · ${t('mobile.settings.gas_token')}`, network);
    try {
      const acct = await getSigner();
      const fee = stablecoins[0]?.address ?? coin;
      // Covering every coin IS the default — write [] to leave it un-narrowed (cheaper).
      const coversAll = allCoins.every((c) => next.some((n) => n.toLowerCase() === c.toLowerCase()));
      tx.success(
        await setStableCoinAsGasCoins({
          account: acct,
          vault,
          network,
          coins: (coversAll ? [] : next) as Address[],
          dailyLimit: cfg.dailyLimit,
          maxFeePerOp: cfg.maxFeePerOp,
          stableCoin: fee,
        }),
      );
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  // Nothing is writable until the vault exists and its config has been read: its first action
  // activates it with the defaults, and a switch cannot narrow a list nobody has seen yet.
  const locked = !known || preActivation || busy !== null;

  const rows = coins.length;
  const onCount = coins.filter((a) => allowed(a.address)).length;
  return (
    <View style={styles.wrap}>
      <View style={styles.group}>
        {coins.map((a, i) => (
          <Animated.View
            key={a.address}
            {...drag.rowProps(i)}
            style={[
              styles.row,
              i === 0 && styles.rowFirst,
              i === rows - 1 && !trailing && styles.rowLast,
              drag.from === i && styles.lifted,
              drag.rowProps(i).style,
            ]}>
            <View style={styles.symRow}>
              <TokenIcon symbol={a.symbol} size={22} />
              <Text style={styles.sym}>{displaySymbol(a.symbol)}</Text>
            </View>
            <PendingSwitch
              value={allowed(a.address)}
              pending={busy === a.address}
              // The last one on cannot be turned off: see onToggle.
              disabled={locked || (allowed(a.address) && onCount <= 1)}
              onValueChange={(v) =>
                ask({
                  title: t('mobile.settings.gas_token'),
                  message: `${displaySymbol(a.symbol)} · ${t(v ? 'vault.enabled' : 'vault.disabled')}`,
                  gas: relayGasFor({}),
                  run: () => onToggle(a.address, v),
                })
              }
            />
          </Animated.View>
        ))}
        {trailing ? (
          <Pressable style={[styles.row, styles.rowLast, rows === 0 && styles.rowFirst]} onPress={trailing.onPress}>
            <Text style={styles.sym}>{trailing.title}</Text>
            <View style={styles.trailingValue}>
              <Text style={styles.value}>{trailing.value}</Text>
              <Text style={styles.chev}>›</Text>
            </View>
          </Pressable>
        ) : null}
      </View>
      {/* Said before the switch is reached for, not after it refuses. */}
      {onCount <= 1 ? <Text style={styles.minNote}>{t('mobile.settings.gas_token_min')}</Text> : null}
      {sheet}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {gap: 8},
    minNote: {color: c.subtext, fontSize: 12, lineHeight: 17, paddingHorizontal: 4},
    
    // The same section card as the allow lists: the card carries the side padding, rows draw a hairline
    // on their top edge, and the first/last rows drop their outer padding.
    group: {backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 16},
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 12,
      // A switch fills its box exactly, where a chevron's glyph sits a few points inside one, so
      // without this it reads as nearer the edge than every other row in the app.
      paddingRight: 10,
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    rowFirst: {borderTopWidth: 0, paddingTop: 16},
    rowLast: {paddingBottom: 16},
    symRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
    sym: {color: c.text, fontSize: 15, fontWeight: '600'},
    busy: {color: c.subtext, fontSize: 16},
    trailingValue: {flexDirection: 'row', alignItems: 'center', gap: 6},
    value: {color: c.subtext, fontSize: 14},
    chev: {color: c.subtext, fontSize: 22, fontWeight: '300'},
    // The coin in hand, as the watch lists lift theirs.
    lifted: {
      zIndex: 2,
      elevation: 6,
      marginHorizontal: -16,
      paddingHorizontal: 16,
      paddingRight: 26,
      backgroundColor: c.cardAlt,
      shadowColor: '#000',
      shadowOpacity: 0.22,
      shadowRadius: 10,
      shadowOffset: {width: 0, height: 4},
    },
  });

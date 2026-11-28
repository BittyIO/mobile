import React, {useEffect, useRef, useState} from 'react';
import {useRefreshTick} from '@/components/useRefreshTick';
import {useWalletMode} from '@/core/account-mode';
import {StyleSheet, Text, View} from 'react-native';
import {GasIcon} from '@/components/GasIcon';
import {useNetwork} from '@/core/network-store';
import {quoteOwnerFeeWei, quoteRelayFeeUsd, quoteTronRelayFeeSun, TYPICAL_RELAY_GAS} from '@/vault/fee-quote';
import {formatNative} from '@/vault/direct';
import {NATIVE} from '@/core/chain';
import {Amount} from '@/components/Amount';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {isActivated, keyCanActivate, planKeyActivation, priceActivation} from '@/vault/activate';
import {useWallet} from '@/wallet/store';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useActiveVaultAddress} from '@/core/active-vault';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

// Quotes are shared across every confirm surface and go stale slowly, so one read per network per
// minute is plenty. Without this each sheet opening re-read gas and the price feed.
const TTL_MS = 60_000;
const cache = new Map<string, {usd: number | null; at: number}>();
const ownerCache = new Map<string, {wei: bigint | null; at: number}>();

/**
 * The fee line above every Face ID confirm: a fuel pump and a figure, no words.
 *
 * Renders nothing at all when the quote cannot be read, because a blank is better than a wrong
 * number on the one line whose job is to prevent a surprise.
 *
 * `free` is for an action that sends no transaction — a CoW order on a vault that is already set up
 * is signed and posted off-chain, and costs nothing. That states the zero instead of quoting gas
 * for a relay that will not happen, and instead of hiding the line, which left the user to guess
 * whether the fee was nil or merely unknown.
 *
 * When the owner pays (see core/fee-payer-store) the figure is in ETH, because that is what leaves
 * the owner wallet — no dollar conversion, and no relayer margin, since no relayer is paid.
 */
export function NetworkFee({gas = TYPICAL_RELAY_GAS, free, usd, noIcon}: {gas?: bigint; free?: boolean; usd?: number; /** No gas mark: the activation's fee, labelled in words instead. */ noIcon?: boolean}) {
  const network = useNetwork((s) => s.network);
  const {payer} = useActiveFeePayer(network);
  // Already priced by the caller (an activation's own network fee): shown as it is.
  if (usd != null && !free) return <KnownFee usd={usd} noIcon={noIcon} />;
  if (payer === 'owner' && !free) return <OwnerFee gas={gas} noIcon={noIcon} />;
  return <VaultFee gas={gas} free={free} noIcon={noIcon} />;
}

/** The fee in ETH, from the owner wallet. */
function OwnerFee({gas, noIcon}: {gas: bigint; noIcon?: boolean}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const network = useNetwork((s) => s.network);
  const key = `${network}:${gas}`;
  const [wei, setWei] = useState<bigint | null>(() => {
    const hit = ownerCache.get(key);
    return hit && Date.now() - hit.at < TTL_MS ? hit.wei : null;
  });
  // Asked again every few seconds while on screen; the figure stays up until the new one is in.
  const tick = useRefreshTick();
  useEffect(() => {
    const hit = ownerCache.get(key);
    if (tick === 0 && hit && Date.now() - hit.at < TTL_MS) {
      setWei(hit.wei);
      return;
    }
    let live = true;
    quoteOwnerFeeWei(network, gas).then((v) => {
      ownerCache.set(key, {wei: v, at: Date.now()});
      if (live) setWei(v);
    });
    return () => {
      live = false;
    };
  }, [key, network, gas, tick]);
  if (wei == null) return null;
  return (
    <View style={styles.row}>
      {noIcon ? null : <GasIcon color={c.subtext} />}
      <Text style={styles.line}>
        <Amount v={formatNative(network, wei)} size={12} color={c.subtext} /> {NATIVE[network].symbol}
      </Text>
    </View>
  );
}

/** The fee in dollars, billed to the vault by the relayer. */
function VaultFee({gas, free, noIcon}: {gas: bigint; free?: boolean; noIcon?: boolean}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const network = useNetwork((s) => s.network);
  const key = `${network}:${gas}`;
  const [usd, setUsd] = useState<number | null>(() => {
    const hit = cache.get(key);
    return hit && Date.now() - hit.at < TTL_MS ? hit.usd : null;
  });

  const tick = useRefreshTick();
  useEffect(() => {
    if (free) return;
    const hit = cache.get(key);
    if (tick === 0 && hit && Date.now() - hit.at < TTL_MS) {
      setUsd(hit.usd);
      return;
    }
    let live = true;
    quoteRelayFeeUsd(network, gas).then((v) => {
      cache.set(key, {usd: v, at: Date.now()});
      if (live) setUsd(v);
    });
    return () => {
      live = false;
    };
  }, [key, network, gas, free, tick]);

  if (free) {
    return (
      <View style={styles.row}>
        {noIcon ? null : <GasIcon color={c.subtext} />}
        <Text style={styles.line}>$0</Text>
      </View>
    );
  }
  if (usd == null) return null;
  return <KnownFee usd={usd} noIcon={noIcon} />;
}

/** A fee in dollars, beside the gas mark. */
function KnownFee({usd, noIcon}: {usd: number; noIcon?: boolean}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  // Sub-cent fees are the norm on an L2, so cents would print "$0.01" for everything and hide the
  // difference between a plain swap and one that unwinds two positions first. The switch to cents
  // waits until a dime, well clear of where L2 fees sit, so a heavier operation crossing one cent
  // does not suddenly lose the precision that made it comparable.
  const shown = usd >= 0.1 ? `$${usd.toFixed(2)}` : usd >= 0.0001 ? `$${usd.toFixed(4)}` : '<$0.0001';
  return (
    <View style={styles.row}>
      {noIcon ? null : <GasIcon color={c.subtext} />}
      <Text style={styles.line}>{shown}</Text>
    </View>
  );
}

/**
 * Whether the vault in front on this network will be activated by the next write the vault pays
 * for: not deployed yet, and the relayer paying (from the owner key the activation is the owner's
 * own gas, with no activation fee). False until the chain has answered.
 */
export function useActivationDue(): boolean {
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const {payer} = useActiveFeePayer(network);
  // The general wallet has nothing to activate: its sends are plain transfers, priced by the caller.
  const walletOn = useWalletMode(network);
  const [activated, setActivated] = useState<boolean | null>(null);
  useEffect(() => {
    setActivated(null);
    if (!vault) return;
    let live = true;
    isActivated(vault, network)
      .then((v) => live && setActivated(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vault, network]);
  return !walletOn && payer !== 'owner' && activated === false;
}


/**
 * Tron, before the smart wallet's first write: the activation's fee at the left, the operation's at
 * the right. Priced as the activation will be signed (priceActivation): in TRX when it is paid in TRX
 * — the smart wallet's own TRX (WTRX) or the owner key's — and then the operation's fee in TRX too,
 * since it is paid the same way; in dollars when a stablecoin pays.
 */
export function ActivationFees({gas, label}: {gas: bigint; label: string}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  const network = useNetwork((s) => s.network);
  const {payer} = useActiveFeePayer(network);
  const owner = useWallet((s) => s.address);
  const stable = useAssetCatalog(network).find((a) => a.kind === 'stable');
  const [price, setPrice] = useState<{trx: boolean; activation: string; op: string | null} | null>(null);
  const tick = useRefreshTick();
  const priceKey = useRef('');
  useEffect(() => {
    let live = true;
    const k = `${network}|${payer}|${owner}|${stable?.address}|${gas}`;
    // A refresh keeps the figures up until the new ones are in.
    if (priceKey.current !== k) setPrice(null);
    priceKey.current = k;
    if (!owner || !stable) return;
    (async () => {
      const sym0 = NATIVE[network].symbol;
      // The key activates on rented energy when it holds the TRX (vault/relay): all in TRX, the
      // operation riding on the activation at the rental's price for its energy.
      const key = await planKeyActivation({owner: owner as `0x${string}`, network}).catch(() => null);
      if (key && (await keyCanActivate(owner as `0x${string}`, network, key))) {
        // The operation rides on the activation, priced in it: its share at the activation's rate.
        const op = await quoteTronRelayFeeSun(network, gas);
        return {trx: true, activation: `${formatNative(network, key.costSun)} ${sym0}`, op: op == null ? null : `${formatNative(network, op)} ${sym0}`};
      }
      const p = await priceActivation({owner: owner as `0x${string}`, network, stableCoin: stable.address, allowlistEnabled: false, capped: false});
      const sym = NATIVE[network].symbol;
      if (payer === 'owner') {
        const op = await quoteOwnerFeeWei(network, gas);
        return {trx: true, activation: `${formatNative(network, BigInt(Math.round(p.feeNative * 10 ** NATIVE[network].decimals)))} ${sym}`, op: op == null ? null : `${formatNative(network, op)} ${sym}`};
      }
      if (p.weth) {
        const op = await quoteTronRelayFeeSun(network, gas);
        return {trx: true, activation: `${formatNative(network, p.feeAmount)} ${sym}`, op: op == null ? null : `${formatNative(network, op)} ${sym}`};
      }
      return {trx: false, activation: `$${p.feeUsd.toFixed(2)}`, op: null};
    })()
      .then((v) => live && setPrice(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [network, payer, owner, stable?.address, gas, tick]);
  return (
    <View style={styles.split}>
      <View style={styles.activation}>
        <Text style={styles.line}>{label}</Text>
        {price ? <Text style={styles.line}>{price.activation}</Text> : null}
      </View>
      {price?.trx ? (
        price.op ? (
          <View style={styles.row}>
            <GasIcon color={c.subtext} />
            <Text style={styles.line}>{price.op}</Text>
          </View>
        ) : null
      ) : (
        <NetworkFee gas={gas} />
      )}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5, paddingRight: 4},
    line: {color: c.subtext, fontSize: 12, fontVariant: ['tabular-nums']},
    split: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 4, paddingRight: 4},
    activation: {flexDirection: 'row', alignItems: 'center', gap: 6},
  });

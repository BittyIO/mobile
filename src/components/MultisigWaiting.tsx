import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {useIsFocused, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {decodeFunctionData, formatUnits, parseAbi, type Address, type Hex} from 'viem';
import type {RootStackParamList} from '@/App';
import {showTx} from '@/components/Toast';
import type {VaultRef} from '@/core/vault-store';
import {publicClientFor, type Network} from '@/core/chain';
import {FORWARDER_ABI} from '@/core/abi';
import {assetMeta} from '@/core/assets';
import {displaySymbol, fmtNum, shortAddress} from '@/core/format';
import {cosign, fetchSafe, listSafeMessages, type SafeInfo, type SafeMessageStatus} from '@/vault/safe';
import {finishSafeMessage} from '@/vault/safe-finish';
import {ownerVaultAddress} from '@/vault/read';
import {MMKV} from 'react-native-mmkv';
import {describeOwnerChange} from '@/vault/safe-owners';
import {describeActions} from '@/vault/tx-actions';
import {safeDeviceKey} from '@/wallet/store';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors, MONO} from '@/theme';

type T = ReturnType<typeof useT>['t'];

// The vault writes this app makes (core/abi), so a co-owner sees what they sign rather than a
// selector. Anything else is shown as unrecognised, which is itself the warning.
const KNOWN_CALLS = parseAbi([
  'function send(address recipient,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts)',
  'function batchSend(address[] recipients,address[] assets,uint256[] amounts,address[][] withdrawProtocols,uint256[][] withdrawAmounts)',
  'function sendToWhitelistedRecipient(uint256 id,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts)',
  'function addWhitelistedRecipient(address recipient)',
  'function removeWhitelistedRecipients(uint256[] ids)',
  'function deposit(address protocol,address asset,uint256 amount)',
  'function withdraw(address protocol,address asset,uint256 amount)',
  'function marketSell(address ammProtocol,address sellToken,uint256 sellAmount,address buyToken,uint256 buyAmountMin,bytes path)',
  'function marketBuy(address ammProtocol,address sellToken,uint256 sellAmountMax,address buyToken,uint256 buyAmount,bytes reversedPath)',
  'function updateAssets(address[] addAssets,address[] removeAssets)',
  'function updateProtocols(address[] addProtocols,address[] removeProtocols)',
  'function upgradeProtocol(address protocol,address newImplementation)',
  'function upgrade(address newImpl)',
  'function useBittyAllowList(bool use)',
  'function setStableCoinAsGas(address[] stableCoins,uint64 dailyLimit,uint64 maxFeePerOp)',
  'function disableStableCoinAsGas()',
  'function setTokenAsGas(address[] assets,uint64 dailyLimit,uint64 maxFeePerOp)',
  'function setTokenAsGas(address[] assets,uint64 dailyLimit)',
  'function disableTokenAsGas()',
  'function setAssetManager(address assetManager,uint64 expiresAt,uint32 permissions)',
  'function emergencyLock()',
  'function unlock()',
  'function foreverLock(uint256 escapeRecipientId)',
  'function wrapNative()',
  'function autoYield(address asset)',
  'function approveIntentRelayer(address intentProtocol,address token)',
  'function approveIntentSpender(address intentProtocol,address token)',
  'function cancelIntentOrders(address intentProtocol,bytes[] orderUids)',
  'function multicall(bytes[] data)',
]);

const amount = (network: Network, token: string, raw: unknown) => {
  const meta = assetMeta(network, token as Address);
  return `${fmtNum(Number(formatUnits(BigInt(String(raw)), meta.decimals)))} ${displaySymbol(meta.symbol)}`;
};

/** One readable line per vault call in a forwarder request's calldata. */
function describeCall(network: Network, data: Hex, t: T): string[] {
  try {
    const {functionName, args = []} = decodeFunctionData({abi: KNOWN_CALLS, data});
    const a = args as readonly unknown[];
    if (functionName === 'multicall') return (a[0] as Hex[]).flatMap((d) => describeCall(network, d, t));
    const to = (x: unknown) => shortAddress(String(x));
    switch (functionName) {
      case 'send':
        return [`${t('vault.send')} ${amount(network, String(a[1]), a[2])} → ${to(a[0])}`];
      case 'sendToWhitelistedRecipient':
        return [`${t('vault.send')} ${amount(network, String(a[1]), a[2])}`];
      case 'batchSend':
        return (a[0] as readonly string[]).map((r, i) => `${t('vault.send')} ${amount(network, String((a[1] as readonly string[])[i]), (a[2] as readonly bigint[])[i])} → ${to(r)}`);
      case 'marketSell':
        return [`${t('vault.market_trade')}: ${amount(network, String(a[1]), a[2])} → ≥ ${amount(network, String(a[3]), a[4])}`];
      case 'marketBuy':
        return [`${t('vault.market_trade')}: ≤ ${amount(network, String(a[1]), a[2])} → ${amount(network, String(a[3]), a[4])}`];
    }
    // Everything else as the history names it, from the same decoded call; the bare function name
    // when the history has no words for it. Never the raw arguments: a path or calldata is a wall of hex.
    const item = KNOWN_CALLS.find((f) => f.type === 'function' && f.name === functionName);
    const named: Record<string, string | string[]> = {};
    const flat = (x: unknown): string | string[] => (Array.isArray(x) ? x.map((y) => String(y)) : String(x));
    (item && 'inputs' in item ? item.inputs : []).forEach((inp, i) => {
      named[inp.name || `arg${i}`] = flat(a[i]);
    });
    const lines = describeActions([{name: functionName, args: named}], network, t, undefined);
    const extra = functionName === 'deposit' || functionName === 'withdraw' ? [amount(network, String(a[1]), a[2])] : [];
    return lines.length ? [...lines, ...extra] : [functionName];
  } catch {
    return [t('mobile.safe.unknown_call', {selector: data.slice(0, 10)})];
  }
}

/** What a waiting request does, in a line or two. */
function describe(network: Network, s: SafeMessageStatus, t: T): string[] {
  const m = s.typedData.message;
  switch (s.primaryType) {
    case 'ForwardRequest':
      return describeCall(network, m.data as Hex, t);
    case 'Activation':
      return [`${amount(network, String(m.stableCoinAddress), m.feeAmount)}`];
    case 'VaultOrder':
    case 'Order': {
      const o = (s.primaryType === 'VaultOrder' ? m.order : m) as Record<string, unknown>;
      return [`${amount(network, String(o.sellToken), o.sellAmount)} → ${amount(network, String(o.buyToken), o.buyAmount)}`];
    }
    case 'TwapOrder':
      return [
        `${String(m.numParts)} × ${amount(network, String(m.sellToken), m.sellAmountPerPart)} → ≥ ${amount(network, String(m.buyToken), m.buyAmountPerPart)}`,
        t('mobile.safe.twap_late'),
      ];
    case 'SafeTx': {
      const ch = describeOwnerChange(s);
      if (!ch) return [];
      if (ch.kind === 'add') return [t('mobile.safe.change_add', {address: shortAddress(ch.owner), n: ch.threshold})];
      if (ch.kind === 'remove') return [t('mobile.safe.change_remove', {address: shortAddress(ch.owner), n: ch.threshold})];
      return [t('mobile.safe.change_threshold', {n: ch.threshold})];
    }
    default:
      return [];
  }
}

/**
 * Whether a request can still run, from the chain: a forwarder request is spent the moment its
 * nonce is (it ran, or another request for the vault ran first), and anything past its expiry is
 * dead whoever signs it.
 */
async function liveness(network: Network, s: SafeMessageStatus): Promise<'live' | 'stale' | 'expired'> {
  if (s.expiresAt !== null && s.expiresAt <= Date.now() / 1000) return 'expired';
  // Finished on this phone: gone at once, before the chain (or CoW) shows it.
  if (finished.getBoolean(s.messageHash.toLowerCase())) return 'stale';
  // An activation is done once the vault exists.
  if (s.primaryType === 'Activation') {
    try {
      const code = await publicClientFor(network).getCode({address: ownerVaultAddress(s.safe, network)});
      return code && code !== '0x' ? 'stale' : 'live';
    } catch {
      return 'live';
    }
  }
  if (s.primaryType !== 'ForwardRequest') return 'live';
  const m = s.typedData.message;
  try {
    const nonce = (await publicClientFor(network).readContract({
      address: s.typedData.domain.verifyingContract,
      abi: FORWARDER_ABI,
      functionName: 'nonceFor',
      args: [m.from as Address, m.to as Address],
    })) as bigint;
    return nonce === BigInt(String(m.nonce)) ? 'live' : 'stale';
  } catch {
    return 'live'; // unknown: let the relay decide
  }
}

/** Requests this phone finished, by message hash: hidden from the list and the badge from then on. */
const finished = new MMKV({id: 'bitty.multisig-finished'});

type Row = SafeMessageStatus & {live: 'live' | 'stale' | 'expired'};

/** The requests that can still run: spent and expired ones are left out, since nothing can be done with them. */
async function liveRequests(network: Network, safe: Address): Promise<Row[]> {
  const msgs = await listSafeMessages(network, safe);
  const all = await Promise.all(msgs.map(async (m) => ({...m, live: await liveness(network, m)})));
  return all.filter((r) => r.live === 'live');
}

/** Whether this phone's key has signed the request already. */
const signedHere = (vault: VaultRef, s: SafeMessageStatus) => !!vault.signer && s.signers.some((x) => x.toLowerCase() === vault.signer!.toLowerCase());

/** Whether the request waits on this phone: its signature, or (signed enough) its Finish. */
const waitsOnMe = (vault: VaultRef, s: SafeMessageStatus) => s.ready || !signedHere(vault, s);

/**
 * How many of a multisig vault's requests wait on this phone, for the badge on the Overview's
 * Transactions. Read again each time the page comes into view; 0 for a vault that is not a multisig.
 */
export function useMultisigToSign(vault: VaultRef | undefined, network: Network, nonce = 0): number {
  const [n, setN] = useState(0);
  const focused = useIsFocused();
  const safe = vault?.safe;
  useEffect(() => {
    if (!safe || !vault || !focused) {
      if (!safe) setN(0);
      return;
    }
    let live = true;
    liveRequests(network, safe)
      .then((rows) => live && setN(rows.filter((r) => waitsOnMe(vault, r)).length))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe, vault?.signer, network, focused, nonce]);
  return n;
}

/**
 * Transactions › Waiting to sign — for a multisig vault: what its owners still have to sign.
 *
 * Each request is the payload exactly as an owner proposed it (kept by the Bitty API), decoded.
 * This phone adds its signature with Sign; once the threshold is met any owner sends it with
 * Finish, and the relay, activation or order goes out as it would for a single signer. A change to
 * the multisig's own owners is signed on its Owners and threshold page, which this row opens.
 * Requests that can no longer run (spent or expired) are left out: nothing can be done with them.
 */
export function MultisigWaiting({vault, network, reload}: {vault: VaultRef; network: Network; reload: number}) {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const safe = vault.safe!;
  const [info, setInfo] = useState<SafeInfo | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, rows] = await Promise.all([fetchSafe(network, safe), liveRequests(network, safe)]);
      setInfo(i);
      setRows(rows);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setRows([]);
    }
  }, [safe, network]);

  useEffect(() => {
    load();
  }, [load, reload]);

  const title = (s: SafeMessageStatus) =>
    s.primaryType === 'SafeTx' ? t('mobile.safemode.owners_row') : t(`mobile.safe.kind_${s.primaryType === 'VaultOrder' ? 'Order' : s.primaryType}`);

  const sign = async (s: Row) => {
    setBusy(s.messageHash);
    const tx = showTx(`${t('mobile.safe.signing')}: ${title(s)}`, network, {broadcast: false});
    try {
      const device = await safeDeviceKey(vault);
      if (!device) return tx.done();
      await cosign({network, device, status: s});
      tx.success();
      await load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const finish = async (s: Row) => {
    setBusy(s.messageHash);
    const onChain = s.primaryType === 'ForwardRequest' || s.primaryType === 'Activation';
    const tx = showTx(`${t('mobile.safe.finishing')}: ${title(s)}`, network, {broadcast: onChain});
    try {
      const out = await finishSafeMessage(network, s);
      finished.set(s.messageHash.toLowerCase(), true);
      tx.success(out.kind === 'tx' ? out.hash : undefined);
      await load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.headTitle}>{info ? t('mobile.safe.safe_badge', {threshold: info.threshold, owners: info.owners.length}) : t('mobile.safemode.section')}</Text>
        <Text style={styles.mono}>{safe}</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {rows === null ? (
        <ActivityIndicator color={c.accent} />
      ) : rows.length === 0 ? (
        <Text style={styles.empty}>{t('mobile.safe.none')}</Text>
      ) : (
        rows.map((s) => {
          const mine = signedHere(vault, s);
          const working = busy === s.messageHash;
          const owners = s.primaryType === 'SafeTx';
          const action = owners
            ? {label: t('mobile.safe.open'), run: () => nav.navigate('ManageMultisig', {safe})}
            : s.ready
              ? {label: t('mobile.safe.finish'), run: () => finish(s)}
              : !mine
                ? {label: t('mobile.safe.sign'), run: () => sign(s)}
                : null;
          return (
            <View key={s.messageHash} style={styles.card}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{title(s)}</Text>
                {describe(network, s, t).map((line, j) => (
                  <Text key={j} style={styles.rowDetail}>
                    {line}
                  </Text>
                ))}
                <Text style={styles.rowMeta}>
                  {t('mobile.safe.signed', {have: s.signers.length, need: s.threshold})}
                  {mine ? ` · ${t('mobile.safe.you_signed')}` : ''}
                  {s.expiresAt ? ` · ${t('mobile.safe.expires', {when: new Date(s.expiresAt * 1000).toLocaleString()})}` : ''}
                </Text>
                {!s.ready && mine ? <Text style={styles.rowMeta}>{t('mobile.safe.waiting')}</Text> : null}
              </View>
              {action ? (
                <Pressable style={({pressed}) => [styles.action, pressed && styles.pressed]} onPress={action.run} disabled={busy !== null}>
                  {working ? <ActivityIndicator color={c.accent} size="small" /> : <Text style={styles.actionText}>{action.label}</Text>}
                </Pressable>
              ) : null}
            </View>
          );
        })
      )}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {gap: 16},
    head: {gap: 4, paddingHorizontal: 4},
    headTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
    mono: {color: c.subtext, fontSize: 11, fontFamily: MONO, lineHeight: 15},
    empty: {color: c.subtext, fontSize: 14, paddingHorizontal: 4},
    error: {color: c.danger, fontSize: 13, lineHeight: 18},
    card: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.card, borderRadius: 20, padding: 18},
    rowText: {flex: 1, gap: 3},
    rowTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
    rowDetail: {color: c.text, fontSize: 13, lineHeight: 18},
    rowMeta: {color: c.subtext, fontSize: 12, lineHeight: 16},
    action: {minWidth: 72, minHeight: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 18, backgroundColor: c.buttonSecondary},
    actionText: {color: c.accent, fontSize: 15, fontWeight: '600'},
    pressed: {opacity: 0.6},
  });

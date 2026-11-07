import React, {useCallback, useState} from 'react';
import {ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {decodeFunctionData, formatUnits, parseAbi, type Address, type Hex} from 'viem';
import {SettingsGroup} from '@/components/SettingsRow';
import {showTx} from '@/components/Toast';
import {useVaults} from '@/core/vault-store';
import {useNetwork} from '@/core/network-store';
import {publicClientFor, type Network} from '@/core/chain';
import {FORWARDER_ABI} from '@/core/abi';
import {assetMeta} from '@/core/assets';
import {displaySymbol, fmtNum, shortAddress} from '@/core/format';
import {cosign, fetchSafe, listSafeMessages, type SafeInfo, type SafeMessageStatus} from '@/vault/safe';
import {finishSafeMessage} from '@/vault/safe-finish';
import {safeDeviceKey} from '@/wallet/store';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors, MONO} from '@/theme';

type T = ReturnType<typeof useT>['t'];

// The vault writes this app makes (core/abi), so a co-owner sees what they approve rather than a
// selector. Anything else is shown as unrecognised, which is itself the warning.
const KNOWN_CALLS = parseAbi([
  'function send(address recipient,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts)',
  'function batchSend(address[] recipients,address[] assets,uint256[] amounts,address[][] withdrawProtocols,uint256[][] withdrawAmounts)',
  'function sendToWhitelistedRecipient(uint256 id,address asset,uint256 amount,address[] withdrawProtocols,uint256[] withdrawAmounts)',
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
    if (functionName === 'send') return [`send ${amount(network, String(a[1]), a[2])} → ${shortAddress(String(a[0]))}`];
    const shown = a.map((x) => (typeof x === 'string' && x.startsWith('0x') && x.length === 42 ? shortAddress(x) : JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
    return [`${functionName}(${shown.join(', ')})`];
  } catch {
    return [t('mobile.safe.unknown_call', {selector: data.slice(0, 10)})];
  }
}

/** What a pending payload does, in a line or two. */
function describe(network: Network, s: SafeMessageStatus, t: T): string[] {
  const m = s.typedData.message;
  switch (s.primaryType) {
    case 'ForwardRequest':
      return describeCall(network, m.data as Hex, t);
    case 'Activation':
      return [`fee ${amount(network, String(m.stableCoinAddress), m.feeAmount)}`];
    case 'Order':
      return [`${m.kind} ${amount(network, String(m.sellToken), m.sellAmount)} → ${amount(network, String(m.buyToken), m.buyAmount)}`];
    case 'TwapOrder':
      return [
        `${String(m.numParts)} × ${amount(network, String(m.sellToken), m.sellAmountPerPart)} → ≥ ${amount(network, String(m.buyToken), m.buyAmountPerPart)}`,
        t('mobile.safe.twap_late'),
      ];
    default:
      return [];
  }
}

/**
 * Whether a payload can still run, from the chain: a forwarder request is spent the moment its
 * nonce is (it ran, or another request for the vault ran first), and anything past its expiry is
 * dead whoever signs it.
 */
async function liveness(network: Network, s: SafeMessageStatus): Promise<'live' | 'stale' | 'expired'> {
  if (s.expiresAt !== null && s.expiresAt <= Date.now() / 1000) return 'expired';
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

type Row = SafeMessageStatus & {live: 'live' | 'stale' | 'expired'};

/**
 * Settings › Safe approvals — for a vault owned by a Safe: what is waiting for the Safe's owners.
 *
 * Each request is the payload exactly as an owner proposed it (kept by the API), decoded. This
 * phone can add its signature, and once the Safe's threshold is met any owner can finish it — the
 * relay, activation or CoW order then goes out exactly as it would have for a single signer.
 */
export function SafeApprovalsScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const ref = useVaults((s) => s.vaults.find((v) => v.index === s.activeIndex));
  const safe = ref?.safe ?? null;
  const [info, setInfo] = useState<SafeInfo | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!safe) return;
    try {
      const [i, msgs] = await Promise.all([fetchSafe(network, safe), listSafeMessages(network, safe)]);
      setInfo(i);
      setRows(await Promise.all(msgs.map(async (m) => ({...m, live: await liveness(network, m)}))));
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setRows([]);
    }
  }, [safe, network]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onPull = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };

  const title = (s: SafeMessageStatus) => t(`mobile.safe.kind_${s.primaryType}`);

  const sign = async (s: Row) => {
    if (!ref) return;
    setBusy(s.messageHash);
    const tx = showTx(`${t('mobile.safe.signing')}: ${title(s)}`, network, {broadcast: false});
    try {
      const device = await safeDeviceKey(ref);
      if (!device) throw new Error('Unlock cancelled');
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
      tx.success(out.kind === 'tx' ? out.hash : undefined);
      await load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  if (!safe) return <Text style={styles.empty}>{t('mobile.safe.none')}</Text>;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} tintColor={c.text} colors={[c.accent]} />}>
      <View style={styles.head}>
        <Text style={styles.headTitle}>{info ? t('mobile.safe.safe_badge', {threshold: info.threshold, owners: info.owners.length}) : 'Safe'}</Text>
        <Text style={styles.mono}>{safe}</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {rows === null ? (
        <ActivityIndicator />
      ) : rows.length === 0 ? (
        <Text style={styles.empty}>{t('mobile.safe.none')}</Text>
      ) : (
        <SettingsGroup>
          {rows.map((s, i) => {
            const mine = !!ref?.signer && s.signers.some((x) => x.toLowerCase() === ref.signer!.toLowerCase());
            const working = busy === s.messageHash;
            const action =
              s.live !== 'live' ? null : s.ready ? {label: t('mobile.safe.finish'), run: () => finish(s)} : !mine ? {label: t('mobile.safe.sign'), run: () => sign(s)} : null;
            return (
              <View key={s.messageHash} style={[styles.row, i < rows.length - 1 && styles.rowBorder]}>
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
                  {s.live === 'stale' ? <Text style={styles.warn}>{t('mobile.safe.stale')}</Text> : null}
                  {s.live === 'expired' ? <Text style={styles.warn}>{t('mobile.safe.expired')}</Text> : null}
                  {s.live === 'live' && !s.ready && mine ? <Text style={styles.rowMeta}>{t('mobile.safe.waiting')}</Text> : null}
                </View>
                {action ? (
                  <Pressable style={({pressed}) => [styles.action, pressed && styles.pressed]} onPress={action.run} disabled={busy !== null}>
                    {working ? <ActivityIndicator color={c.accent} size="small" /> : <Text style={styles.actionText}>{action.label}</Text>}
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </SettingsGroup>
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, gap: 16},
    head: {gap: 4},
    headTitle: {color: c.text, fontSize: 17, fontWeight: '600'},
    mono: {color: c.subtext, fontSize: 11, fontFamily: MONO, lineHeight: 15},
    empty: {color: c.subtext, fontSize: 15, textAlign: 'center', marginTop: 24},
    error: {color: c.danger, fontSize: 13, lineHeight: 18},
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12},
    rowBorder: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
    rowText: {flex: 1, gap: 3},
    rowTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
    rowDetail: {color: c.text, fontSize: 13, lineHeight: 18},
    rowMeta: {color: c.subtext, fontSize: 12, lineHeight: 16},
    warn: {color: c.danger, fontSize: 12, lineHeight: 16},
    action: {minWidth: 72, minHeight: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 18, backgroundColor: c.buttonSecondary},
    actionText: {color: c.accent, fontSize: 15, fontWeight: '600'},
    pressed: {opacity: 0.6},
  });

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import {isAllowlistEnabled, allowedSet, updateAsset, updateProtocol, setAllowlistEnabled, vaultImplVersion} from '@/vault/manage';
import {useAssetCatalog} from '@/core/asset-catalog';
import {TokenIcon} from '@/components/TokenIcon';
import {PendingSwitch} from '@/components/PendingSwitch';
import {showTx} from '@/components/Toast';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {ProtocolIcon} from '@/components/ProtocolIcon';
import {type ProtocolCategory} from '@/core/protocols';
import {
  fetchVaultVersions,
  currentServices,
  type VaultVersionsCatalog,
} from '@/vault/versions';
import {useT} from '@/i18n';
import {useStyles, type Colors} from '@/theme';
import {displaySymbol} from '@/core/format';

/**
 * Allow list management (Settings › Vault › Allow list). Vault / adapter upgrades will return here later. Gasless, Face-ID-gated. The
 * Bitty allowlist switch first, then the assets and the protocols, each in its own card.
 */
/**
 * Which service a protocol category powers, by translation key.
 *
 * Typed against ProtocolCategory rather than `string`, so adding a category to the registry fails
 * to compile until it has a name here. It was `Record<string, string>` when the AMM split added
 * `marketMaker`, and the lookup silently returned undefined — `t(undefined)` then threw inside
 * `resolve` and took the whole Allow list page down.
 */
const SERVICE_KEY: Record<ProtocolCategory, string> = {
  staking: 'vault.flexible_yield',
  lending: 'vault.flexible_lend',
  amm: 'vault.market_trade',
  marketMaker: 'vault.market_maker',
  intent: 'vault.limit_trade',
  unknown: 'mobile.vault.category_unknown',
};

/**
 * The order the services are listed in: what the vault earns with, then what it trades with, then
 * market making.
 *
 * Registry order put Market Maker in the middle of the trading services, between the adapter that
 * swaps and the one that posts intents, where it reads as a third way to trade. It is the one
 * service that puts the vault's money INTO a pool rather than through one, so it goes last.
 * Anything with no rank here follows, in the order the registry gave it.
 */
const SERVICE_ORDER: ProtocolCategory[] = ['staking', 'lending', 'amm', 'intent', 'marketMaker', 'unknown'];
const serviceRank = (c: ProtocolCategory) => {
  const i = SERVICE_ORDER.indexOf(c);
  return i < 0 ? SERVICE_ORDER.length : i;
};

export function ManageScreen() {
  const {t, company} = useT();
  const styles = useStyles(makeStyles);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const assets = useAssetCatalog(network);
  const stable = assets.find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  // The services come from the server version catalog (the single source shared with the web), not
  // from a bundled adapter table. One adapter per name (canonical address), in service order.
  const [catalog, setCatalog] = useState<VaultVersionsCatalog | null>(null);
  useEffect(() => {
    fetchVaultVersions(network).then(setCatalog);
  }, [network]);
  // The vault's own impl version decides which services apply: a ≤1.0.2 vault sees the combined
  // Uniswap adapter; a 1.0.3+ vault sees the split Market Trade + Market Maker.
  const [implVersion, setImplVersion] = useState(0);
  useEffect(() => {
    if (vault) vaultImplVersion(vault, network).then(setImplVersion);
  }, [vault, network]);
  /**
   * One row per SERVICE per protocol, in service order.
   *
   * Keyed by category and name, not by name alone. Name alone was right before the AMM split,
   * when a protocol appeared twice only because two adapter versions of it were registered and
   * one row was wanted. Since the split two different services legitimately share a name — the
   * catalog calls both the market-trade adapter and the market-maker adapter "Uniswap V3" — and
   * a Map keyed on that kept whichever came last, which silently dropped Market Trade from the
   * list. Two versions of one adapter within a category still collapse to one row.
   */
  const protocols = useMemo(
    () =>
      Array.from(
        new Map(currentServices(catalog, implVersion).map((p) => [`${p.category}:${p.name}`, p])).values(),
      ).sort((a, b) => serviceRank(a.category) - serviceRank(b.category)),
    [catalog, implVersion],
  );

  const [restricted, setRestricted] = useState(false);
  // With the Bitty allowlist on, the vault accepts every asset and protocol in Bitty's catalog, so the
  // per-item switches all read "on" and cannot be changed; they become editable when the owner takes
  // the list over (Bitty allowlist off = the vault's own restricted list).
  const bitty = !restricted;
  const [assetSet, setAssetSet] = useState<Set<string>>(new Set());
  const [protoSet, setProtoSet] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!vault) return;
    isAllowlistEnabled(vault, network).then(setRestricted);
    allowedSet(vault, network, 'asset', assets.map((a) => a.address)).then(setAssetSet);
    allowedSet(vault, network, 'protocol', protocols.map((p) => p.address)).then(setProtoSet);
  }, [vault, network, protocols]);
  useEffect(load, [load]);

  const {ask, sheet} = useConfirmAction();

  const runNow = async (key: string, title: string, fn: (acct: Awaited<ReturnType<typeof getSigner>>) => Promise<string>) => {
    if (!vault || !stable) return;
    setBusy(key);
    const tx = showTx(title, network);
    try {
      const acct = await getSigner();
      tx.success(await fn(acct));
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Every write on this page goes through here, so wrapping it is what puts a Face ID step and an
   * estimated fee in front of all of them at once — the switches and the small Save buttons
   * included, which used to send a transaction on the tap that reached them.
   */
  const run = (key: string, title: string, fn: Parameters<typeof runNow>[2]) =>
    ask({title, gas: relayGasFor({}), run: () => runNow(key, title, fn).then(() => undefined)});

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <View style={styles.section}>
      <View style={styles.group}>
        <View style={[styles.row, styles.rowFirst, styles.rowLast]}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{t('mobile.vault.bitty_allowlist')}</Text>
          </View>
          <PendingSwitch
              value={!restricted}
              pending={busy === 'allowlist'}
              disabled={busy !== null}
              onValueChange={(v) =>
                run('allowlist', t('mobile.vault.bitty_allowlist'), (acct) =>
                  setAllowlistEnabled({account: acct, vault: vault!, network, enabled: !v, stableCoin: stable!.address}),
                )
              }
            />
        </View>
      </View>
      <Text style={styles.foot}>{t('mobile.vault.bitty_allowlist_foot')}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('vault.assets')}</Text>
        <View style={styles.group}>
        {assets.map((a, i) => (
          <View key={a.address} style={[styles.row, i === 0 && styles.rowFirst, i === assets.length - 1 && styles.rowLast]}>
            <View style={styles.symRow}>
              <TokenIcon symbol={a.symbol} uri={a.icon} size={22} />
              <View style={styles.symText}>
                <Text style={styles.sym}>{displaySymbol(a.symbol)}</Text>
                {company(a.symbol, a.tokenName) ? (
                  <Text style={styles.company} numberOfLines={1}>
                    {company(a.symbol, a.tokenName)}
                  </Text>
                ) : null}
              </View>
            </View>
            <PendingSwitch
                value={bitty || assetSet.has(a.address.toLowerCase())}
                pending={busy === `a-${a.address}`}
                disabled={busy !== null || bitty}
                onValueChange={(v) =>
                  run(`a-${a.address}`, t(v ? 'mobile.actions.asset_added' : 'mobile.actions.asset_removed', {name: displaySymbol(a.symbol)}), (acct) =>
                    updateAsset({account: acct, vault: vault!, network, asset: a.address, add: v, stableCoin: stable!.address}),
                  )
                }
              />
          </View>
        ))}
        </View>
      </View>

      {/* Services, as the web names them; the protocol behind each sits at the right of its row. */}
      <View style={styles.section}>
        <Text style={styles.groupLabel}>{t('vault.services')}</Text>
        <View style={styles.group}>
        {protocols.map((p, i) => (
          <View key={p.address} style={[styles.row, i === 0 && styles.rowFirst, i === protocols.length - 1 && styles.rowLast]}>
            <Text style={styles.sym}>{t(SERVICE_KEY[p.category] ?? SERVICE_KEY.unknown)}</Text>
            <View style={styles.protoRight}>
              <ProtocolIcon name={p.name} size={20} uri={p.icon} />
              <Text style={styles.protoName}>{p.name}</Text>
            </View>
            <PendingSwitch
                value={bitty || protoSet.has(p.address.toLowerCase())}
                pending={busy === `p-${p.address}`}
                disabled={busy !== null || bitty}
                onValueChange={(v) =>
                  run(`p-${p.address}`, t(v ? 'mobile.actions.enable_service' : 'mobile.actions.disable_service', {name: p.name}), (acct) =>
                    updateProtocol({account: acct, vault: vault!, network, protocol: p.address, add: v, stableCoin: stable!.address}),
                  )
                }
              />
          </View>
        ))}
        </View>
      </View>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  body: {flexGrow: 1, padding: 20, paddingBottom: 20, gap: 16},
  // One section card per list, the same card as everywhere else: the card carries the padding, rows
  // draw a hairline on their top edge, and the first/last rows drop their outer padding so the card
  // frames the list evenly.
  section: {gap: 0},
  groupLabel: {color: c.subtext, fontSize: 15, fontWeight: '600', paddingHorizontal: 16, marginTop: 8, marginBottom: 6},
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
  rowText: {flex: 1, gap: 2},
  rowTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
  symRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  protoRight: {flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto'},
  protoName: {color: c.subtext, fontSize: 13, fontWeight: '600'},
  symText: {flexShrink: 1, minWidth: 0},
  sym: {color: c.text, fontSize: 15, fontWeight: '600'},
  company: {color: c.subtext, fontSize: 12, marginTop: 1},
  hint: {color: c.subtext, fontSize: 12, marginTop: 2},
  foot: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, marginTop: 6},
  busy: {color: c.subtext, fontSize: 16},
});

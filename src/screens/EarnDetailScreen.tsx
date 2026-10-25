import {useHeaderHeight} from '@react-navigation/elements';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {Address} from 'viem';
import type {RootStackParamList} from '@/App';
import {TokenIcon} from '@/components/TokenIcon';
import {Amount} from '@/components/Amount';
import {PendingSwitch} from '@/components/PendingSwitch';
import {useConfirmAction} from '@/components/ConfirmAction';
import {showTx} from '@/components/Toast';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useVaultPositions} from '@/vault/useVaultPositions';
import {useFlows} from '@/vault/useFlows';
import {earnedRaw} from '@/vault/flows';
import {balanceOfSymbol} from '@/vault/read';
import {getAutoYields, setAutoYield} from '@/vault/autoyield';
import {fetchProtocolApy, EMPTY_APY, type ProtocolApy} from '@/vault/apy';
import {relayGasFor} from '@/vault/fee-quote';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {claimLido, getLidoUnstake, NO_UNSTAKE, type LidoUnstake} from '@/vault/lido';
import {useVaultWrite} from '@/components/useVaultWrite';

import {protocolDisplayName} from '@/core/protocols';
import {formatUnits} from 'viem';
import {displaySymbol, fmtNum} from '@/core/format';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';
import {useAssetCatalog} from '@/core/asset-catalog';

/**
 * One Earn position, in full.
 *
 * The Earn row used to expand into a strip holding a toggle and two buttons, which fit the English
 * words and nothing longer. This is where that strip went, and the room it buys is spent on the
 * two things a row could never show: what Auto-Yield actually does, and what the rate has been
 * doing. Everything is re-derived live from the stores — the route is addressed by protocol and
 * asset, so nothing stale is carried through the navigation.
 */
export function EarnDetailScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const headerHeight = useHeaderHeight();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {params} = useRoute<RouteProp<RootStackParamList, 'EarnDetail'>>();
  const {protocol, asset, name, lend} = params;

  const network = useNetwork((s) => s.network);
  const getSigner = useWallet((s) => s.signer);
  const c = useColors();
  const bal = useVaultBalances(network);
  const pos = useVaultPositions(bal.vault, network);
  const flows = useFlows(bal.vault, network);

  /**
   * Pull to re-read what the vault holds here.
   *
   * This page is opened straight after a deposit or a withdrawal, and those settle on chain some
   * seconds after the form that sent them has gone — so the figure it shows is routinely one
   * operation out of date, with no way to ask again short of leaving and coming back. All three
   * reads go: the balance funds the next deposit, the position is the deposited amount itself, and
   * the flows are what it has earned.
   *
   * The spinner is tied to a load actually being in flight rather than to the gesture, so a pull
   * that finds nothing to fetch does not leave it turning. `pulled` clears whenever the reads go
   * quiet, which also covers a refresh that was already running when the gesture arrived.
   */
  const [pulled, setPulled] = useState(false);
  const busy = pos.loading || bal.loading;
  useEffect(() => {
    if (!busy) setPulled(false);
  }, [busy]);
  const onRefresh = useCallback(() => {
    setPulled(true);
    bal.refresh();
    pos.refresh();
    flows.refresh();
  }, [bal.refresh, pos.refresh, flows.refresh]);
  const {ask, sheet} = useConfirmAction();

  const catalog = useAssetCatalog(network);
  const meta = catalog.find((a) => a.address.toLowerCase() === asset.toLowerCase());
  const symbol = meta?.symbol ?? params.symbol;
  const sym = displaySymbol(symbol);

  const position = pos.positions.find(
    (p) => p.symbol === symbol && p.protocol?.toLowerCase() === protocol.toLowerCase(),
  );
  const free = bal.balances ? balanceOfSymbol(bal.balances, symbol) : null;
  const held = Number(position?.formatted ?? '0');
  /**
   * Anything at all in the vault opens the deposit form — the relayer's float is NOT subtracted
   * here.
   *
   * It was, and the button went dead on a vault holding four dollars against a ten dollar float:
   * a page showing a balance, with the one thing to do about it greyed out and no word on why.
   * The money is real and the owner should feel it; the float is a constraint on the AMOUNT, so
   * it belongs where the amount is set — the form's Max stops short of it, and its source sheet
   * names it as the row that cannot be chosen.
   *
   * Which is also why Available below is the plain balance: this page says what is held, the form
   * says what can be moved.
   */
  const canDeposit = free != null && Number(free) > 0;
  /**
   * What the position has made: its balance now, less the principal the flow ledger says went in.
   * Null until both the position and the ledger have landed — a zero there would read as "earned
   * nothing" when the truth is "not known yet".
   */
  const earned = (() => {
    if (!position || !flows.flows) return null;
    const raw = earnedRaw(position, flows.flows);
    return raw != null ? Number(formatUnits(raw, position.decimals)) : null;
  })();

  // ── live rate, and the series it feeds ────────────────────────────────
  const [apy, setApy] = useState<ProtocolApy>(EMPTY_APY);
  useEffect(() => {
    let live = true;
    // Aave rates are per asset, Sky's and Lido's per adapter; ask for the one this route is.
    fetchProtocolApy({
      network,
      aaveAssets: lend ? [asset as Address] : [],
      skyProtocols: name === 'Sky' ? [protocol as Address] : [],
      lidoProtocols: name === 'Lido' ? [protocol as Address] : [],
    })
      .then((r) => live && setApy(r))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, asset, protocol, name, lend]);
  const rate = useMemo(
    () => apy.protocolApy.get(protocol.toLowerCase()) ?? apy.assetApy.get(asset.toLowerCase()) ?? null,
    [apy, protocol, asset],
  );

  // ── auto-yield ────────────────────────────────────────────────────────
  const [autoOn, setAutoOn] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  // The keeper's sweeps are relayed and billed to the vault, so with the owner's wallet paying the
  // network fee nothing ever sweeps. Turning it on is refused and says why; one already on can
  // still be turned off.
  const ownerPays = useActiveFeePayer(network).payer === 'owner';
  const stable = catalog.find((a) => a.kind === 'stable');
  const loadAuto = () => {
    if (bal.vault) {
      getAutoYields(bal.vault, network, [asset as Address]).then((m) =>
        setAutoOn((m.get(asset.toLowerCase()) ?? '').toLowerCase() === protocol.toLowerCase()),
      );
    }
  };
  useEffect(loadAuto, [bal.vault, network, asset, protocol]);

  const toggleAuto = async () => {
    if (!bal.vault || !stable) return;
    setAutoBusy(true);
    const tx = showTx(t(autoOn ? 'mobile.actions.auto_yield_off' : 'mobile.actions.auto_yield_set', {token: sym}), network);
    try {
      const acct = await getSigner();
      tx.success(
        await setAutoYield({
          account: acct,
          vault: bal.vault,
          network,
          asset: asset as Address,
          // Turning it off clears the route; the contract reads the zero address as "no route".
          protocol: (autoOn ? '0x0000000000000000000000000000000000000000' : protocol) as Address,
          stableCoin: stable.address,
        }),
      );
      loadAuto();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setAutoBusy(false);
    }
  };

  const go = (mode: 'deposit' | 'withdraw') =>
    nav.navigate('EarnAction', {
      mode,
      protocol,
      asset,
      symbol,
      decimals: meta?.decimals ?? 18,
      max: mode === 'deposit' ? free ?? '0' : position?.formatted ?? '0',
    });

  const autoLabel = t(lend ? 'mobile.earn.auto_supply' : 'mobile.earn.auto_yield');

  // ── Lido's withdrawal queue ───────────────────────────────────────────
  /**
   * A Lido withdraw files a request that finalizes days later and then has to be claimed, as WETH,
   * back into the vault. Until then the ETH is in neither the position nor the balance above, so
   * it is shown here — still unstaking, then claimable with the button to claim it.
   */
  const isLido = name === 'Lido';
  const [unstake, setUnstake] = useState<LidoUnstake>(NO_UNSTAKE);
  const loadUnstake = useCallback(() => {
    if (!isLido || !bal.vault) return;
    getLidoUnstake(bal.vault, protocol as Address, network)
      .then(setUnstake)
      .catch(() => {});
  }, [isLido, bal.vault, protocol, network]);
  // Again with every pull, and after a withdraw (this page is where that form returns to).
  useEffect(loadUnstake, [loadUnstake, pos.positions]);
  const claim = useVaultWrite(() => {
    loadUnstake();
    bal.refresh();
  });
  const fmtEth = (wei: bigint) => fmtNum(Number(formatUnits(wei, 18)));

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.body, {paddingTop: headerHeight + 8}]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={pulled && busy}
          onRefresh={onRefresh}
          // The header is transparent and the content scrolls under it, so the spinner has to
          // start below the bar or it turns behind it.
          progressViewOffset={headerHeight}
          tintColor={c.text}
          colors={[c.accent]}
        />
      }>
      {/* Who and what, with the rate it pays. */}
      <View style={styles.head}>
        <TokenIcon symbol={symbol} size={40} />
        <View style={styles.headText}>
          <Text style={styles.sym}>{sym}</Text>
          {/* The versioned name, as the Earn list's chip and the services list already show it.
              `name` itself stays the adapter's registry name — the rate lookup below compares
              against it — and Aave's happens to carry its version while Sky's and Lido's do not,
              which is what left this page naming the brand next to two that named the release. */}
          <Text style={styles.sub}>{protocolDisplayName(name)}</Text>
        </View>
        {rate != null ? (
          <View style={styles.apyPill}>
            <Text style={styles.apyText}>{t('mobile.earn.apy_rate', {rate: rate.toFixed(2)})}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Row label={t('mobile.earn.detail_position')} value={`${fmtNum(held)} ${sym}`} />
        {earned != null && earned > 0 ? (
          <Row label={t('mobile.earn.detail_earned')} value={`+${fmtNum(earned)} ${sym}`} tone="good" />
        ) : null}
        {/* BALANCE, not "available". What the vault holds of this coin is a fact; whether any of it
            can be deposited is a question the form answers, and on a balance under the relayer's
            float the answer is none of it — so calling the figure available was the one thing it
            could not be called. */}
        <Row label={t('vault.balance')} value={free != null ? `${fmtNum(Number(free))} ${sym}` : '—'} />
        {/* Always on Lido, as on the web: the queue is part of where this position's ETH can be,
            and a row that appears only once there is something in it is a row nobody knows to
            look for. */}
        {isLido ? <Row label={t('vault.unstaking')} value={`${fmtEth(unstake.unstaking)} ETH`} /> : null}
        {isLido ? (
          <Row label={t('vault.claimable')} value={`${fmtEth(unstake.claimable)} ETH`} tone={unstake.claimable > 0n ? 'good' : undefined} />
        ) : null}
      </View>

      {/* Finalized and waiting: one tap brings it back into the vault as WETH. Drawn whenever this
          is Lido, greyed with nothing to claim, as the Withdraw button below is with nothing held. */}
      {isLido ? (
        <Pressable
          style={[styles.btn, styles.depBtn, (!claim.ready || unstake.claimableIds.length === 0) && styles.btnFaded]}
          disabled={!claim.ready || unstake.claimableIds.length === 0}
          onPress={() =>
            claim.run('claim', `${t('vault.claim')} · ${fmtEth(unstake.claimable)} ETH`, (b) =>
              claimLido({...b, protocol: protocol as Address, ids: unstake.claimableIds}),
            )
          }>
          <Text style={styles.priText} numberOfLines={1}>
            {unstake.claimable > 0n ? `${t('vault.claim')} ${fmtEth(unstake.claimable)} ETH` : t('vault.claim')}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.card}>
        <View style={styles.autoRow}>
          <Text style={styles.autoLabel}>{autoLabel}</Text>
          <PendingSwitch
            value={autoOn}
            pending={autoBusy}
            disabled={ownerPays && !autoOn}
            onValueChange={() =>
              ask({
                title: autoLabel,
                message: protocolDisplayName(name),
                gas: relayGasFor({}),
                run: toggleAuto,
              })
            }
          />
        </View>
        <Text style={styles.explain}>{t(lend ? 'mobile.earn.auto_supply_what' : 'mobile.earn.auto_yield_what', {symbol: sym})}</Text>
        {ownerPays ? (
          <Pressable onPress={() => nav.navigate('NetworkFee')} hitSlop={6}>
            <Text style={styles.ownerPays}>{t('mobile.earn.auto_needs_vault_fee')}</Text>
          </Pressable>
        ) : null}
        {/* No protocol mark here. The venue is already named at the top of the page, and under a
            sentence explaining what the switch does a logo read as part of the explanation —
            as if the paragraph were about the protocol rather than about the switch. */}
      </View>

      {/* Side by side, the same pills the pair screen's Buy / Sell bar uses — and in the same
          order it puts them: the quiet one left, the one that commits money right. */}
      <View style={styles.actions}>
        {/* Always drawn, greyed when there is nothing to take out: hiding it collapsed the pair
            into one full-width button, and the page changed shape depending on the balance. */}
        <Pressable
          style={[styles.btn, styles.wdBtn]}
          disabled={held <= 0}
          onPress={() => go('withdraw')}>
          <Text style={[styles.secText, held <= 0 && styles.secTextOff]} numberOfLines={1}>
            {t('vault.withdraw')}
          </Text>
        </Pressable>
        {/* Nothing free in the vault, nothing to put in — and null while the balances load, which
            is also not a moment to start a deposit. Faded rather than recoloured: that is what
            every other primary button in the app does when it is disabled. */}
        <Pressable
          style={[styles.btn, styles.depBtn, !canDeposit && styles.btnFaded]}
          disabled={!canDeposit}
          onPress={() => go('deposit')}>
          <Text style={styles.priText} numberOfLines={1}>{t(lend ? 'vault.supply' : 'vault.deposit')}</Text>
        </Pressable>
      </View>
      {sheet}
      {claim.sheet}
    </ScrollView>
  );
}

function Row({label, value, tone}: {label: string; value: string; tone?: 'good'}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone === 'good' && styles.rowValueGood]}>
        <Amount v={value} size={15} color={tone === 'good' ? c.success : undefined} />
      </Text>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    body: {flexGrow: 1, padding: 16, paddingBottom: 32, gap: 12},
    head: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 4},
    headText: {flex: 1},
    sym: {color: c.text, fontSize: 20, fontWeight: '700'},
    sub: {color: c.subtext, fontSize: 13, marginTop: 2},
    apyPill: {backgroundColor: c.successSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4},
    apyText: {color: c.success, fontSize: 13, fontWeight: '700'},
    card: {backgroundColor: c.card, borderRadius: 20, borderCurve: 'continuous', padding: 16, gap: 10},
    row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
    rowLabel: {color: c.subtext, fontSize: 14, flexShrink: 1},
    rowValue: {color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
    rowValueGood: {color: c.success},
    // A few points off the padding edge: a UISwitch fills its 51×31 box exactly, so flush
    // against the card it crowds the rounded corner it sits under.
    autoRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingRight: 4},
    autoLabel: {color: c.text, fontSize: 15, fontWeight: '600', flex: 1},
    explain: {color: c.subtext, fontSize: 13, lineHeight: 19},
    ownerPays: {color: c.warning, fontSize: 13, lineHeight: 19},
    actions: {flexDirection: 'row', gap: 12, marginTop: 8},
    btn: {flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12},
    depBtn: {backgroundColor: c.accent},
    btnFaded: {opacity: 0.5},
    wdBtn: {backgroundColor: c.buttonSecondary},
    // Disabled changes the label only. The fill stays the one grey either way: switching it too
    // made the button look like a different control depending on the balance, and fading it with
    // `opacity` let the page show through and read as a rendering fault.
    secTextOff: {color: c.subtext},
    priText: {color: c.onAccent, fontSize: 17, fontWeight: '700'},
    secText: {color: c.textMuted, fontSize: 17, fontWeight: '700'},
  });

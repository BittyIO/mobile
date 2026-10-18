import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {StableCoinAsGasCoins} from '@/components/StableCoinAsGasCoins';
import {StableCoinAsGasLimits} from '@/components/StableCoinAsGasLimits';
import {PickerSheet} from '@/components/AssetPicker';
import {makeSettingsStyles} from '@/components/SettingsRow';
import {TokenIcon} from '@/components/TokenIcon';
import {useAssetCatalog} from '@/core/asset-catalog';
import {fmtNum, displaySymbol} from '@/core/format';
import {useNetwork} from '@/core/network-store';
import {
  RESERVE_NONE,
  gasReserveAmount,
  gasReserveCoin,
  setGasReserveAmount,
  setGasReserveCoin,
} from '@/core/prefs';
import {useWallet} from '@/wallet/store';
import {resolveFeeReserve} from '@/vault/stableCoinAsGas';
import {ownerVaultAddress, balanceOfSymbol} from '@/vault/read';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * What the vault's network fees are paid WITH, and what it always keeps to pay them.
 *
 * Three sections, in the order the questions arrive: which stable coins the relayer may bill, the
 * float that is held back so it can, then the most it may bill per operation and per 24 hours. `StableCoinAsGasCoins` carries the first entirely — its own
 * card, switches and footnote.
 *
 * The reserve is deliberately plain. Its value lives in the preferences file that is already open
 * at launch, read once into component state and written on change; there is no store, no
 * subscription and nothing initialised while this page renders. The version that had all three
 * crashed the app every time this page opened, and none of it was buying anything the two rows
 * below need.
 */
/**
 * What the reserve may be set to, per chain.
 *
 * A fixed set rather than a free field: these are the only answers worth giving, and a typed
 * figure invites a stray zero that locks the whole stablecoin balance behind a reserve nobody
 * meant to set — with Max then offering nothing and no clue why.
 *
 * Mainnet starts at ten because a relay there costs the better part of a dollar and the vault's
 * own per-operation ceiling is ten; everywhere else a relay costs cents, so one is a real choice
 * and a thousand would be absurd.
 */
const CHOICES: Record<string, number[]> = {
  mainnet: [5, 10, 100, 1000],
};
const CHOICES_DEFAULT = [1, 5, 10, 100];

export function NetworkFeeScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const choices = CHOICES[network] ?? CHOICES_DEFAULT;
  /**
   * The reserve belongs to THIS vault on THIS chain, so the page has to say which.
   *
   * Predicted locally from the owner, as everywhere else — no RPC, so the right setting is on
   * screen from the first frame rather than after a read.
   */
  const owner = useWallet((s) => s.address);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const key = `${network}:${vault ?? ''}`;

  const [amount, setAmount] = useState(() => gasReserveAmount(network, vault));
  const [coinPref, setCoinPref] = useState(() => gasReserveCoin(network, vault));
  const [picking, setPicking] = useState<'coin' | 'amount' | null>(null);

  // Switching vault or chain while the page is open changes which setting it is editing.
  useEffect(() => {
    setAmount(gasReserveAmount(network, vault));
    setCoinPref(gasReserveCoin(network, vault));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /**
   * The stablecoins to offer, and what the vault holds of each.
   *
   * The balances are here for one reason: an unset preference resolves to a coin the vault
   * actually holds enough of, and this page has to show the SAME answer the trade form will act
   * on — see {resolveFeeReserve}. Reading the setting alone would show "None" on a vault that
   * is in fact holding a float back.
   */
  const catalog = useAssetCatalog(network);
  const bal = useVaultBalances(network);
  const heldStables = useMemo(
    () =>
      catalog
        .filter((a) => a.kind === 'stable')
        .map((a) => ({symbol: a.symbol, amount: Number(balanceOfSymbol(bal.balances, a.symbol))})),
    [catalog, bal.balances],
  );
  const resolved = resolveFeeReserve({network, vault, heldStables});
  /** What the row says: the owner's choice where there is one, otherwise what will be picked. */
  const coinLabel =
    coinPref === RESERVE_NONE
      ? t('vault.none')
      : resolved.coin
        ? displaySymbol(resolved.coin)
        : t('vault.none');

  const chooseCoin = (v: string) => {
    setGasReserveCoin(network, vault, v);
    setCoinPref(v);
  };
  const choose = (v: string) => {
    setGasReserveAmount(network, vault, v);
    setAmount(v);
  };
  const reserving = coinPref !== RESERVE_NONE && !!resolved.coin;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <View>
        <StableCoinAsGasCoins />
      </View>

      {/* The reserve: one row for WHICH coin holds it, one for how much. */}
      <View style={[styles.group, styles.second]}>
        {/* A choice, not a switch. "None" is one of the options, so the row that used to turn the
            feature on and off now also says where the float lives — which is the thing the trade
            form needs to be able to name. */}
        <Pressable style={[styles.row, styles.rowDivider]} onPress={() => setPicking('coin')}>
          <Text style={styles.rowTitle}>{t('mobile.settings.gas_reserve')}</Text>
          <View style={styles.amount}>
            <Text style={styles.rowValue}>{coinLabel}</Text>
            <Text style={styles.chev}>›</Text>
          </View>
        </Pressable>
        {/* Dimmed rather than removed with no coin chosen: the figure is still the one that comes
            back when a coin is, and a row that vanishes takes its explanation with it. Not
            pressable either, so the sheet cannot be opened for a setting that does nothing. */}
        <Pressable style={styles.row} onPress={() => reserving && setPicking('amount')} disabled={!reserving}>
          <Text style={[styles.rowTitle, !reserving && styles.off]}>{t('mobile.settings.gas_reserve_amount')}</Text>
          <View style={styles.amount}>
            <Text style={[styles.rowValue, !reserving && styles.off]}>{amount}</Text>
            <Text style={[styles.chev, !reserving && styles.off]}>›</Text>
          </View>
        </Pressable>
      </View>
      <Text style={styles.hint}>{t('mobile.settings.gas_reserve_hint')}</Text>

      <StableCoinAsGasLimits />

      <PickerSheet
        visible={picking === 'coin'}
        title={t('mobile.settings.gas_reserve')}
        items={[
          {key: RESERVE_NONE, label: t('vault.none')},
          ...heldStables.map((h) => ({
            key: h.symbol,
            label: displaySymbol(h.symbol),
            icon: <TokenIcon symbol={h.symbol} size={30} />,
            value: fmtNum(h.amount),
          })),
        ]}
        // The resolved coin, so an unset preference shows the tick on the coin it is actually
        // reserving rather than on nothing at all.
        selected={coinPref === RESERVE_NONE ? RESERVE_NONE : resolved.coin ?? RESERVE_NONE}
        onSelect={chooseCoin}
        onClose={() => setPicking(null)}
      />
      <PickerSheet
        visible={picking === 'amount'}
        title={t('mobile.settings.gas_reserve_amount')}
        items={choices.map((n) => ({key: String(n), label: String(n)}))}
        selected={amount}
        onSelect={choose}
        onClose={() => setPicking(null)}
      />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    // The gap here is the one INSIDE a section — a card and the footnote that explains it. The
    // space BETWEEN sections is set on the second card, so the two kinds of distance stay
    // distinguishable: at a single shared gap the reserve read as a third row of the fee tokens.
    body: {padding: 16, gap: 8, paddingBottom: 32},
    // A switch fills its box exactly where a chevron's glyph sits inside one, so it needs the
    // same nudge the settings rows give theirs.
    second: {marginTop: 20},
    switch: {marginRight: 10},
    amount: {flexDirection: 'row', alignItems: 'center', gap: 6},
    off: {opacity: 0.4},
    hint: {color: c.subtext, fontSize: 12, lineHeight: 17, paddingHorizontal: 4},
  });

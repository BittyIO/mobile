import React, {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {FeePayerSection} from '@/components/FeePayerSection';
import {StableCoinAsGasCoins} from '@/components/StableCoinAsGasCoins';
import {StableCoinAsGasLimits} from '@/components/StableCoinAsGasLimits';
import {PickerSheet} from '@/components/AssetPicker';
import {useAssetCatalog} from '@/core/asset-catalog';
import {useNetwork} from '@/core/network-store';
import {gasReserveAmount, setGasReserveAmount} from '@/core/prefs';
import {useWallet} from '@/wallet/store';
import {useSyncFeeReserve} from '@/vault/stableCoinAsGas';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {ownerVaultAddress} from '@/vault/read';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Who pays the vault's network fees, what the vault pays them WITH, and what it always keeps to pay
 * them.
 *
 * Who pays comes first (`FeePayerSection`): the vault, through the relayer, or the owner wallet,
 * from this phone. The fee-coin sections below are the vault's and only show while the vault pays;
 * with the owner paying they are not what the user is managing, and a page of coins and caps that
 * no longer apply reads as if they still do.
 *
 * Then two sections. First, which coins the relayer may bill, in the owner's order of preference —
 * long-press and drag to reorder; the first is asked for first and holds the reserve.
 * `StableCoinAsGasCoins` carries it entirely. Second, what is kept and what may be taken: the
 * reserve amount, then the most the relayer may bill per operation and per 24 hours.
 *
 * The reserve is deliberately plain. Its value lives in the preferences file that is already open
 * at launch, read once into component state and written on change; there is no store, no
 * subscription and nothing initialised while this page renders. The version that had all three
 * crashed the app every time this page opened, and none of it was buying anything the row needs.
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
  const {payer} = useActiveFeePayer(network);
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  const key = `${network}:${vault ?? ''}`;

  const [amount, setAmount] = useState(() => gasReserveAmount(network, vault));
  const [picking, setPicking] = useState(false);
  // The page holds still while a fee coin is being dragged, as the Overview does for its lists.
  const [dragging, setDragging] = useState(false);

  // Switching vault or chain while the page is open changes which setting it is editing.
  useEffect(() => {
    setAmount(gasReserveAmount(network, vault));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const catalog = useAssetCatalog(network);
  const bal = useVaultBalances(network);
  // Reported as it is edited — a new amount, or a new first coin after a drag — so the next
  // auto-yield sweep already leaves the new float.
  useSyncFeeReserve(network, vault, bal.balances, catalog);

  const choose = (v: string) => {
    setGasReserveAmount(network, vault, v);
    setAmount(v);
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      scrollEnabled={!dragging}
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <FeePayerSection />
      {payer === 'vault' ? (
        <>
          <View>
            <StableCoinAsGasCoins onDragging={setDragging} />
          </View>

          {/* The reserve is local, not on chain, so its row stays editable before activation; the coin
              that holds it is the first fee coin above that can (see resolveFeeReserve). */}
          <View style={styles.second}>
            <StableCoinAsGasLimits
              leading={{
                title: t('mobile.settings.gas_reserve_amount'),
                value: Number(amount) > 0 ? `$${amount}` : t('vault.none'),
                hint: t('mobile.settings.gas_reserve_hint'),
                onPress: () => setPicking(true),
              }}
            />
          </View>
        </>
      ) : null}

      <PickerSheet
        visible={picking}
        title={t('mobile.settings.gas_reserve_amount')}
        // "None" turns the reserve off: nothing is held back from Max, and the keeper sweeps it all.
        items={[{key: '0', label: t('vault.none')}, ...choices.map((n) => ({key: String(n), label: `$${n}`}))]}
        selected={amount}
        onSelect={choose}
        onClose={() => setPicking(false)}
      />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    // The gap here is the one INSIDE a section — a card and the footnote that explains it. The
    // space BETWEEN sections is set on the second card, so the two kinds of distance stay
    // distinguishable.
    body: {padding: 16, gap: 8, paddingBottom: 32},
    second: {marginTop: 20},
  });

import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {makeSettingsStyles} from '@/components/SettingsRow';
import {VaultFeeSettings} from '@/components/VaultFeeSettings';
import {UseForFeesRow, OwnerWalletCard} from '@/components/FeePayer';
import {useNetwork} from '@/core/network-store';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {setFeePayer, type FeePayer} from '@/core/fee-payer-store';
import {useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Network fee: the two ways to pay it, each a row that says whether it is the one in use and opens
 * a page of its own.
 *
 * Each way's settings live on its page, reachable whichever is in use. They have to be: changing
 * the vault's fee coins is itself a vault write, paid the way the vault is set to pay — so a vault
 * whose only fee coin is one it holds none of can only change it with the owner wallet paying, and
 * that means opening the vault's page while the owner's is the one chosen.
 *
 * A Safe-owned vault has only the one way — the Safe sends no transactions of its own — so its page
 * is the vault's settings directly, with nothing to choose.
 */
export function NetworkFeeScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const {payer, canChoose, vault} = useActiveFeePayer(network);
  // The page holds still while a fee coin is being dragged, as the Overview does for its lists.
  const [dragging, setDragging] = useState(false);

  if (!canChoose) {
    return (
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical scrollEnabled={!dragging} contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
        <VaultFeeSettings onDragging={setDragging} />
      </ScrollView>
    );
  }

  /**
   * One way to pay, as two targets: the title — with its check right after it — chooses it, and the
   * rest of the row to the right, chevron included, opens its settings.
   */
  const way = (p: FeePayer, title: string, route: 'NetworkFeeVault' | 'NetworkFeeOwner', last?: boolean) => (
    <View style={[styles.wayRow, !last && styles.rowDivider]}>
      <Pressable
        style={({pressed}) => [styles.wayPick, pressed && styles.pressed]}
        onPress={() => vault && setFeePayer(network, vault, p)}
        accessibilityRole="radio"
        accessibilityState={{checked: payer === p}}>
        <Text style={styles.rowTitle}>{title}</Text>
        {/* Always laid out, shown only when chosen, so the row keeps its height (see OptionRow). */}
        <Text style={[styles.check, payer !== p && styles.checkHidden]}>✓</Text>
      </Pressable>
      <Pressable
        style={({pressed}) => [styles.wayMore, pressed && styles.pressed]}
        onPress={() => nav.navigate(route)}
        accessibilityRole="button"
        accessibilityLabel={`${title} · ${t('vault.settings')}`}>
        <Text style={styles.chev}>›</Text>
      </Pressable>
    </View>
  );

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <View style={styles.group}>
        {way('vault', t('mobile.fees.payer_vault'), 'NetworkFeeVault')}
        {way('owner', t('mobile.fees.payer_owner'), 'NetworkFeeOwner', true)}
      </View>
    </ScrollView>
  );
}

/** Network fee › Pay from vault: use it, and the vault's fee coins, reserve and caps. */
export function NetworkFeeVaultScreen() {
  const styles = useStyles(makeStyles);
  const [dragging, setDragging] = useState(false);
  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical scrollEnabled={!dragging} contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <View style={styles.first}>
        <UseForFeesRow payer="vault" />
      </View>
      <VaultFeeSettings onDragging={setDragging} />
    </ScrollView>
  );
}

/** Network fee › Pay from owner wallet: use it, and the address to fund with what is in it. */
export function NetworkFeeOwnerScreen() {
  const styles = useStyles(makeStyles);
  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <View style={styles.first}>
        <UseForFeesRow payer="owner" />
      </View>
      <OwnerWalletCard />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    // The gap here is the one INSIDE a section — a card and the footnote that explains it. The
    // space BETWEEN sections is set on the cards that start one, so the two kinds of distance stay
    // distinguishable.
    body: {padding: 16, gap: 8, paddingBottom: 32},
    // The same distance as between the vault page's later sections (VaultFeeSettings `second`).
    first: {marginBottom: 20},
    // A way to pay: the title and its check choose it; everything to their right opens its settings.
    wayRow: {flexDirection: 'row', alignItems: 'stretch'},
    wayPick: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 15, paddingLeft: 16, paddingRight: 12, flexShrink: 1},
    wayMore: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 16, minWidth: 52},
    pressed: {opacity: 0.6},
  });

import React, {useState} from 'react';
import {Alert, Image, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import {makeSettingsStyles} from '@/components/SettingsRow';
import {SettingsIcon} from '@/components/SettingsIcon';
import {VaultFeeSettings} from '@/components/VaultFeeSettings';
import {OwnerWalletCard} from '@/components/FeePayer';
import {useNetwork} from '@/core/network-store';
import {useActiveFeePayer} from '@/vault/useFeePayer';
import {useVaults} from '@/core/vault-store';
import {useRotationOn} from '@/wallet/rotation-store';
import {setFeePayer, type FeePayer} from '@/core/fee-payer-store';
import {ownerEthBalance} from '@/vault/direct';
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
 * A Safe-owned vault, or one on quantum-safe keys, has only the one way — a Safe sends no
 * transactions of its own, and a one-time key holds no ETH. The page is the same either way: the
 * owner row is shown greyed out, with the reason under the card, rather than a different page that
 * left the owner wondering where the choice had gone.
 */
export function NetworkFeeScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const {payer, canChoose, vault, owner} = useActiveFeePayer(network);
  const isSafe = useVaults((s) => !!s.vaults.find((v) => v.index === s.activeIndex)?.safe);
  const rotating = useRotationOn(network, vault);
  const ownerOff = canChoose ? undefined : isSafe ? t('mobile.fees.owner_off_safe') : rotating ? t('mobile.fees.owner_off_quantum') : undefined;

  /**
   * Choosing a way to pay. The owner wallet with no ETH in it cannot pay a single fee, so it cannot
   * be chosen then: every write would stop at "not enough ETH" until the wallet is funded, so the
   * owner is told to fund it first. A balance that cannot be read does not stand in the way.
   */
  const choose = async (p: FeePayer) => {
    if (!vault || payer === p || (p === 'owner' && !canChoose)) return;
    if (p === 'owner' && owner) {
      const eth = await ownerEthBalance(network, owner).catch(() => null);
      if (eth === 0n) {
        Alert.alert(t('mobile.fees.owner_empty_title'), t('mobile.fees.owner_empty_body'));
        return;
      }
    }
    setFeePayer(network, vault, p);
  };

  /**
   * One way to pay, as two targets: the row chooses it — title, its check right after it, and the
   * space beyond — and only the chevron at the far end opens its settings. Choosing is what this
   * page is for, so it gets nearly all of the row; a tap anywhere but the end must not navigate.
   */
  /**
   * Each way's mark: the Bitty logo for the vault, and for the owner's own address a wallet on a
   * tinted square of the same size and corners, so the two read as a pair.
   */
  const payerIcon = (p: FeePayer) =>
    p === 'vault' ? (
      <Image source={require('@/assets/logo.png')} style={styles.payerLogo} />
    ) : (
      <SettingsIcon name="wallet" size={20} />
    );

  const way = (p: FeePayer, title: string, route: 'NetworkFeeVault' | 'NetworkFeeOwner', last?: boolean, off?: boolean) => (
    <View style={[styles.wayRow, !last && styles.rowDivider, off && styles.off]}>
      <Pressable
        disabled={off}
        // No pressed dimming: the check moving is the feedback, and dimming the title read as it
        // being highlighted.
        style={styles.wayPick}
        onPress={() => void choose(p)}
        accessibilityRole="radio"
        accessibilityState={{checked: payer === p, disabled: off}}>
        <View style={styles.titleLine}>
          {payerIcon(p)}
          <Text style={styles.rowTitle}>{title}</Text>
          {/* Always laid out, shown only when chosen, so the row keeps its height (see OptionRow). */}
          <Text style={[styles.check, payer !== p && styles.checkHidden]}>✓</Text>
        </View>
      </Pressable>
      <Pressable
        disabled={off}
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
        {way('owner', t('mobile.fees.payer_owner'), 'NetworkFeeOwner', true, !canChoose)}
      </View>
      {ownerOff ? <Text style={styles.groupFooter}>{ownerOff}</Text> : null}
    </ScrollView>
  );
}

/** Network fee › Pay from vault: the vault's fee coins, reserve and caps. Chosen on the page before. */
export function NetworkFeeVaultScreen() {
  const styles = useStyles(makeStyles);
  const [dragging, setDragging] = useState(false);
  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical scrollEnabled={!dragging} contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      <VaultFeeSettings onDragging={setDragging} />
    </ScrollView>
  );
}

/** Network fee › Pay from owner wallet: the address to fund, and what is in it. Chosen on the page before. */
export function NetworkFeeOwnerScreen() {
  const styles = useStyles(makeStyles);
  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
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
    // A way to pay: the row chooses it; only the chevron's own square at the end opens its settings.
    wayRow: {flexDirection: 'row', alignItems: 'stretch'},
    wayPick: {flex: 1, justifyContent: 'center', gap: 4, paddingVertical: 15, paddingLeft: 16},
    titleLine: {flexDirection: 'row', alignItems: 'center', gap: 8},
    payerLogo: {width: 20, height: 20, borderRadius: 5},
    wayMore: {width: 56, alignItems: 'center', justifyContent: 'center'},
    pressed: {opacity: 0.6},
    off: {opacity: 0.4},
  });

import React, {useMemo} from 'react';
import {ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';
import {SettingsIcon} from '@/components/SettingsIcon';
import {ProtocolIcon} from '@/components/ProtocolIcon';
import {useVaultVersionRow} from '@/components/useVaultVersionRow';
import {useAdapterVersions} from '@/components/useAdapterVersions';
import {useNetwork} from '@/core/network-store';
import {useActiveVaultAddress} from '@/core/active-vault';
import {isNamedProtocol, protocolDisplayName, protocolMeta} from '@/core/protocols';
import {
  autoUpgradeProtocol,
  autoUpgradeVault,
  setAutoUpgradeProtocol,
  setAutoUpgradeVault,
  useAutoUpgradeVersion,
} from '@/core/auto-upgrade-store';
import {formatVersion} from '@/vault/upgrade-adapter';

/**
 * Upgrade — one card, the vault first and then each protocol, a row apiece and all drawn alike,
 * under a column header (Protocol · Auto) as the Earn cards carry theirs. Each row's second line is
 * its version — "1.0.6", or "1.0.5 → 1.0.6" when a newer one is out.
 *
 * A row names what it is, gives its version on the second line, and ends with its Auto upgrade
 * switch. Tapping the row checks THAT one for a new
 * version — or, when one is already known, upgrades to it now (with the usual confirmation).
 * With the switch on, the next operation that needs it carries the upgrade in front of itself in
 * one multicall (see vault/auto-upgrade); every switch starts on.
 */
export function UpgradeScreen() {
  const {t} = useT();
  const styles = useStyles(makeStyles);
  const network = useNetwork((s) => s.network);
  const vault = useActiveVaultAddress(network);
  const version = useVaultVersionRow();
  const adapters = useAdapterVersions();
  // Redraw on a flip: the switches read through the store's functions.
  useAutoUpgradeVersion((s) => s.v);

  // A row per lineage that has a name: an adapter no table names is not something to decide about.
  const protocols = useMemo(
    () =>
      (adapters.statuses ?? []).flatMap((s) => {
        const name = s.addresses.map((a) => protocolMeta(network, a).name).find(isNamedProtocol);
        return name ? [{...s, name: protocolDisplayName(name)}] : [];
      }),
    [adapters.statuses, network],
  );

  const checking = t('mobile.settings.vault_checking');
  // The vault row's second line is its version. What the version row says besides — an app update
  // needed first, a lock in the way — still rides after it; "no new version" and "update available"
  // do not, the version already says both.
  const plain = [t('mobile.settings.vault_no_new_version'), t('vault.upgrade_available'), checking];
  const vaultNote = version.sub && !plain.includes(version.sub) ? version.sub : undefined;

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.page}>
      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={[styles.headerText, styles.headerName]}>{t('mobile.settings.upgrade_col_protocol')}</Text>
          <Text style={[styles.headerText, styles.autoCol]}>{t('mobile.settings.upgrade_col_auto')}</Text>
        </View>
        <UpgradeRow
          leading={<Image source={require('@/assets/logo.png')} style={styles.logo} />}
          title={t('mobile.settings.upgrade_vault_name')}
          sub={version.checking ? checking : vaultNote ? `${version.value ?? ''} · ${vaultNote}` : version.value}
          busy={version.confirming || version.checking}
          onPress={version.confirming ? undefined : version.onPress}
          on={vault ? autoUpgradeVault(network, vault) : true}
          onToggle={(v) => vault && setAutoUpgradeVault(network, vault, v)}
        />
        {adapters.statuses == null ? (
          <UpgradeRow leading={<SettingsIcon name="protocols" />} title={checking} busy />
        ) : (
          protocols.map((p) => {
            // The upgrade the vault can take for this lineage, tapped to run now.
            const up = adapters.upgrades.find((u) => p.upgrade && u.key === `${network}:${p.upgrade.oldProtocol}`);
            const mine = adapters.checking === p.lineage;
            return (
              <UpgradeRow
                key={p.lineage}
                leading={<ProtocolIcon name={p.name} size={29} />}
                // An adapter, not the protocol itself: the vault's own contract that talks to it.
                title={t('mobile.settings.upgrade_adapter', {name: p.name})}
                sub={mine ? checking : up ? up.value : formatVersion(p.version)}
                busy={mine || !!up?.confirming}
                onPress={up ? (up.confirming ? undefined : up.onPress) : () => adapters.recheck(p.lineage)}
                on={vault ? autoUpgradeProtocol(network, vault, p.lineage) : true}
                onToggle={(v) => vault && setAutoUpgradeProtocol(network, vault, p.lineage, v)}
              />
            );
          })
        )}
      </View>
      {version.sheet}
      {adapters.sheet}
    </ScrollView>
  );
}

/**
 * One row: mark, name, version under it, Auto upgrade switch.
 *
 * Its own row rather than {SettingsRow}, which is either a switch or a pressable row: this one is
 * both — the body checks or upgrades, the switch on its end flips Auto upgrade — so the switch sits
 * outside the pressable area, where its gesture cannot be taken for a tap on the row.
 */
function UpgradeRow({
  leading,
  title,
  sub,
  busy,
  onPress,
  on,
  onToggle,
}: {
  leading: React.ReactNode;
  title: string;
  sub?: string;
  busy?: boolean;
  onPress?: () => void;
  on?: boolean;
  onToggle?: (v: boolean) => void;
}) {
  const styles = useStyles(makeStyles);
  const c = useColors();
  return (
    <View style={styles.row}>
      <Pressable style={({pressed}) => [styles.rowBody, pressed && onPress && styles.pressed]} onPress={onPress} disabled={!onPress}>
        {leading}
        <View style={styles.text}>
          <View style={styles.titleLine}>
            <Text style={styles.title}>{title}</Text>
            {busy ? <ActivityIndicator color={c.subtext} size="small" /> : null}
          </View>
          {sub ? <Text style={styles.sub}>{sub}</Text> : null}
        </View>
      </Pressable>
      <View style={styles.autoCol}>{onToggle ? <Switch value={!!on} onValueChange={onToggle} /> : null}</View>
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: {flex: 1, backgroundColor: c.bg},
    page: {flexGrow: 1, padding: 16, gap: 20},
    // The Earn card: the card carries the padding, the header sits inside it, and every row draws a
    // hairline on its top edge — one under the header, one between rows.
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, paddingTop: 20, paddingBottom: 4},
    header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 10},
    headerText: {color: c.subtext, fontSize: 13, fontWeight: '600'},
    headerName: {flex: 1},
    // A fixed column, so the header's label sits over the switches whatever a name runs to.
    autoCol: {width: 64, alignItems: 'flex-end', textAlign: 'right'},
    row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    rowBody: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12},
    pressed: {opacity: 0.6},
    logo: {width: 29, height: 29, borderRadius: 7},
    text: {flex: 1},
    title: {color: c.text, fontSize: 15, fontWeight: '600'},
    sub: {color: c.subtext, fontSize: 13, marginTop: 2, fontVariant: ['tabular-nums']},
    titleLine: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6},
  });

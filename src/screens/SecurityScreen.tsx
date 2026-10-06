import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {Address} from 'viem';
import {Button} from '@/components/Button';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import type {Network} from '@/core/chain';
import {ownerVaultAddress} from '@/vault/read';
import {
  getRiskConfig,
  getTradeDisabledUntil,
  setNewPaymentProtection,
  setMaxSendValue,
  setMaxSendInterval,
  setChangeTimelock,
  pauseTradingUntil,
  wrapNative,
  type RiskConfig,
} from '@/vault/risk';

import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {useConfirmAction} from '@/components/ConfirmAction';
import {relayGasFor} from '@/vault/fee-quote';
import {useColors, useStyles, type Colors} from '@/theme';
import {SettingsRow, SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {revealMnemonic} from '@/wallet/keyring';
import {useRevealGuard} from '@/core/device-security';
import {useAssetCatalog} from '@/core/asset-catalog';

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

// Durations edit in hours; maxSendValue edits in whole stablecoin tokens.
const secToHours = (s: bigint) => {
  const h = Number(s) / HOUR;
  return Number.isInteger(h) ? String(h) : h.toFixed(2);
};
const hoursToSec = (h: string) => BigInt(Math.max(0, Math.round(Number(h) * HOUR)));

// Trade-pause presets (seconds from now); 0 = resume (label is translated at render).
const PAUSES: {label: string; secs: number}[] = [
  {label: 'Resume', secs: 0},
  {label: '1h', secs: HOUR},
  {label: '6h', secs: 6 * HOUR},
  {label: '24h', secs: 24 * HOUR},
  {label: '3d', secs: 3 * 24 * HOUR},
  {label: '7d', secs: 7 * 24 * HOUR},
];

type T = ReturnType<typeof useT>['t'];

function fmtUntil(t: T, ts: bigint): string {
  if (ts === 0n || Number(ts) <= now()) return t('mobile.vault.trading_enabled');
  return t('mobile.vault.paused_until', {time: new Date(Number(ts) * 1000).toLocaleString()});
}

/**
 * Security — owner protection controls. Payment risk (delays & send caps that govern the owner's and
 * operators' payments; tightening applies at once, loosening waits out the change timelock), a trading
 * pause (panic switch), and a wrap-idle-ETH utility. All gasless, Face-ID-gated on-device.
 */
export function SecurityScreen() {
  const {t} = useT();
  const lock = useWallet((s) => s.lock);
  const [phrase, setPhrase] = useState<string | null>(null);
  // Hide the phrase while the screen is recorded, and pull it + warn if a screenshot is taken.
  const reveal = useRevealGuard();
  useEffect(() => {
    if (reveal.screenshotCount > 0 && phrase) {
      setPhrase(null);
      Alert.alert(
        'Screenshot detected',
        'Your recovery phrase was hidden. Never keep it in Photos or anywhere synced to the cloud — write it on paper.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.screenshotCount]);
  const onReveal = async () => {
    try {
      const m = await revealMnemonic();
      if (m) setPhrase(m);
    } catch {
      // cancelled biometric prompt
    }
  };

  const styles = useStyles(makeStyles);
  const c = useColors();
  const unlocked = useWallet((s) => s.unlocked);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const stable = useAssetCatalog(network).find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;
  type Acct = Awaited<ReturnType<typeof getSigner>>;

  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const [pausedUntil, setPausedUntil] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string | null>(null);

  // Editable field buffers (strings), seeded from the on-chain values.
  const [buf, setBuf] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!vault) return;
    getRiskConfig(vault, network).then((r) => {
      setRisk(r);
      setBuf({
        newPaymentProtection: secToHours(r.newPaymentProtection),
        changeTimelock: secToHours(r.changeTimelock),
        maxSendInterval: secToHours(r.maxSendInterval),
        maxSendValue: String(r.maxSendValue),
      });
    });
    getTradeDisabledUntil(vault, network).then(setPausedUntil);
  }, [vault, network]);
  useEffect(load, [load]);

  const {ask, sheet} = useConfirmAction();

  const runNow = async (key: string, title: string, fn: (acct: Acct) => Promise<string>): Promise<boolean> => {
    if (!vault || !stable) return false;
    setBusy(key);
    const tx = showTx(title, network);
    try {
      const acct = await getSigner();
      tx.success(await fn(acct));
      load();
      return true;
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
      return false;
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

  // One risk field: label, current display, editable input, Save (enabled only when changed & valid).
  const RISK_FIELDS: {
    key: keyof RiskConfig;
    label: string;
    unit: string;
    hint: string;
    parse: (s: string) => bigint;
    setter: (o: {account: Acct; vault: Address; network: Network; value: bigint; stableCoin: Address}) => Promise<string>;
  }[] = [
    {
      key: 'newPaymentProtection',
      label: t('mobile.vault.new_payment_delay'),
      unit: t('vault.time_unit.hours'),
      hint: t('mobile.vault.new_payment_delay_hint'),
      parse: hoursToSec,
      setter: setNewPaymentProtection,
    },
    {
      key: 'maxSendValue',
      label: t('mobile.vault.max_cumulative_send'),
      unit: stable?.symbol ?? t('mobile.vault.tokens'),
      hint: t('mobile.vault.max_cumulative_send_hint'),
      parse: (s) => BigInt(Math.max(0, Math.floor(Number(s)))),
      setter: setMaxSendValue,
    },
    {
      key: 'maxSendInterval',
      label: t('mobile.vault.send_window'),
      unit: t('vault.time_unit.hours'),
      hint: t('mobile.vault.send_window_hint'),
      parse: hoursToSec,
      setter: setMaxSendInterval,
    },
    {
      key: 'changeTimelock',
      label: t('mobile.vault.change_timelock'),
      unit: t('vault.time_unit.hours'),
      hint: t('mobile.vault.change_timelock_hint'),
      parse: hoursToSec,
      setter: setChangeTimelock,
    },
  ];

  const currentDisplay = (key: keyof RiskConfig): string =>
    key === 'maxSendValue' ? String(risk?.[key] ?? 0n) : secToHours(risk?.[key] ?? 0n);

  const onPause = (secs: number) => {
    const ts = secs === 0 ? 0n : BigInt(now() + secs);
    run('pause', t('mobile.vault.trading_pause'), (acct) =>
      pauseTradingUntil({account: acct, vault: vault!, network, timestamp: ts, stableCoin: stable!.address}),
    );
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.container} contentContainerStyle={styles.body}>
      {/**
        * The key, first.
        *
        * It used to be a "Security" group at the bottom of the Settings page, below the links to
        * the website, while this page — also called Security — held the vault's guardrails. Two
        * headings with one name, and the single most sensitive thing in the app was the furthest
        * from the row that claimed to be about security. It leads here instead: everything below
        * limits what the vault may do, and this is what grants it in the first place.
        */}
      <SettingsGroup>
        {phrase ? (
          <View style={[styles.phraseBox, styles.rowDivider]}>
            {reveal.captured ? (
              <Text style={styles.warn}>
                Hidden while your screen is being recorded or mirrored. Stop the recording to view
                your recovery phrase.
              </Text>
            ) : (
              <View style={styles.grid}>
                {phrase.split(' ').map((w, i) => (
                  <View key={`${w}-${i}`} style={styles.word}>
                    <Text style={styles.wordIdx}>{i + 1}</Text>
                    <Text style={styles.wordText}>{w}</Text>
                  </View>
                ))}
              </View>
            )}
            <Text style={styles.warn}>{t('mobile.settings.never_share')}</Text>
            <Pressable style={styles.smBtn} onPress={() => setPhrase(null)}>
              <Text style={styles.smBtnText}>{t('mobile.settings.hide')}</Text>
            </Pressable>
          </View>
        ) : (
          <SettingsRow icon="recovery" title={t('mobile.settings.recovery_phrase')} sub={t('mobile.settings.reveal_face_id')} onPress={onReveal} />
        )}
        <SettingsRow icon="lock" title={t('mobile.settings.lock')} onPress={lock} chevron={false} last />
      </SettingsGroup>

      {/* ── Payment risk ──────────────────────────────────────────────── */}
      <Text style={[styles.h, styles.h2]}>{t('mobile.vault.payment_risk')}</Text>
      <Text style={styles.hint}>{t('mobile.vault.payment_risk_hint')}</Text>

      {RISK_FIELDS.map((f) => {
        const val = buf[f.key] ?? '';
        const num = Number(val);
        const valid = val.trim() !== '' && Number.isFinite(num) && num >= 0;
        const changed = valid && val.trim() !== currentDisplay(f.key);
        const key = `risk-${f.key}`;
        return (
          <View key={f.key} style={styles.field}>
            <View style={styles.fieldHead}>
              <Text style={styles.fieldLabel}>{f.label}</Text>
              <Text style={styles.fieldUnit}>{f.unit}</Text>
            </View>
            <View style={styles.fieldRow}>
              <TextInput
                style={[styles.input, !valid && val !== '' && styles.inputErr]}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={c.subtext}
                value={val}
                onChangeText={(t) => setBuf((b) => ({...b, [f.key]: t}))}
              />
              <Pressable
                disabled={!changed || busy !== null}
                onPress={() =>
                  run(key, f.label, (acct) =>
                    f.setter({account: acct, vault: vault!, network, value: f.parse(val), stableCoin: stable!.address}),
                  )
                }
                style={[styles.saveBtn, (!changed || busy !== null) && styles.saveOff]}>
                <Text style={[styles.saveText, (!changed || busy !== null) && styles.saveTextOff]}>
                  {busy === key ? '…' : t('vault.save')}
                </Text>
              </Pressable>
            </View>
            <Text style={styles.fine}>{f.hint}</Text>
          </View>
        );
      })}

      {/* ── Trading pause ─────────────────────────────────────────────── */}
      <Text style={[styles.h, styles.h2]}>{t('mobile.vault.trading_pause')}</Text>
      <Text style={styles.hint}>{t('mobile.vault.trading_pause_hint', {status: fmtUntil(t, pausedUntil)})}</Text>
      <View style={styles.chips}>
        {PAUSES.map((p) => (
          <Pressable
            key={p.label}
            disabled={busy !== null}
            onPress={() => onPause(p.secs)}
            style={[styles.chip, p.label === 'Resume' && styles.resumeChip]}>
            <Text style={[styles.chipText, p.label === 'Resume' && styles.resumeText]}>
              {busy === 'pause' ? '…' : p.secs === 0 ? t('mobile.vault.resume') : p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── Utilities ─────────────────────────────────────────────────── */}
      <Text style={[styles.h, styles.h2]}>{t('mobile.vault.utilities')}</Text>
      <Button
        title={busy === 'wrap' ? t('mobile.vault.wrapping') : t('mobile.vault.wrap_idle_eth')}
        variant="secondary"
        loading={busy === 'wrap'}
        disabled={!unlocked || !vault || !stable || busy !== null}
        onPress={() =>
          run('wrap', t('mobile.vault.wrap_idle_eth'), (acct) => wrapNative({account: acct, vault: vault!, network, stableCoin: stable!.address}))
        }
      />
      <Text style={styles.fine}>{t('mobile.vault.wrap_idle_eth_hint')}</Text>
      {sheet}
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  // The row and group styles come from the shared settings row; the rest is this page's own.
  ...makeSettingsStyles(c),
  container: {flex: 1, backgroundColor: c.bg},
  phraseBox: {padding: 16, gap: 10},
  smBtn: {backgroundColor: c.bg, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderColor: c.border, alignSelf: 'flex-start'},
  smBtnText: {color: c.text, fontSize: 13, fontWeight: '600'},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between'},
  word: {width: '47%', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.bg, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12},
  wordIdx: {color: c.subtext, fontSize: 12, width: 18},
  wordText: {color: c.text, fontSize: 14, fontWeight: '600'},
  warn: {color: c.danger, fontSize: 12, lineHeight: 17},
  body: {flexGrow: 1, padding: 20, paddingBottom: 24, gap: 10},
  h: {color: c.text, fontSize: 20, fontWeight: '700'},
  h2: {marginTop: 24},
  hint: {color: c.subtext, fontSize: 13, lineHeight: 18},
  fine: {color: c.subtext, fontSize: 11, lineHeight: 15},
  field: {gap: 6, marginTop: 6},
  fieldHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline'},
  fieldLabel: {color: c.text, fontSize: 15, fontWeight: '600'},
  fieldUnit: {color: c.subtext, fontSize: 12, textTransform: 'uppercase'},
  fieldRow: {flexDirection: 'row', gap: 10},
  input: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    backgroundColor: c.input,
    color: c.text,
    paddingHorizontal: 12,
    fontSize: 17,
  },
  inputErr: {borderColor: c.danger},
  saveBtn: {
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.accent,
    backgroundColor: c.accentSoft,
  },
  saveOff: {borderColor: c.border, backgroundColor: c.card},
  saveText: {color: c.accent, fontSize: 14, fontWeight: '700'},
  saveTextOff: {color: c.subtext},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4},
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  chipText: {color: c.text, fontSize: 14, fontWeight: '600'},
  resumeChip: {borderColor: c.accent},
  resumeText: {color: c.accent},
});

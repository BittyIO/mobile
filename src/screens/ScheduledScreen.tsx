import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {SafeAreaView} from 'react-native-safe-area-context';
import {isAddress, type Address} from 'viem';
import {ConfirmButton} from '@/components/Button';
import {useConfirmAction} from '@/components/ConfirmAction';
import {shortAddress} from '@/core/format';
import {relayGasFor} from '@/vault/fee-quote';
import {exceedsMax} from '@/components/AmountInput';
import {TokenIcon} from '@/components/TokenIcon';
import {PendingSwitch} from '@/components/PendingSwitch';
import {Amount} from '@/components/Amount';
import {AssetPicker, PickerSheet} from '@/components/AssetPicker';
import {useVaultBalances} from '@/vault/useVaultBalances';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress, balanceOfSymbol} from '@/vault/read';
import {
  addScheduledPayment,
  updateScheduledPayment,
  removeScheduledPayment,
  payScheduledNow,
  fetchScheduledPayments,
  type ScheduledPayment,
} from '@/vault/payments';
import {ASSETS, assetMeta} from '@/core/assets';
import {useT} from '@/i18n';
import {showTx} from '@/components/Toast';
import {CopyAddress} from '@/components/CopyAddress';
import {useColors, useIsDark, useStyles, type Colors} from '@/theme';
import {displaySymbol, fmtNum} from '@/core/format';

// Duration presets between payments (seconds), the web's list; labels are web translation keys.
const DURATIONS = [
  {label: 'vault.duration_1_minute', secs: 60},
  {label: 'vault.duration_1_hour', secs: 3600},
  {label: 'vault.duration_1_day', secs: 86400},
  {label: 'vault.duration_1_week', secs: 604800},
  {label: 'vault.duration_30_days', secs: 2592000},
  {label: 'vault.duration_365_days', secs: 31536000},
];
// Payment-count shortcuts; any count 1–255 can be typed as well.
const COUNTS = [1, 4, 12, 52];

export function ScheduledScreen() {
  const {t, language} = useT();
  const styles = useStyles(makeStyles);
  const c = useColors();
  const account = useWallet((s) => s.account);
  const getSigner = useWallet((s) => s.signer);
  const owner = useWallet((s) => s.address);
  const network = useNetwork((s) => s.network);
  const assets = ASSETS[network];
  const stable = assets.find((a) => a.kind === 'stable');
  const vault = owner ? ownerVaultAddress(owner, network) : null;

  const dark = useIsDark();
  const [to, setTo] = useState('');
  const [sym, setSym] = useState(assets[0]?.symbol ?? 'USDC');
  const [amount, setAmount] = useState('');
  const [trigger, setTrigger] = useState('');
  // Duration between payments: a preset or a typed number of seconds (the web's "Custom").
  const [interval, setIntervalSecs] = useState('86400');
  const [sheet, setSheet] = useState<'count' | 'duration' | null>(null);
  // Start: ten minutes out by default, as on the web — the contract refuses a start in the past.
  const [start, setStart] = useState<Date>(() => new Date(Date.now() + 10 * 60 * 1000));
  const [count, setCount] = useState('1');
  const [immutable, setImmutable] = useState(false);
  const [payShort, setPayShort] = useState(false);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [list, setList] = useState<ScheduledPayment[]>([]);
  const [editId, setEditId] = useState<string | null>(null);

  const asset = assets.find((a) => a.symbol === sym);
  const countNum = Math.max(1, Math.min(255, Math.floor(Number(count) || 1)));
  const intervalNum = Math.max(1, Math.floor(Number(interval) || 0));
  const triggerOk = trigger.trim() === '' || isAddress(trigger.trim());
  // The duration pill reads the matching preset ("1 day") or Custom for a typed number of seconds.
  const durationLabel = (() => {
    const d = DURATIONS.find((x) => String(x.secs) === interval);
    return d ? t(d.label) : t('common.custom');
  })();
  // A scheduled payment pays from the vault's free balance each time it runs.
  const bal = useVaultBalances(network);
  const max = balanceOfSymbol(bal.balances, sym);
  // A balance that has not loaded is unknown, not zero.
  const balKnown = bal.balances != null;
  const over = exceedsMax(amount, max);
  const [pickerOpen, setPickerOpen] = useState(false);
  const canAdd =
    !!account && !!vault && !!asset && !!stable && isAddress(to) && triggerOk && Number(amount) > 0 && !over &&
    Number(count) >= 1 && Number(count) <= 255 && intervalNum >= 1 && !busy;

  const load = useCallback(() => {
    if (vault) fetchScheduledPayments(vault, network).then(setList);
  }, [vault, network]);
  useEffect(load, [load]);

  const onEdit = (p: ScheduledPayment) => {
    const m = assetMeta(network, p.assetAddress as Address);
    setTo(p.scheduledPaymentAddress);
    setSym(m.symbol);
    setAmount(String(Number(p.amount) / 10 ** m.decimals));
    const secs = String(Number(p.paymentInterval) || 86400);
    setIntervalSecs(secs);
    setCount(String(Number(p.paymentCount) || 1));
    const zero = !p.triggerAddress || /^0x0+$/.test(p.triggerAddress);
    setTrigger(zero ? '' : p.triggerAddress!);
    setImmutable(!!p.isImmutable);
    setPayShort(!!p.payWithInsufficientBalance);
    // The original start is in the past for a running payment; re-saving needs a future one.
    const orig = Number(p.startTimestamp) * 1000;
    setStart(new Date(Math.max(orig, Date.now() + 10 * 60 * 1000)));
    setEditId(p.id);
  };

  const onAdd = async () => {
    if (!vault || !asset || !stable) return;
    setBusy(true);
    const tx = showTx(editId ? t('vault.update_scheduled_payment') : t('vault.add_scheduled_payment'), network);
    try {
      const acct = await getSigner();
      const common = {
        account: acct,
        vault,
        network,
        recipient: to as Address,
        asset: asset.address,
        amount,
        // Never in the past: the contract rejects it, and a form left open drifts there.
        startTimestamp: Math.max(Math.floor(start.getTime() / 1000), Math.floor(Date.now() / 1000) + 60),
        intervalSeconds: intervalNum,
        count: countNum,
        stableCoin: stable.address,
        trigger: trigger.trim() ? (trigger.trim() as Address) : undefined,
        isImmutable: immutable,
        payWithInsufficientBalance: payShort,
      };
      tx.success(editId ? await updateScheduledPayment({...common, id: editId}) : await addScheduledPayment(common));
      setTo('');
      setAmount('');
      setTrigger('');
      setImmutable(false);
      setPayShort(false);
      setEditId(null);
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const {ask, sheet: confirmSheet} = useConfirmAction();

  const act = async (id: string, title: string, fn: (acct: Awaited<ReturnType<typeof getSigner>>) => Promise<string>) => {
    setActing(id);
    const tx = showTx(title, network);
    try {
      const acct = await getSigner();
      tx.success(await fn(acct));
      load();
    } catch (e) {
      tx.error(String((e as Error)?.message ?? e));
    } finally {
      setActing(null);
    }
  };

  // Paying early and removing a schedule are both relayed writes on a small row button, so each
  // asks first rather than firing on the tap that reached it.
  const onPay = (p: ScheduledPayment) =>
    ask({
      title: t('mobile.payments.pay_now'),
      message: shortAddress(p.scheduledPaymentAddress),
      gas: relayGasFor({transfer: 1}),
      run: () =>
        act(p.id, t('mobile.payments.pay_now'), (acct) =>
          payScheduledNow({account: acct, vault: vault!, network, id: p.id, stableCoin: stable!.address}),
        ).then(() => undefined),
    });
  const onRemove = (p: ScheduledPayment) =>
    ask({
      title: `${t('vault.remove')} · ${t('vault.scheduled')}`,
      message: shortAddress(p.scheduledPaymentAddress),
      gas: relayGasFor({}),
      run: () =>
        act(p.id, `${t('vault.remove')} · ${t('vault.scheduled')}`, (acct) =>
          removeScheduledPayment({account: acct, vault: vault!, network, id: p.id, stableCoin: stable!.address}),
        ).then(() => undefined),
    });

  const intervalText = (secs: string) => {
    const n = Number(secs);
    if (n === 0) return t('mobile.payments.interval_one_time');
    if (n % 604800 === 0) return t('mobile.payments.every_weeks', {n: n / 604800});
    if (n % 86400 === 0) return t('mobile.payments.every_days', {n: n / 86400});
    return t('mobile.payments.every_hours', {n: Math.round(n / 3600)});
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* The scroll view is the whole page, so a drag anywhere scrolls; the button holds the bottom. */}
      <ScrollView showsVerticalScrollIndicator={false} alwaysBounceVertical contentInsetAdjustmentBehavior="automatic" style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {list.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.label}>{t('vault.scheduled')}</Text>
            {list.map((p) => {
              const m = assetMeta(network, p.assetAddress as Address);
              const amt = Number(p.amount) / 10 ** m.decimals;
              return (
                <View key={p.id} style={styles.item}>
                  <View style={styles.itemLine}>
                    <Text style={styles.itemText}>
                      {amt.toLocaleString(language, {maximumFractionDigits: 6})} {displaySymbol(m.symbol)} →{' '}
                    </Text>
                    <CopyAddress address={p.scheduledPaymentAddress} label={`${p.scheduledPaymentAddress.slice(0, 6)}…${p.scheduledPaymentAddress.slice(-4)}`} textStyle={styles.itemText} />
                  </View>
                  <Text style={styles.itemSub}>
                    {intervalText(p.paymentInterval)} · {t('mobile.payments.starts_on', {date: new Date(Number(p.startTimestamp) * 1000).toLocaleDateString(language)})}
                    {p.approved ? '' : ` · ${t('vault.pending_approval')}`}
                  </Text>
                  <View style={styles.itemBtns}>
                    <Pressable disabled={acting !== null} onPress={() => onPay(p)} style={[styles.smBtn, styles.payBtn]}>
                      <Text style={styles.payText}>{acting === p.id ? '…' : t('mobile.payments.pay_now')}</Text>
                    </Pressable>
                    <Pressable disabled={busy} onPress={() => onEdit(p)} style={[styles.smBtn, styles.editBtn]}>
                      <Text style={styles.editText}>{t('vault.edit')}</Text>
                    </Pressable>
                    <Pressable disabled={acting !== null} onPress={() => onRemove(p)} style={[styles.smBtn, styles.rmBtn]}>
                      <Text style={styles.rmText}>{t('vault.remove')}</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        <Text style={styles.label}>{editId ? t('mobile.payments.edit_payment') : t('vault.add_scheduled_payment')}</Text>
        <View style={styles.card}>
          <TextInput
            style={[styles.toInput, to.length > 0 && !isAddress(to) && styles.inputErr]}
            placeholder={t('mobile.vault.enter_address')}
            placeholderTextColor={c.subtext}
            autoCapitalize="none"
            autoCorrect={false}
            value={to}
            onChangeText={setTo}
          />

          {/* Amount per payment: "Balance: … Max" above, the asset pill inside the field, as on Send. */}
          <View style={styles.line}>
            <Text style={styles.balance}>
              {t('vault.balance')}: {balKnown ? <Amount v={fmtNum(Number(max))} /> : '—'} {balKnown ? displaySymbol(sym) : ''}
            </Text>
            <View style={[styles.field, over && styles.fieldOver]}>
              <TextInput
                style={styles.fieldInput}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={c.subtext}
                value={amount}
                onChangeText={setAmount}
              />
              <Pressable style={styles.assetPill} onPress={() => setPickerOpen(true)}>
                <TokenIcon symbol={sym} size={20} />
                <Text style={styles.assetSym}>{displaySymbol(sym)}</Text>
              </Pressable>
            </View>
            {over ? <Text style={styles.over}>{t('vault.exceeds_balance')}</Text> : null}
          </View>

          {/* Trigger (optional): who may fire the payment; empty = anyone / the keeper. */}
          <View style={styles.optRow}>
            <Text style={styles.optLabel}>{t('vault.trigger_address')} {t('vault.optional')}</Text>
            <TextInput
              style={[styles.toInput, !triggerOk && styles.inputErr]}
              placeholder={t('mobile.vault.enter_address')}
              placeholderTextColor={c.subtext}
              autoCapitalize="none"
              autoCorrect={false}
              value={trigger}
              onChangeText={setTrigger}
            />
          </View>

          {/* Payment count and duration: each a field with its presets in a pill inside it, like the
              amount field. Type a value, or tap the pill to pick one. */}
          <View style={styles.optRow}>
            <Text style={styles.optLabel}>{t('vault.payment_count')}</Text>
            <View style={[styles.field, !(Number(count) >= 1 && Number(count) <= 255) && styles.fieldOver]}>
              <TextInput style={styles.fieldInput} keyboardType="number-pad" value={count} onChangeText={setCount} placeholder="1" placeholderTextColor={c.subtext} />
              <Pressable style={styles.assetPill} onPress={() => setSheet('count')}>
                <Text style={styles.assetSym}>{COUNTS.includes(Number(count)) ? `×${count}` : t('common.custom')}</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.optRow}>
            <Text style={styles.optLabel}>{t('vault.duration_between_payments')}</Text>
            <View style={[styles.field, !(intervalNum >= 1) && styles.fieldOver]}>
              <TextInput style={styles.fieldInput} keyboardType="number-pad" value={interval} onChangeText={setIntervalSecs} placeholder={t('mobile.payments.seconds_placeholder')} placeholderTextColor={c.subtext} />
              <Pressable style={styles.assetPill} onPress={() => setSheet('duration')}>
                <Text style={styles.assetSym}>{durationLabel}</Text>
              </Pressable>
            </View>
          </View>

          {/* The two flags, as rows inside the card. */}
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>{t('vault.immutable')}</Text>
            <PendingSwitch value={immutable} onValueChange={setImmutable} />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>{t('vault.pay_with_insufficient_balance')}</Text>
            <PendingSwitch value={payShort} onValueChange={setPayShort} />
          </View>

          {/* Start time last: the system date-time picker. */}
          <View style={styles.optRowInline}>
            <Text style={styles.optLabel}>{t('vault.start_time')}</Text>
            <DateTimePicker
              value={start}
              mode="datetime"
              display="compact"
              minimumDate={new Date()}
              themeVariant={dark ? 'dark' : 'light'}
              accentColor={c.accent}
              onChange={(_, d) => d && setStart(d)}
            />
          </View>
        </View>
      </ScrollView>

      <PickerSheet
        visible={sheet === 'count'}
        title={t('vault.payment_count')}
        items={COUNTS.map((n) => ({key: String(n), label: String(n)}))}
        selected={count}
        onSelect={setCount}
        onClose={() => setSheet(null)}
      />
      <PickerSheet
        visible={sheet === 'duration'}
        title={t('vault.duration_between_payments')}
        items={DURATIONS.map((d) => ({key: String(d.secs), label: t(d.label)}))}
        selected={interval}
        onSelect={setIntervalSecs}
        onClose={() => setSheet(null)}
      />
      <AssetPicker visible={pickerOpen} title={t('vault.asset')} assets={assets} selected={sym} onSelect={setSym} onClose={() => setPickerOpen(false)} />

      <View style={styles.footer}>
      <ConfirmButton onPress={onAdd} disabled={!canAdd} />
      {confirmSheet}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: c.bg},
  scroll: {flex: 1},
  body: {flexGrow: 1, padding: 20, gap: 10, paddingBottom: 16},
  footer: {paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20},
  section: {gap: 8, marginBottom: 8},
  label: {color: c.subtext, fontSize: 15, fontWeight: '600', paddingHorizontal: 16, marginTop: 8},
  card: {backgroundColor: c.card, borderRadius: 20, padding: 12, gap: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border},
  toInput: {height: 44, borderRadius: 10, backgroundColor: c.input, color: c.text, paddingHorizontal: 12, fontSize: 15, fontFamily: 'Menlo'},
  line: {gap: 6},
  balance: {color: c.subtext, fontSize: 12},
  field: {flexDirection: 'row', alignItems: 'center', height: 56, borderRadius: 12, backgroundColor: c.input, paddingLeft: 16, paddingRight: 8},
  fieldOver: {borderWidth: 1, borderColor: c.danger},
  fieldInput: {flex: 1, color: c.text, fontSize: 17, paddingVertical: 0},
  assetPill: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.neutralSoft, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10},
  assetSym: {color: c.text, fontSize: 14, fontWeight: '700'},
  over: {color: c.danger, fontSize: 12},
  optRow: {gap: 8},
  optRowInline: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  optLabel: {color: c.subtext, fontSize: 12, fontWeight: '600'},
  switchRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44, paddingHorizontal: 4},
  switchLabel: {color: c.text, fontSize: 15, flex: 1, flexShrink: 1},
  item: {backgroundColor: c.card, borderRadius: 20, padding: 14, gap: 8},
  itemLine: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap'},
  itemText: {color: c.text, fontSize: 14, fontWeight: '600'},
  itemSub: {color: c.subtext, fontSize: 12},
  itemBtns: {flexDirection: 'row', gap: 8},
  smBtn: {paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1},
  payBtn: {borderColor: c.accent, backgroundColor: c.accentSoft},
  payText: {color: c.accent, fontSize: 13, fontWeight: '700'},
  editBtn: {borderColor: c.border},
  editText: {color: c.text, fontSize: 13, fontWeight: '700'},
  rmBtn: {borderColor: c.danger},
  rmText: {color: c.danger, fontSize: 13, fontWeight: '700'},
  inputErr: {borderWidth: 1, borderColor: c.danger},
});

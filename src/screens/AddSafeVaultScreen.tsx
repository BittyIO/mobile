import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {StackActions, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '@/App';
import Clipboard from '@react-native-clipboard/clipboard';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {getAddress, isAddress, type Address} from 'viem';
import {networkLabel, useNetwork} from '@/core/network-store';
import {planSafeDeploy, SafeReplicateError, type SafeDeploy} from '@/vault/safe-replicate';
import {deploySafeFromKey} from '@/vault/safe-deploy';
import {planNewSafe, type NewSafe} from '@/vault/safe-create';
import {showToast} from '@/components/Toast';
import {useVaults} from '@/core/vault-store';
import {ownerVaultAddress} from '@/vault/read';
import {vaultOwnerOf} from '@/vault/owned-vaults';
import {fetchSafe, SafeApiError, type SafeInfo} from '@/vault/safe';
import * as keyring from '@/wallet/keyring';
import {useWallet} from '@/wallet/store';
import {Button} from '@/components/Button';
import {SecretKeyInput} from '@/components/SecretKeyInput';
import {QrScanner} from '@/components/QrScanner';
import {SettingsIcon} from '@/components/SettingsIcon';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors, MONO} from '@/theme';

/** An address shortened to its first and last six: 0x111111…000000. */
const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/** Line-drawn marks used on this page: scan (lucide ScanLine), the footnote's lock, and an alert. */
function Glyph({name, color, size = 20}: {name: 'scan' | 'lock' | 'alert'; color: string; size?: number}) {
  const st = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'scan' ? (
        <>
          <Path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" {...st} />
          <Path d="M7 12h10" {...st} />
        </>
      ) : name === 'lock' ? (
        <>
          <Rect x={4} y={11} width={16} height={10} rx={2} {...st} />
          <Path d="M8 11V7a4 4 0 0 1 8 0v4" {...st} />
        </>
      ) : (
        <>
          <Circle cx={12} cy={12} r={10} {...st} />
          <Path d="M12 8v4M12 16h.01" {...st} />
        </>
      )}
    </Svg>
  );
}

/**
 * Settings › Choose vault › Add a Safe vault.
 *
 * A Safe vault is signed for by one of the Safe's owners, and that owner is a key the user already
 * has somewhere else — a hardware wallet, MetaMask, a script — not one of this phrase's. So the page
 * is two steps, each a card with its number, ticked once it is done:
 *
 * 1. The owner's private key, imported onto this phone (or one imported before). It is kept in the
 *    Keychain behind Face ID like the phrase, never sent anywhere, and not restored by the phrase.
 * 2. The Safe's other owners and its threshold (2 of 3, say): Create Safe deploys a standard Safe
 *    1.4.1 with them from the key in step 1, which pays the network fee — no Safe{Wallet} needed.
 *    Or, for a Safe that already exists, its address, typed, pasted or scanned; one on another
 *    network only is activated here at the same address. Either way its vault is the one the
 *    factory derives from the Safe, and the key is checked against the Safe's owners.
 *
 * Added, the vault is put in front and the user is taken back to the Overview, as choosing a vault
 * does.
 */
export function AddSafeVaultScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const network = useNetwork((s) => s.network);
  const selectVault = useWallet((s) => s.selectVault);

  const [keys, setKeys] = useState<Address[]>(() => keyring.importedKeys());
  const [key, setKey] = useState<Address | null>(() => keyring.importedKeys().at(-1) ?? null);
  // The import field: open by itself when there is no key to pick yet.
  const [importing, setImporting] = useState(() => keyring.importedKeys().length === 0);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  // The address fields sit low on the page: focused, they are scrolled up above the keyboard (once
  // it is up and the insets have grown), so what is typed or pasted is seen.
  const scroll = useRef<ScrollView>(null);
  const reveal = () => setTimeout(() => scroll.current?.scrollToEnd({animated: true}), 300);
  // A Safe that is on another network and not this one: offered to be activated here, the same Safe
  // at the same address, sent and paid for by the imported owner key.
  const [copyOffer, setCopyOffer] = useState<{safe: Address; plan: SafeDeploy} | null>(null);
  // Step 2: a new Safe (the key + these owners, `threshold` of them to sign), or an existing one.
  const [existing, setExisting] = useState(false);
  const [others, setOthers] = useState<Address[]>([]);
  const [ownerDraft, setOwnerDraft] = useState('');
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(1);
  const owners = key ? [key, ...others.filter((o) => o.toLowerCase() !== key.toLowerCase())] : others;
  // The new multisig's address, worked out as the owners and threshold change: what Create deploys.
  const [plan, setPlan] = useState<NewSafe | null>(null);
  const [planError, setPlanError] = useState(false);
  const ownersSig = owners.join(',');
  useEffect(() => {
    setPlan(null);
    setPlanError(false);
    if (!key || existing) return;
    let live = true;
    planNewSafe({network, owners, threshold})
      .then((p) => live && setPlan(p))
      .catch(() => live && setPlanError(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, ownersSig, threshold, existing]);

  const addOwner = (raw = ownerDraft) => {
    const a = raw.trim();
    if (!isAddress(a)) return setOwnerError(t('mobile.safe.owner_invalid'));
    if (owners.some((o) => o.toLowerCase() === a.toLowerCase())) return setOwnerError(t('mobile.safe.owner_duplicate'));
    setOthers((o) => [...o, getAddress(a)]);
    // A majority of the owners by default (2/2, 2/3, 3/4); a chip below picks any other.
    setThreshold(Math.floor((owners.length + 1) / 2) + 1);
    setOwnerDraft('');
    setOwnerError(null);
  };
  const removeOwner = (a: Address) => {
    setOthers((o) => o.filter((x) => x !== a));
    setThreshold((n) => Math.max(1, Math.min(n, owners.length - 1)));
  };

  /** Deploy the new Safe from the key, then list its vault and go back, as Add does. */
  const onCreate = () => {
    if (!key) return;
    Keyboard.dismiss();
    setError(null);
    const net = networkLabel(network, t);
    Alert.alert(
      t('mobile.safe.create_confirm_title', {network: net}),
      `${t('mobile.safe.threshold_of', {n: threshold, total: owners.length})}\n\n${t('mobile.safe.pays_fee', {address: key})}`,
      [
        {text: t('common.cancel'), style: 'cancel'},
        {
          text: t('mobile.safe.create_button'),
          onPress: async () => {
            setBusy(true);
            try {
              // The address shown is the one deployed: worked out again only if it was not ready.
              const p = plan ?? (await planNewSafe({network, owners, threshold}));
              const info = await deploySafeFromKey({key, network, factory: p.factory, data: p.data, safe: p.address});
              if (!info) return;
              selectVault(useVaults.getState().addSafe(info.address, {address: key}));
              showToast('success', t('mobile.safe.created'));
              nav.dispatch(StackActions.popToTop());
            } catch (e) {
              setError(String((e as Error)?.message ?? e));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const addressOk = isAddress(draft.trim());

  const onImport = async () => {
    setKeyError(null);
    const pk = keyring.parsePrivateKey(keyDraft);
    if (!pk) return setKeyError(t('mobile.safe.invalid_key'));
    try {
      const address = await keyring.importPrivateKey(pk);
      Keyboard.dismiss();
      setKeyDraft('');
      setKeys(keyring.importedKeys());
      setKey(address);
      setImporting(false);
      setError(null);
    } catch (e) {
      setKeyError(String((e as Error)?.message ?? e));
    }
  };

  /**
   * The Safe at the address entered, and the vault the factory derives from it. Only a Safe's own
   * address is taken: the vault is the Safe's, so the Safe is what the user names.
   */
  const resolve = async (address: Address): Promise<{safe: Address; info: SafeInfo; vault: Address} | {missing: Address} | string> => {
    try {
      const info = await fetchSafe(network, address);
      const vault = ownerVaultAddress(address, network);
      // Created by this Safe, but handed on since: no longer the Safe's.
      const now = await vaultOwnerOf(network, vault);
      if (now && now.toLowerCase() !== address.toLowerCase()) return t('mobile.safe.vault_elsewhere', {address: now});
      return {safe: address, info, vault};
    } catch (e) {
      if (e instanceof SafeApiError && e.reason === 'safe-not-found') return {missing: address};
      return String((e as Error)?.message ?? e);
    }
  };

  /**
   * No Safe here: is it on another network, and can it land here at the same address? Then it is
   * offered; otherwise the reason is said.
   */
  const offerCopy = async (safe: Address) => {
    try {
      setCopyOffer({safe, plan: await planSafeDeploy(safe, network)});
    } catch (e) {
      const reason = e instanceof SafeReplicateError ? e.reason : null;
      setError(
        reason === 'mismatch'
          ? t('mobile.safe.copy_not_possible', {network: networkLabel(network, t)})
          : reason === 'unknown-creation'
            ? t('mobile.safe.copy_unknown')
            : reason === 'not-found'
              ? t('mobile.safe.not_a_safe')
              : String((e as Error)?.message ?? e),
      );
    }
  };

  /** Activate the Safe on this network from the imported key, then add its vault as usual. */
  const onCopy = () => {
    if (!copyOffer || !key) return;
    const net = networkLabel(network, t);
    Alert.alert(t('mobile.safe.copy_confirm_title', {network: net}), t('mobile.safe.pays_fee', {address: key}), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('mobile.safe.copy_button', {network: net}),
        onPress: async () => {
          setBusy(true);
          try {
            const info = await deploySafeFromKey({key, network, factory: copyOffer.plan.factory, data: copyOffer.plan.data, safe: copyOffer.safe});
            if (!info) return;
            setCopyOffer(null);
            showToast('success', t('mobile.safe.activated', {network: net}));
          } catch (e) {
            setBusy(false);
            return setError(String((e as Error)?.message ?? e));
          }
          setBusy(false);
          await onAdd();
        },
      },
    ]);
  };

  const onAdd = async () => {
    setError(null);
    setCopyOffer(null);
    const raw = draft.trim();
    if (!key) return;
    if (!isAddress(raw)) return setError(t('mobile.safe.invalid_address'));
    Keyboard.dismiss();
    setBusy(true);
    try {
      const found = await resolve(getAddress(raw));
      if (typeof found === 'string') return setError(found);
      if ('missing' in found) return await offerCopy(found.missing);
      const {safe, info, vault} = found;
      if (!info.supported) return setError(t('mobile.safe.unsupported', {problems: info.problems.join(', ')}));
      if (!info.owners.some((o) => o.toLowerCase() === key.toLowerCase())) return setError(t('mobile.safe.key_not_owner', {address: key}));
      // A vault the Safe was given keeps its first owner's address, on this chain only.
      const at = vault.toLowerCase() === ownerVaultAddress(safe, network).toLowerCase() ? undefined : {vault, network};
      selectVault(useVaults.getState().addSafe(safe, {address: key}, at));
      nav.dispatch(StackActions.popToTop());
    } finally {
      setBusy(false);
    }
  };

  const paste = async (into: (v: string) => void) => into((await Clipboard.getString()).trim());

  /** One step's card: its number (a tick once done), its title, what it asks for, and a footnote. */
  const step = (n: number, title: string, done: boolean, off: boolean, body: React.ReactNode, note?: React.ReactNode) => (
    <View style={[styles.card, off && styles.cardOff]}>
      <View style={styles.stepHead}>
        <View style={[styles.badge, done ? styles.badgeDone : off ? styles.badgeOff : null]}>
          <Text style={[styles.badgeText, off && !done && styles.badgeTextOff]}>{done ? '✓' : n}</Text>
        </View>
        <Text style={styles.stepTitle}>{title}</Text>
      </View>
      {body}
      {note}
    </View>
  );

  const keyBody =
    keys.length > 0 && !importing ? (
      <View style={styles.options}>
        {keys.map((a) => {
          const on = key === a;
          return (
            <Pressable
              key={a}
              style={({pressed}) => [styles.option, on && styles.optionOn, pressed && styles.pressed]}
              onPress={() => {
                setKey(a);
                setError(null);
              }}
              accessibilityRole="radio"
              accessibilityState={{checked: on}}>
              <SettingsIcon name="wallet" size={32} />
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>{t('mobile.safe.imported_key')}</Text>
                <Text style={styles.mono}>{shortAddr(a)}</Text>
              </View>
              <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
            </Pressable>
          );
        })}
        <Pressable style={({pressed}) => [styles.textBtn, pressed && styles.pressed]} onPress={() => setImporting(true)} hitSlop={6}>
          <Text style={styles.link}>{`＋ ${t(keys.length ? 'mobile.safe.import_another' : 'mobile.safe.import_key')}`}</Text>
        </Pressable>
      </View>
    ) : (
      <View style={styles.gap10}>
        <SecretKeyInput
          value={keyDraft}
          onChangeText={(v) => {
            setKeyDraft(v);
            setKeyError(null);
          }}
          onSubmit={onImport}
          error={!!keyError}
        />
        {keyError ? <Text style={styles.fieldError}>{keyError}</Text> : null}
        <View style={styles.actions}>
          {keys.length > 0 ? (
            <Pressable
              style={({pressed}) => [styles.textBtn, pressed && styles.pressed]}
              onPress={() => {
                setImporting(false);
                setKeyDraft('');
                setKeyError(null);
              }}
              hitSlop={6}>
              <Text style={styles.cancel}>{t('common.cancel')}</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={({pressed}) => [styles.smallBtn, !keyDraft.trim() && styles.smallBtnOff, pressed && styles.pressed]}
            onPress={onImport}
            disabled={!keyDraft.trim()}>
            <Text style={styles.smallBtnText}>{t('mobile.safe.import')}</Text>
          </Pressable>
        </View>
      </View>
    );

  const vaultBody = (
    <View style={[styles.inputWrap, !!error && styles.inputWrapError]}>
      <TextInput
        style={[styles.input, styles.inputMono]}
        value={draft}
        onChangeText={(v) => {
          setDraft(v);
          setError(null);
        }}
        placeholder={t('mobile.safe.vault_address')}
        onFocus={reveal}
        placeholderTextColor={c.subtext}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        editable={!!key}
      />
      {!draft && key ? (
        <Pressable style={({pressed}) => [styles.pill, pressed && styles.pressed]} onPress={() => paste(setDraft)} hitSlop={6}>
          <Text style={styles.pillText}>{t('mobile.safe.paste')}</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={({pressed}) => [styles.scanBtn, pressed && styles.pressed]}
        onPress={() => {
          Keyboard.dismiss();
          setScanning(true);
        }}
        disabled={!key}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.scan.scan')}>
        <Glyph name="scan" color={c.accent} />
      </Pressable>
    </View>
  );

  const ownersBody = (
    <View style={styles.gap10}>
      {owners.map((a, i) => (
        <View key={a} style={styles.ownerRow}>
          <View style={styles.optionText}>
            <Text style={styles.ownerAddr}>{shortAddr(a)}</Text>
            {i === 0 ? <Text style={styles.hint}>{t('mobile.safe.owner_you')}</Text> : null}
          </View>
          {i > 0 ? (
            <Pressable onPress={() => removeOwner(a)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('vault.remove')}>
              <Text style={styles.remove}>×</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      <View style={[styles.inputWrap, !!ownerError && styles.inputWrapError]}>
        <TextInput
          style={[styles.input, styles.inputMono]}
          value={ownerDraft}
          onChangeText={(v) => {
            setOwnerDraft(v);
            setOwnerError(null);
          }}
          placeholder={t('mobile.safe.other_owner')}
          onFocus={reveal}
          placeholderTextColor={c.subtext}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={!!key}
          onSubmitEditing={() => addOwner()}
        />
        <Pressable
          style={({pressed}) => [styles.pill, pressed && styles.pressed]}
          onPress={async () => (ownerDraft ? addOwner() : addOwner(await Clipboard.getString()))}
          disabled={!key}
          hitSlop={6}>
          <Text style={styles.pillText}>{ownerDraft ? t('mobile.safe.add_owner') : t('mobile.safe.paste')}</Text>
        </Pressable>
      </View>
      {ownerError ? <Text style={styles.fieldError}>{ownerError}</Text> : null}

      {/* How many must sign: one chip per choice, 1/3 2/3 3/3. */}
      <Text style={[styles.optionTitle, styles.thresholdTitle]}>{t('mobile.safe.threshold')}</Text>
      <View style={styles.chips}>
        {owners.map((_, i) => {
          const n = i + 1;
          const on = n === threshold;
          return (
            <Pressable
              key={n}
              style={({pressed}) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
              onPress={() => setThreshold(n)}
              accessibilityRole="radio"
              accessibilityState={{checked: on}}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{`${n}/${owners.length}`}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>{t('mobile.safe.threshold_of', {n: threshold, total: owners.length})}</Text>

      {/* The multisig these owners and this threshold make, known before anything is sent. */}
      <View style={styles.planBox}>
        <Text style={styles.hint}>{t('mobile.safe.vault_address')}</Text>
        {plan ? (
          <Pressable onLongPress={() => Clipboard.setString(plan.address)}>
            <Text style={styles.planAddr} selectable>
              {plan.address}
            </Text>
          </Pressable>
        ) : planError ? (
          <Text style={styles.fieldError}>{t('mobile.safe.plan_failed')}</Text>
        ) : (
          <ActivityIndicator color={c.subtext} style={styles.planSpin} />
        )}
      </View>
    </View>
  );

  const toggle = (
    <Pressable
      style={({pressed}) => [styles.textBtn, pressed && styles.pressed]}
      onPress={() => {
        setExisting((e) => !e);
        setError(null);
        setCopyOffer(null);
      }}
      hitSlop={6}>
      <Text style={styles.link}>{existing ? t('mobile.safe.create_instead') : t('mobile.safe.have_safe')}</Text>
    </Pressable>
  );

  const note = (text: string) => (
    <View style={styles.note}>
      <Glyph name="lock" color={c.subtext} size={14} />
      <Text style={styles.noteText}>{text}</Text>
    </View>
  );

  return (
    <ScrollView
      ref={scroll}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      {step(1, t('mobile.safe.step_key'), !!key && !importing, false, keyBody, note(t('mobile.safe.step_key_footer')))}
      {existing
        ? step(
            2,
            t('mobile.safe.step_vault'),
            false,
            !key || importing,
            vaultBody,
            <View style={styles.gap10}>
              <Text style={styles.hint}>{t('mobile.safe.step_vault_footer')}</Text>
            </View>,
          )
        : step(2, t('mobile.safe.step_owners'), false, !key || importing, ownersBody)}

      {/* Not deployed on this network yet, but on another: activate it here from the imported key. */}
      {copyOffer ? (
        <View style={styles.offer}>
          <Text style={styles.offerText}>
            {t('mobile.safe.copy_offer', {network: networkLabel(network, t), source: networkLabel(copyOffer.plan.source, t)})}
          </Text>
          <Button title={t('mobile.safe.copy_button', {network: networkLabel(network, t)})} onPress={onCopy} loading={busy} disabled={busy} />
        </View>
      ) : null}

      {error ? (
        <View style={styles.banner}>
          <Glyph name="alert" color={c.danger} size={18} />
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}

      {existing ? (
        <Button
          title={busy ? t('mobile.safe.checking') : t('mobile.safe.add_button')}
          onPress={onAdd}
          loading={busy}
          disabled={!key || importing || !addressOk || busy}
        />
      ) : (
        <Button
          title={busy ? t('mobile.safe.creating') : t('mobile.safe.create_button')}
          onPress={onCreate}
          loading={busy}
          disabled={!key || importing || busy || !plan}
        />
      )}
      {/* Away from the owners and threshold, so a tap meant for them cannot land on it. */}
      <View style={styles.toggleWrap}>{toggle}</View>

      <QrScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onScan={(address) => {
          setScanning(false);
          setDraft(address);
          setError(null);
        }}
      />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    ownerRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: c.input},
    ownerAddr: {color: c.text, fontSize: 14, fontFamily: MONO},
    remove: {color: c.subtext, fontSize: 22, fontWeight: '300', paddingHorizontal: 4},
    thresholdTitle: {paddingTop: 8},
    chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
    chip: {minWidth: 64, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, backgroundColor: c.input, borderWidth: 1.5, borderColor: 'transparent', alignItems: 'center'},
    chipOn: {borderColor: c.accent, backgroundColor: c.accentSoft},
    chipText: {color: c.text, fontSize: 16, fontWeight: '600'},
    chipTextOn: {color: c.accent},
    planBox: {marginTop: 6, padding: 12, borderRadius: 14, backgroundColor: c.input, gap: 4},
    planAddr: {color: c.text, fontSize: 13, fontFamily: MONO},
    planSpin: {alignSelf: 'flex-start'},
    toggleWrap: {alignItems: 'center', paddingTop: 8},
    offer: {backgroundColor: c.card, borderRadius: 16, padding: 16, gap: 12},
    offerText: {color: c.text, fontSize: 14, lineHeight: 20},
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 16, paddingBottom: 40},
    card: {backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 14},
    cardOff: {opacity: 0.5},
    stepHead: {flexDirection: 'row', alignItems: 'center', gap: 10},
    badge: {width: 26, height: 26, borderRadius: 13, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center'},
    badgeDone: {backgroundColor: c.success},
    badgeOff: {backgroundColor: c.neutralSoft},
    badgeText: {color: c.onAccent, fontSize: 14, fontWeight: '700'},
    badgeTextOff: {color: c.subtext},
    stepTitle: {color: c.text, fontSize: 17, fontWeight: '600'},
    options: {gap: 10},
    option: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, backgroundColor: c.input, borderWidth: 1.5, borderColor: 'transparent'},
    optionOn: {borderColor: c.accent, backgroundColor: c.accentSoft},
    optionText: {flex: 1, gap: 2},
    optionTitle: {color: c.text, fontSize: 15, fontWeight: '600'},
    mono: {color: c.subtext, fontSize: 13, fontFamily: MONO},
    radio: {width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center'},
    radioOn: {borderColor: c.accent},
    radioDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: c.accent},
    gap10: {gap: 10},
    inputWrap: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.input, borderRadius: 14, paddingLeft: 14, paddingRight: 6, minHeight: 52, borderWidth: 1.5, borderColor: 'transparent'},
    inputWrapError: {borderColor: c.danger},
    input: {flex: 1, color: c.text, fontSize: 15, paddingVertical: 14},
    inputMono: {fontFamily: MONO, fontSize: 13},
    pill: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: c.accentSoft},
    pillText: {color: c.accent, fontSize: 13, fontWeight: '600'},
    scanBtn: {width: 40, height: 40, borderRadius: 10, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center'},
    fieldError: {color: c.danger, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
    actions: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 16},
    smallBtn: {paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999, backgroundColor: c.accent},
    smallBtnOff: {opacity: 0.4},
    smallBtnText: {color: c.onAccent, fontSize: 15, fontWeight: '600'},
    textBtn: {paddingVertical: 4},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
    cancel: {color: c.subtext, fontSize: 15, fontWeight: '600'},
    note: {flexDirection: 'row', alignItems: 'flex-start', gap: 8},
    noteText: {flex: 1, color: c.subtext, fontSize: 12, lineHeight: 17},
    hint: {color: c.subtext, fontSize: 12, lineHeight: 17},
    banner: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: 14, backgroundColor: c.dangerSoft},
    bannerText: {flex: 1, color: c.danger, fontSize: 14, lineHeight: 20},
    pressed: {opacity: 0.6},
  });

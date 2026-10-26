import React, {useState} from 'react';
import {Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {StackActions, useNavigation} from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {getAddress, isAddress, type Address} from 'viem';
import {useNetwork} from '@/core/network-store';
import {useVaults} from '@/core/vault-store';
import {ownerVaultAddress} from '@/vault/read';
import {vaultOwnerOf} from '@/vault/owned-vaults';
import {fetchSafe, SafeApiError, type SafeInfo} from '@/vault/safe';
import * as keyring from '@/wallet/keyring';
import {useWallet} from '@/wallet/store';
import {Button} from '@/components/Button';
import {QrScanner} from '@/components/QrScanner';
import {SettingsIcon} from '@/components/SettingsIcon';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

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
 * 2. The address, typed, pasted or scanned: the vault the Safe owns, or the Safe itself. Either one
 *    finds the other — a Safe's vault is the one the factory derives from it, and a vault's owner
 *    is read from the chain — and the key is checked against the Safe's owners before it is added.
 *
 * Added, the vault is put in front and the user is taken back past the vault list, as choosing a
 * vault there does.
 */
export function AddSafeVaultScreen() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const nav = useNavigation();
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
   * The Safe and its vault for the address entered: a Safe's own address gives the vault the
   * factory derives from it; a vault's gives the Safe that owns it, read from the chain.
   */
  const resolve = async (address: Address): Promise<{safe: Address; info: SafeInfo; vault: Address} | string> => {
    try {
      const info = await fetchSafe(network, address);
      const vault = ownerVaultAddress(address, network);
      // Created by this Safe, but handed on since: no longer the Safe's.
      const now = await vaultOwnerOf(network, vault);
      if (now && now.toLowerCase() !== address.toLowerCase()) return t('mobile.safe.vault_elsewhere', {address: now});
      return {safe: address, info, vault};
    } catch (e) {
      if (!(e instanceof SafeApiError && e.reason === 'safe-not-found')) return String((e as Error)?.message ?? e);
    }
    const owner = await vaultOwnerOf(network, address);
    if (!owner) return t('mobile.safe.no_vault');
    try {
      return {safe: owner, info: await fetchSafe(network, owner), vault: address};
    } catch (e) {
      if (e instanceof SafeApiError && e.reason === 'safe-not-found') return t('mobile.safe.not_safe_owned', {address: owner});
      return String((e as Error)?.message ?? e);
    }
  };

  const onAdd = async () => {
    setError(null);
    const raw = draft.trim();
    if (!key) return;
    if (!isAddress(raw)) return setError(t('mobile.safe.invalid_address'));
    Keyboard.dismiss();
    setBusy(true);
    try {
      const found = await resolve(getAddress(raw));
      if (typeof found === 'string') return setError(found);
      const {safe, info, vault} = found;
      if (!info.supported) return setError(t('mobile.safe.unsupported', {problems: info.problems.join(', ')}));
      if (!info.owners.some((o) => o.toLowerCase() === key.toLowerCase())) return setError(t('mobile.safe.key_not_owner', {address: key}));
      // A vault the Safe was given keeps its first owner's address, on this chain only.
      const at = vault.toLowerCase() === ownerVaultAddress(safe, network).toLowerCase() ? undefined : {vault, network};
      selectVault(useVaults.getState().addSafe(safe, {address: key}, at));
      nav.dispatch(StackActions.pop(2));
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
        <View style={[styles.inputWrap, !!keyError && styles.inputWrapError]}>
          <TextInput
            style={styles.input}
            value={keyDraft}
            onChangeText={(v) => {
              setKeyDraft(v);
              setKeyError(null);
            }}
            placeholder={t('mobile.safe.private_key_placeholder')}
            placeholderTextColor={c.subtext}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            secureTextEntry
            textContentType="none"
            autoComplete="off"
            onSubmitEditing={onImport}
          />
          {!keyDraft ? (
            <Pressable style={({pressed}) => [styles.pill, pressed && styles.pressed]} onPress={() => paste(setKeyDraft)} hitSlop={6}>
              <Text style={styles.pillText}>{t('mobile.safe.paste')}</Text>
            </Pressable>
          ) : null}
        </View>
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

  const note = (text: string) => (
    <View style={styles.note}>
      <Glyph name="lock" color={c.subtext} size={14} />
      <Text style={styles.noteText}>{text}</Text>
    </View>
  );

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <View style={styles.hero}>
        <SettingsIcon name="vault" size={64} />
        <Text style={styles.heroSub}>{t('mobile.safe.add_safe_footer')}</Text>
      </View>

      {step(1, t('mobile.safe.step_key'), !!key && !importing, false, keyBody, note(t('mobile.safe.step_key_footer')))}
      {step(
        2,
        t('mobile.safe.step_vault'),
        false,
        !key || importing,
        vaultBody,
        <Text style={styles.hint}>{t('mobile.safe.step_vault_footer')}</Text>,
      )}

      {error ? (
        <View style={styles.banner}>
          <Glyph name="alert" color={c.danger} size={18} />
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}

      <Button
        title={busy ? t('mobile.safe.checking') : t('mobile.safe.add_button')}
        onPress={onAdd}
        loading={busy}
        disabled={!key || importing || !addressOk || busy}
      />

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
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 16, paddingBottom: 40},
    hero: {alignItems: 'center', gap: 14, paddingTop: 8, paddingBottom: 4, paddingHorizontal: 20},
    heroSub: {color: c.subtext, fontSize: 14, lineHeight: 20, textAlign: 'center'},
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
    mono: {color: c.subtext, fontSize: 13, fontFamily: 'Menlo'},
    radio: {width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center'},
    radioOn: {borderColor: c.accent},
    radioDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: c.accent},
    gap10: {gap: 10},
    inputWrap: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.input, borderRadius: 14, paddingLeft: 14, paddingRight: 6, minHeight: 52, borderWidth: 1.5, borderColor: 'transparent'},
    inputWrapError: {borderColor: c.danger},
    input: {flex: 1, color: c.text, fontSize: 15, paddingVertical: 14},
    inputMono: {fontFamily: 'Menlo', fontSize: 13},
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

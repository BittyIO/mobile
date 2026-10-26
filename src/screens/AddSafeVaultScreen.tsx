import React, {useState} from 'react';
import {ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {StackActions, useNavigation} from '@react-navigation/native';
import Svg, {Path, Rect} from 'react-native-svg';
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
import {SettingsGroup, makeSettingsStyles} from '@/components/SettingsRow';
import {useT} from '@/i18n';
import {useColors, useStyles, type Colors} from '@/theme';

/** The camera mark on the address field's scan button (lucide ScanLine). */
function ScanIcon({color}: {color: string}) {
  const st = {stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" {...st} />
      <Rect x={7} y={7} width={10} height={10} rx={1} {...st} />
    </Svg>
  );
}

/**
 * Settings › Choose vault › Add a Safe vault.
 *
 * A Safe vault is signed for by one of the Safe's owners, and that owner is a key the user already
 * has somewhere else — a hardware wallet, MetaMask, a script — not one of this phrase's. So the page
 * asks for two things, in order:
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

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={styles.container}
      contentContainerStyle={styles.body}>
      <Text style={styles.intro}>{t('mobile.safe.add_safe_page_intro')}</Text>

      {/* 1. The owner's key. */}
      <SettingsGroup label={t('mobile.safe.step_key')} footer={t('mobile.safe.step_key_footer')}>
        {keys.map((a) => (
          <Pressable
            key={a}
            style={({pressed}) => [styles.row, styles.rowDivider, pressed && styles.pressed]}
            onPress={() => {
              setKey(a);
              setError(null);
            }}
            accessibilityRole="radio"
            accessibilityState={{checked: key === a}}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{t('mobile.safe.imported_key')}</Text>
              <Text style={styles.addr} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                {a}
              </Text>
            </View>
            <Text style={[styles.check, key !== a && styles.checkHidden]}>✓</Text>
          </Pressable>
        ))}
        {importing ? (
          <View style={styles.form}>
            <TextInput
              style={styles.field}
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
              importantForAutofill="no"
            />
            {keyError ? <Text style={styles.error}>{keyError}</Text> : null}
            <Pressable onPress={onImport} disabled={!keyDraft.trim()} hitSlop={6}>
              <Text style={[styles.link, !keyDraft.trim() && styles.linkOff]}>{t('mobile.safe.import')}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={({pressed}) => [styles.row, pressed && styles.pressed]} onPress={() => setImporting(true)}>
            <Text style={styles.link}>{`＋ ${t('mobile.safe.import_key')}`}</Text>
          </Pressable>
        )}
      </SettingsGroup>

      {/* 2. Which vault: typed, pasted or scanned. */}
      <SettingsGroup label={t('mobile.safe.step_vault')} footer={t('mobile.safe.step_vault_footer')}>
        <View style={styles.fieldRow}>
          <TextInput
            style={[styles.field, styles.fieldGrow]}
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
          />
          <Pressable
            style={({pressed}) => [styles.scanBtn, pressed && styles.pressed]}
            onPress={() => {
              Keyboard.dismiss();
              setScanning(true);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.scan.scan')}>
            <ScanIcon color={c.accent} />
          </Pressable>
        </View>
      </SettingsGroup>

      {error ? <Text style={[styles.error, styles.errorOut]}>{error}</Text> : null}
      {!key ? <Text style={styles.need}>{t('mobile.safe.need_key')}</Text> : null}
      <Button title={busy ? t('mobile.safe.checking') : t('mobile.safe.add_button')} onPress={onAdd} disabled={!key || !draft.trim() || busy} />
      {busy ? <ActivityIndicator color={c.subtext} /> : null}

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
    ...makeSettingsStyles(c),
    container: {flex: 1, backgroundColor: c.bg},
    body: {padding: 16, gap: 20, paddingBottom: 40},
    intro: {color: c.subtext, fontSize: 14, lineHeight: 20, paddingHorizontal: 4},
    addr: {color: c.subtext, fontSize: 13, fontFamily: 'Menlo', lineHeight: 18},
    pressed: {opacity: 0.6},
    checkHidden: {opacity: 0},
    link: {color: c.accent, fontSize: 15, fontWeight: '600'},
    linkOff: {opacity: 0.4},
    form: {gap: 12, padding: 16},
    fieldRow: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16},
    fieldGrow: {flex: 1},
    field: {color: c.text, fontSize: 13, fontFamily: 'Menlo', backgroundColor: c.input, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11},
    scanBtn: {width: 42, height: 42, borderRadius: 10, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center'},
    error: {color: c.danger, fontSize: 13, lineHeight: 18},
    errorOut: {paddingHorizontal: 4},
    need: {color: c.subtext, fontSize: 13, lineHeight: 18, paddingHorizontal: 4},
  });

import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {Sheet} from '@/components/Sheet';
import {useVaults, vaultLabel} from '@/core/vault-store';
import {useWallet} from '@/wallet/store';
import {useNetwork} from '@/core/network-store';
import {ownerVaultAddress} from '@/vault/read';
import * as keyring from '@/wallet/keyring';
import {useColors, useStyles, type Colors} from '@/theme';
import {useT} from '@/i18n';

/**
 * Choose, rename, or add a vault.
 *
 * Returns the Settings row's value and the sheet to render, in the pattern the asset manager and
 * version rows already use, so the screen stays a list of rows.
 *
 * Adding derives the next BIP-44 account from the recovery phrase, which is the only part that
 * needs the key — and the only part that prompts. Choosing and renaming are local.
 */
export function useVaultPicker() {
  const {t} = useT();
  const c = useColors();
  const styles = useStyles(makeStyles);
  const vaults = useVaults((s) => s.vaults);
  const activeIndex = useVaults((s) => s.activeIndex);
  const rename = useVaults((s) => s.rename);
  const addVault = useVaults((s) => s.add);
  const selectVault = useWallet((s) => s.selectVault);
  const network = useNetwork((s) => s.network);
  /**
   * The vault's own address, not its owner's.
   *
   * What is stored is the owner, because that is what the next derivation needs, but the
   * address a user recognises — the one they send to, the one on the explorer — is the
   * vault the factory puts at keccak256(owner). It differs per network, since each has
   * its own factory, so it is computed here rather than cached with the owner.
   */
  const vaultOf = (owner: `0x${string}` | null) => (owner ? ownerVaultAddress(owner, network) : null);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const label = (i: number) => t('mobile.app.vault_n', {n: i});
  const current = vaults.find((v) => v.index === activeIndex) ?? vaults[0];

  const commit = () => {
    if (editing != null) rename(editing, draft);
    setEditing(null);
  };

  /**
   * Add the next vault.
   *
   * One prompt derives every owner up to and including the new index, so a device that has only
   * ever unlocked index 0 fills in the addresses it never had rather than prompting again per
   * vault later. The vault itself is counterfactual until its first action, exactly like the first.
   */
  const onAdd = async () => {
    setBusy(true);
    try {
      const next = Math.max(...vaults.map((v) => v.index)) + 1;
      const addrs = await keyring.addressesUpTo(next + 1);
      if (!addrs) return;
      const {setOwner} = useVaults.getState();
      vaults.forEach((v) => !v.owner && addrs[v.index] && setOwner(v.index, addrs[v.index]));
      const created = addVault(addrs[next]);
      selectVault(created);
    } finally {
      setBusy(false);
    }
  };

  const sheet = (
    <Sheet visible={open} title={t('mobile.settings.choose_vault')} onClose={() => { commit(); setOpen(false); }}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {vaults.map((v) => {
          const on = v.index === activeIndex;
          return (
            <View key={v.index} style={styles.row}>
              {/* Choosing closes the sheet, as every other picker in the app does — the choice is
                  the whole reason it is open. It was closing anyway, as a side effect of the
                  address change rippling through the screen behind it; doing it here makes the
                  behaviour the one that was intended rather than the one that fell out. */}
              <Pressable
                style={styles.pick}
                disabled={!v.owner}
                onPress={() => {
                  if (!v.owner) return;
                  commit();
                  selectVault(v.index);
                  setOpen(false);
                }}>
                <View style={styles.text}>
                  {editing === v.index ? (
                    <TextInput
                      style={styles.input}
                      value={draft}
                      onChangeText={setDraft}
                      onBlur={commit}
                      onSubmitEditing={commit}
                      placeholder={label(v.index + 1)}
                      placeholderTextColor={c.subtext}
                      autoFocus
                      maxLength={24}
                    />
                  ) : (
                    <Text style={styles.name}>{vaultLabel(v, label)}</Text>
                  )}
                  <Text style={styles.sub}>{vaultOf(v.owner) ?? t('mobile.settings.vault_unlock_first')}</Text>
                </View>
                {on ? (
                  <Svg width={18} height={18} viewBox="0 0 24 24">
                    <Path d="M20 6 9 17l-5-5" stroke={c.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </Svg>
                ) : null}
              </Pressable>
              {/* Rename is its own target: tapping the row switches vault, which is what a tap on
                  a list of things to choose from should do. */}
              <Pressable
                style={styles.edit}
                hitSlop={8}
                onPress={() => {
                  setDraft(v.name);
                  setEditing(v.index);
                }}>
                <Text style={styles.editText}>{t('vault.edit')}</Text>
              </Pressable>
            </View>
          );
        })}
        <Pressable style={styles.add} onPress={onAdd} disabled={busy}>
          <Text style={styles.addText}>{busy ? '…' : `＋ ${t('mobile.settings.add_vault')}`}</Text>
        </Pressable>
      </ScrollView>
    </Sheet>
  );

  return {value: current ? vaultLabel(current, label) : '', open: () => setOpen(true), sheet};
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    pick: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56},
    text: {flex: 1},
    name: {color: c.text, fontSize: 15, fontWeight: '600'},
    input: {color: c.text, fontSize: 15, fontWeight: '600', padding: 0},
    // Full, and small enough to wrap to two lines rather than be cut: a vault is told apart
    // from another by its address, and an elided middle is where they would differ.
    sub: {color: c.subtext, fontSize: 11, marginTop: 3, fontFamily: 'Menlo', lineHeight: 15},
    edit: {paddingHorizontal: 4, paddingVertical: 8},
    editText: {color: c.accent, fontSize: 13, fontWeight: '600'},
    add: {paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
    addText: {color: c.accent, fontSize: 15, fontWeight: '600'},
  });

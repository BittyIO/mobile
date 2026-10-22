/**
 * Embedded keyring — the vault owner's key lives ON THIS DEVICE, in the iOS Keychain behind biometrics
 * (Face ID / passcode). The app IS the wallet: it creates a BIP-39 recovery phrase, derives
 * the account with viem, and signs every vault action locally. The mnemonic is never in JS-readable
 * storage and never leaves the device.
 *
 * Recovery is the phrase: shown once on create, and typed back in to restore after a reinstall
 * (iOS deletes the Keychain item with the app). No server ever sees it.
 */
import * as Keychain from 'react-native-keychain';
import {generateMnemonic, mnemonicToAccount, english, type HDAccount} from 'viem/accounts';
import {validateMnemonic} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';

const SERVICE = 'io.bitty.vault.mnemonic';

/** Options that gate the stored secret behind biometrics/passcode and keep it on this device only. */
const SECURE: Keychain.SetOptions = {
  service: SERVICE,
  accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Whether a wallet exists on this device (no prompt). */
export async function hasWallet(): Promise<boolean> {
  const r = await Keychain.hasGenericPassword({service: SERVICE}).catch(() => false);
  return !!r;
}

/** A fresh 12-word BIP-39 phrase. Show once, then persist after the backup check. Never log/transmit. */
export function generateNewMnemonic(): string {
  return generateMnemonic(english);
}

/**
 * Persist a phrase — generated in onboarding after its backup check, or typed in to restore.
 *
 * Validated here rather than trusted to `mnemonicToAccount`, which checks neither the words nor
 * the checksum: a restore with one word mistyped derived a DIFFERENT, empty wallet and opened it,
 * so the user saw their vault gone instead of being told the phrase was wrong.
 */
export async function createWallet(mnemonic: string): Promise<HDAccount> {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!validateMnemonic(normalized, wordlist)) throw new Error('Invalid recovery phrase');
  const account = mnemonicToAccount(normalized);
  await Keychain.setGenericPassword('bitty', normalized, SECURE);
  return account;
}

/** Read the mnemonic from the Keychain behind a biometric prompt (null if cancelled). */
async function readSecret(prompt: string): Promise<string | null> {
  const creds = await Keychain.getGenericPassword({
    service: SERVICE,
    authenticationPrompt: {title: prompt},
  }).catch(() => false as const);
  return creds ? creds.password : null;
}

/**
 * Unlock: derive an account from the Keychain-stored mnemonic (Face ID). Null if cancelled/absent.
 *
 * `index` is the BIP-44 account index, which is what makes more than one vault possible: the
 * factory salts on the owner's address, so one owner is one vault for ever, and a second vault
 * means a second owner. Derived from the same phrase, so the phrase still recovers all of them.
 * Index 0 is the wallet that has always existed and keeps the default path.
 */
export async function unlock(index = 0): Promise<HDAccount | null> {
  const m = await readSecret(translate(useLanguage.getState().language, 'mobile.app.unlock_prompt'));
  return m ? mnemonicToAccount(m, {accountIndex: index}) : null;
}

/**
 * Every owner address up to `count`, derived in one biometric prompt.
 *
 * Switching vaults must not ask for Face ID — the addresses are public, so they are read once and
 * cached, and the key stays behind the prompt where it belongs.
 */
export async function addressesUpTo(count: number): Promise<`0x${string}`[] | null> {
  const m = await readSecret('Add a vault');
  if (!m) return null;
  return Array.from({length: count}, (_, i) => mnemonicToAccount(m, {accountIndex: i}).address);
}

/** Reveal the raw recovery phrase (Face ID). Null if cancelled. */
export async function revealMnemonic(): Promise<string | null> {
  return readSecret('Reveal your recovery phrase');
}

/** Permanently remove the wallet from this device. */
export async function wipe(): Promise<void> {
  await Keychain.resetGenericPassword({service: SERVICE});
}

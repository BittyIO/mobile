/**
 * Embedded keyring — the vault owner's key lives ON THIS DEVICE, in the iOS Keychain behind biometrics
 * (Face ID / passcode). The app IS the wallet: it creates or imports a BIP-39 recovery phrase, derives
 * the account with viem, and signs every vault action locally. The mnemonic is never in JS-readable
 * storage and never leaves the device.
 *
 * Recovery is the phrase: shown once on create, re-imported on a new device. No server ever sees it.
 */
import * as Keychain from 'react-native-keychain';
import {generateMnemonic, mnemonicToAccount, english, type HDAccount} from 'viem/accounts';

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

/** A fresh 12-word BIP-39 phrase. Show once, then commit with {@link importWallet}. Never log/transmit. */
export function generateNewMnemonic(): string {
  return generateMnemonic(english);
}

/** Import (and persist) an existing BIP-39 mnemonic behind biometrics. Throws if the phrase is invalid. */
export async function importWallet(mnemonic: string): Promise<HDAccount> {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  const account = mnemonicToAccount(normalized); // throws on an invalid phrase
  await Keychain.setGenericPassword('bitty', normalized, SECURE);
  return account;
}

/** Generate + persist a brand-new wallet. Returns the phrase to reveal once. */
export async function createWallet(): Promise<{mnemonic: string; account: HDAccount}> {
  const mnemonic = generateNewMnemonic();
  const account = await importWallet(mnemonic);
  return {mnemonic, account};
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
  const m = await readSecret('Unlock Bitty');
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

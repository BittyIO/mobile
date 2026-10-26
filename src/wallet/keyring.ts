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
import {toHex} from 'viem';
import {
  generateMnemonic,
  hdKeyToAccount,
  mnemonicToAccount,
  privateKeyToAccount,
  english,
  HDKey,
  type HDAccount,
  type PrivateKeyAccount,
} from 'viem/accounts';
import {mnemonicToSeedSync, validateMnemonic} from '@scure/bip39';
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
  const root = await unlockRoot();
  return root ? accountAt(root, index) : null;
}

/**
 * The phrase's root key, behind the same Face ID prompt as {unlock}: for a caller that needs more
 * than one key of it at once — the vault's owner key and the fresh key it is handed to next (see
 * ./rotation). Held only for the operation in hand, like the account {unlock} returns.
 */
export async function unlockRoot(): Promise<HDKey | null> {
  const m = await readSecret(translate(useLanguage.getState().language, 'mobile.app.unlock_prompt'));
  return m ? HDKey.fromMasterSeed(mnemonicToSeedSync(m)) : null;
}

/** The owner key at BIP-44 account `index` (m/44'/60'/index'/0/0) — what {unlock} returns. */
export const accountAt = (root: HDKey, index: number): HDAccount => hdKeyToAccount(root, {accountIndex: index});

/**
 * One-time key `k` of account `index`: m/44'/60'/index'/1/k.
 *
 * The CHANGE branch (1), which Ethereum wallets do not use — MetaMask and the like count accounts
 * on m/44'/60'/0'/0/n — so importing this phrase somewhere else does not hand out these keys as
 * that wallet's "Account 2". Still the same phrase, so the phrase restores every one of them.
 */
export function oneTimeKeys(root: HDKey, index: number): (k: number) => PrivateKeyAccount {
  // The branch is derived once: a scan for the vault's owner walks dozens of keys, and deriving each
  // from the root repeats the four hardened steps above it every time.
  const branch = root.derive(`m/44'/60'/${index}'/1`);
  return (k) => privateKeyToAccount(toHex(branch.deriveChild(k).privateKey!));
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

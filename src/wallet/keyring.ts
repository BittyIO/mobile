/**
 * Embedded keyring — the vault owner's key lives ON THIS DEVICE, in the iOS Keychain / Android Keystore
 * behind biometrics (Face ID / fingerprint) — always; there is no other lock and no way to turn it off. The app IS the wallet: it creates a BIP-39 recovery phrase, derives
 * the account with viem, and signs every vault action locally. The mnemonic is never in JS-readable
 * storage and never leaves the device.
 *
 * Recovery is the phrase: shown once on create, and typed back in to restore after a reinstall
 * (iOS deletes the Keychain item with the app). No server ever sees it.
 */
import {Platform} from 'react-native';
import * as Keychain from 'react-native-keychain';
import {MMKV} from 'react-native-mmkv';
import {getAddress, toHex, type Address} from 'viem';
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

const tr = (key: string, params?: Record<string, string | number>) => translate(useLanguage.getState().language, key, params);

const SERVICE = 'io.bitty.vault.mnemonic';

/**
 * Options that gate the stored secret behind Face ID / fingerprint ONLY and keep it on this device.
 * Not "or device passcode": the phone's passcode is not the wallet's. Android's prompt is
 * biometric-only whatever this says.
 */
const SECURE: Keychain.SetOptions = {
  service: SERVICE,
  // iOS: the faces enrolled NOW. Adding or resetting a face (or Alternate Appearance) makes this copy
  // unreadable for good — someone who knows the phone's passcode cannot enrol their own face and get
  // in; the owner restores from the recovery phrase.
  // Android already behaves so: its biometric-bound key is invalidated by a new enrolment.
  accessControl: Platform.OS === 'ios' ? Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET : Keychain.ACCESS_CONTROL.BIOMETRY_ANY,
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  // Android: pin the Keystore key that needs a strong biometric per use. Left to choose, the library
  // falls back SILENTLY to KeystoreAESGCM_NoAuth (readable with no prompt) when no fingerprint/face is
  // enrolled — including on a PIN-only phone, since its auth-bound key does not accept the PIN.
  ...(Platform.OS === 'android' ? {storage: Keychain.STORAGE_TYPE.AES_GCM} : {}),
};

/** Thrown when Android has no strong biometric enrolled, so the key could only be stored unprotected. */
export class BiometricsRequiredError extends Error {
  constructor() {
    super(tr(Platform.OS === 'ios' ? 'mobile.app.biometrics_required_ios' : 'mobile.app.biometrics_required'));
    this.name = 'BiometricsRequiredError';
  }
}

/**
 * Earlier test builds kept the key elsewhere too: with Face ID switched off, a plain copy at
 * `service.open`; under a password of the user's own, a sealed copy at `service.pw` (or at `service`
 * itself in the very first). Face ID is always on now and there is no password: a plain copy is moved
 * behind Face ID at launch, and a sealed one cannot be opened any more, so the phone is treated as
 * having no wallet and the user restores from the recovery phrase, which clears it.
 */
const unlockPrefs = new MMKV({id: 'bitty.unlock'});
const legacyOpenService = (service: string) => `${service}.open`;
const legacyPwService = (service: string) => `${service}.pw`;
/** A secret an earlier build sealed under the user's password (`bitty-pw1:` + its JSON envelope). */
const isLegacySealed = (stored: string) => stored.startsWith('bitty-pw1:');
const allServices = () => [SERVICE, ...importedKeys().map(importedService)];

/** The biometric copy of `secret`. */
async function putBio(service: string, username: string, secret: string): Promise<void> {
  await assertCanProtect();
  await Keychain.setGenericPassword(username, secret, {...SECURE, service});
  unlockPrefs.set(`currentSet:${service}`, true);
}

/** Delete what earlier builds sealed under a password, and the old lock's settings. */
async function dropLegacyPassword(): Promise<void> {
  for (const service of allServices()) await Keychain.resetGenericPassword({service: legacyPwService(service)}).catch(() => false);
  for (const key of ['method', 'pw', 'failures', 'lockUntil']) unlockPrefs.delete(key);
}

/**
 * Refuse to store a secret behind a biometric when none is enrolled: the gate would be unreachable
 * (iOS) or silently absent (Android). The user sets one up first.
 */
async function assertCanProtect(): Promise<void> {
  const type = await Keychain.getSupportedBiometryType().catch(() => null);
  if (!type) throw new BiometricsRequiredError();
}

/**
 * Android: a secret saved before the storage was pinned may sit in the no-auth store. Once a biometric
 * is enrolled, move it behind one. Best effort — the read already succeeded, so a failure here only
 * leaves things as they were.
 */
async function upgradeIfUnprotected(creds: {storage?: string; username: string; password: string}, options: Keychain.SetOptions): Promise<void> {
  if (Platform.OS !== 'android' || creds.storage !== Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH) return;
  if (!(await Keychain.getSupportedBiometryType().catch(() => null))) return;
  await Keychain.setGenericPassword(creds.username, creds.password, options).catch(() => false);
}

/**
 * iOS: items saved under an older gate (Face ID or passcode; then any enrolled face) are saved again
 * under the current one — the faces enrolled now — once one is read (Face ID just passed). Writing
 * shows no prompt.
 */
async function resaveUnderCurrentSet(service: string, creds: {username: string; password: string}): Promise<void> {
  if (Platform.OS !== 'ios' || unlockPrefs.getBoolean(`currentSet:${service}`)) return;
  if (await Keychain.setGenericPassword(creds.username, creds.password, {...SECURE, service}).catch(() => false)) {
    unlockPrefs.set(`currentSet:${service}`, true);
  }
}

/**
 * Move every plain copy an earlier build kept with Face ID switched off behind Face ID, once. With no
 * biometric enrolled it stays where it is, but nothing reads it as it is: unlocking moves it first or
 * refuses (see readSecret).
 */
async function migrateOpenCopies(): Promise<void> {
  for (const service of allServices()) {
    const creds = await Keychain.getGenericPassword({service: legacyOpenService(service)}).catch(() => false as const);
    if (!creds) continue;
    try {
      await putBio(service, creds.username, creds.password);
      await Keychain.resetGenericPassword({service: legacyOpenService(service)});
    } catch {
      return;
    }
  }
  unlockPrefs.delete('bio');
}

/**
 * Whether a wallet this app can open exists on this device (no prompt). A key sealed under an earlier
 * build's password does not count: nothing can open it now, so onboarding restores from the phrase.
 */
export async function hasWallet(): Promise<boolean> {
  await migrateOpenCopies();
  const bio = !!(await Keychain.hasGenericPassword({service: SERVICE}).catch(() => false));
  const plain = !!(await Keychain.hasGenericPassword({service: legacyOpenService(SERVICE)}).catch(() => false));
  // The very first password builds sealed it at the biometric name, in the no-auth store: no prompt to look.
  const sealedHere = bio && unlockPrefs.getString('method') === 'password' && (await Keychain.getGenericPassword({service: SERVICE}).then((c) => !!c && isLegacySealed(c.password)).catch(() => false));
  if (sealedHere) return false;
  return bio || plain;
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
  await putBio(SERVICE, 'bitty', normalized);
  await Keychain.resetGenericPassword({service: legacyOpenService(SERVICE)}).catch(() => false);
  await dropLegacyPassword();
  return account;
}

/** Read the secret at `service` behind Face ID / fingerprint. Null if cancelled. */
async function readSecret(prompt: string, service = SERVICE): Promise<string | null> {
  const creds = await Keychain.getGenericPassword({
    service,
    authenticationPrompt: {title: prompt},
  }).catch(() => false as const);
  if (creds && !isLegacySealed(creds.password)) {
    await upgradeIfUnprotected(creds, {...SECURE, service});
    await resaveUnderCurrentSet(service, creds);
    return creds.password;
  }
  // A biometric copy that did not open was a cancelled prompt: that is the answer, whatever else is stored.
  if (await Keychain.hasGenericPassword({service}).catch(() => false)) return null;
  // A plain copy an earlier build kept with Face ID off, which the launch could not move yet. It is never
  // handed out as it is — that would open the wallet with no biometric at all. It is moved behind one
  // first (with none enrolled, putBio throws BiometricsRequiredError and the wallet stays shut until
  // one is set up), then read back through the prompt like any other.
  const plain = await Keychain.getGenericPassword({service: legacyOpenService(service)}).catch(() => false as const);
  if (!plain) return null;
  await putBio(service, plain.username, plain.password);
  await Keychain.resetGenericPassword({service: legacyOpenService(service)}).catch(() => false);
  const moved = await Keychain.getGenericPassword({service, authenticationPrompt: {title: prompt}}).catch(() => false as const);
  return moved ? moved.password : null;
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
  const m = await readSecret(tr('mobile.app.unlock_prompt'), SERVICE);
  return m ? HDKey.fromMasterSeed(mnemonicToSeedSync(m)) : null;
}

/** The root key of a phrase just typed or generated, for what else it derives (the Tron address). */
export const rootFromPhrase = (mnemonic: string): HDKey => HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')));

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

/**
 * Private keys imported on their own, outside the phrase — today, the key of a Safe's co-owner, so
 * this phone can sign as one of the Safe's owners (see vault/safe). Each sits in its own Keychain
 * item behind the same Face ID gate as the phrase; only the addresses, which are public, are listed
 * in MMKV. The phrase does not restore them: they are the user's to back up.
 */
const imported = new MMKV({id: 'bitty.imported-keys'});
const IMPORTED = 'addresses';
const importedService = (address: string) => `io.bitty.vault.key.${address.toLowerCase()}`;

/** The addresses of the keys imported on this phone, in the order they were imported. */
export function importedKeys(): Address[] {
  try {
    return (JSON.parse(imported.getString(IMPORTED) ?? '[]') as string[]).map((a) => getAddress(a));
  } catch {
    return [];
  }
}

/**
 * The 32-byte private key in `raw`, with or without its 0x, or null when it is not one. A recovery
 * phrase pasted here by mistake is not a key, and is not accepted.
 */
export function parsePrivateKey(raw: string): `0x${string}` | null {
  const hex = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  try {
    privateKeyToAccount(`0x${hex}`);
    return `0x${hex.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Keep `key` on this phone behind Face ID and return its address. Importing one already here is a no-op. */
export async function importPrivateKey(key: `0x${string}`): Promise<Address> {
  const {address} = privateKeyToAccount(key);
  await putBio(importedService(address), address, key);
  const list = importedKeys();
  if (!list.some((a) => a.toLowerCase() === address.toLowerCase())) imported.set(IMPORTED, JSON.stringify([...list, address]));
  return address;
}

/** The imported key at `address`, behind Face ID. Null if cancelled, or if it is not on this phone. */
export async function unlockImported(address: Address): Promise<PrivateKeyAccount | null> {
  const key = await readSecret(tr('mobile.app.unlock_prompt'), importedService(address));
  return key ? privateKeyToAccount(key as `0x${string}`) : null;
}

/** Permanently remove the wallet from this device, with every key imported into it. */
export async function wipe(): Promise<void> {
  await dropLegacyPassword();
  await Promise.all(allServices().flatMap((service) => [service, legacyOpenService(service)]).map((service) => Keychain.resetGenericPassword({service}).catch(() => false)));
  // The probe a temporary build kept behind Face ID.
  await Keychain.resetGenericPassword({service: 'io.bitty.vault.faceid-probe'}).catch(() => false);
  imported.delete(IMPORTED);
}

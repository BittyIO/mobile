import {decodeFunctionData, keccak256, parseAbi, toBytes, type Abi, type Address, type Hex} from 'viem';
import {MMKV} from 'react-native-mmkv';
import {apiFetch, apiUrl, publicClientFor, type Network} from '@/core/chain';
import {GUARD_IMPL_ABI, IMPLEMENTATION_VAULT} from '@/core/abi';
import {VAULT_GUARD} from '@/core/vault-contracts';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';
import {APP_BUILD, SUPPORTED_VAULT_MAJOR} from '@/core/app-version';
import v1_0_4 from '@/abis/vault-releases/vault-1.0.4.json';
import {REVERT_SIGNATURES} from './capabilities';

/**
 * The vault's ABI per release, and whether this build can run a vault on a given release.
 *
 * The server lists every release with the fingerprint of its ABI and the oldest app build that can
 * drive it (web /api/ethereum/vaults/abi; the vault repo's script/vault_abi_release.py writes the
 * ABIs and holds them to semver: a patch keeps the ABI, a minor only adds to it, a major may change
 * anything). So:
 *  - a vault on a release whose fingerprint this build already ships needs nothing;
 *  - one on a release it does not ship has that ABI downloaded once, checked against the
 *    fingerprint, and kept — so its new errors and events can be read;
 *  - one on a release whose `minAppBuild` is above this build is not written to, and is not offered
 *    as an upgrade: the app says to update instead.
 *
 * A downloaded ABI is only ever READ from — never used to choose or encode a call. A write still goes
 * by the function the app's own code names, so a tampered ABI cannot redirect one.
 */

type Release = {version: string; abiHash: `0x${string}`; minAppBuild: number};
type Param = {type: string; components?: Param[]; indexed?: boolean};
type Item = {type: string; name?: string; inputs?: Param[]; outputs?: Param[]; stateMutability?: string; anonymous?: boolean};

const typ = (p: Param): string =>
  p.type.startsWith('tuple') ? `(${(p.components ?? []).map(typ).join(',')})${p.type.slice(5)}` : p.type;

/** One ABI entry as its canonical line — the same as the release script and the web compute. */
function abiLine(item: Item): string | null {
  const ins = (item.inputs ?? []).map(typ).join(',');
  if (item.type === 'function')
    return `function ${item.name}(${ins}) returns (${(item.outputs ?? []).map(typ).join(',')}) ${item.stateMutability ?? 'nonpayable'}`;
  if (item.type === 'event')
    return `event ${item.name}(${(item.inputs ?? []).map((p) => typ(p) + (p.indexed ? ' indexed' : '')).join(',')})` + (item.anonymous ? ' anonymous' : '');
  if (item.type === 'error') return `error ${item.name}(${ins})`;
  return null;
}

/** An ABI's fingerprint: keccak256 of its canonical lines, sorted, joined by "\n". */
export function abiHash(abi: readonly Item[]): `0x${string}` {
  const lines = Array.from(new Set(abi.map(abiLine).filter((l): l is string => l != null))).sort();
  return keccak256(toBytes(lines.join('\n')));
}

/** The releases this build ships the ABI of. */
const BUNDLED: Record<string, {abiHash: string; abi: Abi}> = {
  [v1_0_4.version]: {abiHash: v1_0_4.abiHash, abi: v1_0_4.abi as Abi},
};

const store = new MMKV({id: 'bitty.vault-abi'});
const INDEX_KEY = 'index';

/** The server's release list: fetched once a launch, the last one kept for when it cannot be. */
let index: Release[] | null = null;
let indexLoad: Promise<Release[] | null> | null = null;

function lastIndex(): Release[] | null {
  try {
    const s = store.getString(INDEX_KEY);
    return s ? (JSON.parse(s) as Release[]) : null;
  } catch {
    return null;
  }
}

export function loadAbiIndex(network: Network): Promise<Release[] | null> {
  if (index) return Promise.resolve(index);
  indexLoad ??= apiFetch(apiUrl('/api/ethereum/vaults/abi', network))
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as {releases?: Release[]};
      index = j.releases ?? [];
      store.set(INDEX_KEY, JSON.stringify(index));
      return index;
    })
    .catch(() => {
      indexLoad = null;
      return lastIndex();
    });
  return indexLoad;
}

const major = (version: string) => Number(version.split('.')[0]);

/**
 * Whether this build can drive a vault on `version` ("1.0.4"). The server's `minAppBuild` decides;
 * a release it has not listed, or no answer at all, falls back to the major version this build was
 * written for. Null version (not read yet, or not activated): yes — nothing is known against it.
 */
export async function canRunVault(version: string | null, network: Network): Promise<boolean> {
  if (!version) return true;
  const releases = await loadAbiIndex(network);
  const r = releases?.find((x) => x.version === version);
  if (r) return r.minAppBuild <= APP_BUILD;
  return major(version) <= SUPPORTED_VAULT_MAJOR;
}

const cacheKey = (hash: string) => `abi:${hash.toLowerCase()}`;

/**
 * The ABI of the release a vault runs: shipped with the app, kept from an earlier download, or
 * downloaded now — only when its fingerprint is one this build does not ship. A download that does
 * not hash to the fingerprint the index named is thrown away. Null when it cannot be had.
 */
export async function vaultAbiFor(version: string | null, network: Network): Promise<Abi | null> {
  if (!version) return null;
  const bundled = BUNDLED[version];
  if (bundled) return bundled.abi;
  const releases = await loadAbiIndex(network);
  const r = releases?.find((x) => x.version === version);
  if (!r) return null;
  // Same ABI as one the app ships (a patch release): nothing to download.
  const same = Object.values(BUNDLED).find((b) => b.abiHash.toLowerCase() === r.abiHash.toLowerCase());
  if (same) return same.abi;
  const kept = store.getString(cacheKey(r.abiHash));
  if (kept) return JSON.parse(kept) as Abi;
  try {
    const res = await apiFetch(apiUrl(`/api/ethereum/vaults/abi?version=${encodeURIComponent(version)}`, network));
    if (!res.ok) return null;
    const j = (await res.json()) as {abi?: Item[]};
    if (!j.abi || abiHash(j.abi).toLowerCase() !== r.abiHash.toLowerCase()) return null;
    store.set(cacheKey(r.abiHash), JSON.stringify(j.abi));
    return j.abi as Abi;
  } catch {
    return null;
  }
}

/** Every vault ABI this device has — shipped and downloaded — for reading a bare revert selector. */
function knownAbis(): Abi[] {
  const out: Abi[] = Object.values(BUNDLED).map((b) => b.abi);
  for (const k of store.getAllKeys()) {
    if (!k.startsWith('abi:')) continue;
    try {
      out.push(JSON.parse(store.getString(k) ?? '[]') as Abi);
    } catch {
      // A damaged entry is skipped; the next download replaces it.
    }
  }
  return out;
}

/** A revert that came back as a bare selector ("0x1234abcd"), named from the known ABIs if it can be. */
/** The vault function `data` calls, by any vault ABI this device has; null when none decodes it. */
export function vaultFunctionName(data: Hex): string | null {
  for (const abi of knownAbis()) {
    try {
      return decodeFunctionData({abi, data}).functionName;
    } catch {
      // Not in this release's ABI; try the next.
    }
  }
  return null;
}

export function nameRevert(code: string): string {
  if (!/^0x[0-9a-fA-F]{8}$/.test(code)) return code;
  for (const abi of knownAbis()) {
    for (const item of abi) {
      if (item.type !== 'error') continue;
      const sig = `${item.name}(${(item.inputs as Param[]).map(typ).join(',')})`;
      if (keccak256(toBytes(sig)).slice(0, 10) === code.toLowerCase()) return item.name;
    }
  }
  // The vault ABI lists only its own errors, not those its logic libraries raise:
  // MarketTradePriceTooLow came back as a bare selector and the user got "the vault refused".
  for (const sig of REVERT_SIGNATURES) {
    if (keccak256(toBytes(sig)).slice(0, 10) === code.toLowerCase()) return sig.slice(0, sig.indexOf('('));
  }
  return code;
}

const VERSION_ABI = parseAbi(['function vaultVersion() view returns (uint256)']);
const fmtVersion = (v: bigint) => `${v / 1_000_000n}.${(v / 1_000n) % 1_000n}.${v % 1_000n}`;

/** A vault's release, read briefly cached: a write asks before every send. */
const versions = new Map<string, {version: string | null; at: number}>();
const VERSION_TTL_MS = 60_000;

/**
 * The release a vault runs — or, before it is activated, the one it will be born on: the guard's
 * latest implementation, since activation deploys onto that. Null when neither can be read.
 */
export async function runningVaultVersion(vault: Address, network: Network): Promise<string | null> {
  const key = `${network}:${vault.toLowerCase()}`;
  const hit = versions.get(key);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.version;
  const client = publicClientFor(network);
  const read = (address: Address) =>
    client.readContract({address, abi: VERSION_ABI, functionName: 'vaultVersion'}).then(fmtVersion);
  let version: string | null = null;
  try {
    version = await read(vault);
  } catch {
    try {
      const latest = (await client.readContract({
        address: VAULT_GUARD,
        abi: GUARD_IMPL_ABI,
        functionName: 'latestImplementation',
        args: [IMPLEMENTATION_VAULT],
      })) as Address;
      version = await read(latest);
    } catch {
      version = null;
    }
  }
  versions.set(key, {version, at: Date.now()});
  // Have the ABI ready for reading its errors, if it is one this build does not ship.
  vaultAbiFor(version, network).catch(() => null);
  return version;
}

/** Forget a vault's cached release — after an upgrade lands. */
export function forgetVaultVersion(vault: Address, network: Network): void {
  versions.delete(`${network}:${vault.toLowerCase()}`);
}

/** Thrown before a write to a vault on a release this build cannot drive. */
export class AppUpdateRequired extends Error {}

/**
 * Refuse a write this build may get wrong: the vault (or, unactivated, the release it will be born
 * on) is newer than this build is cleared for. Before anything is signed, so nothing is spent.
 */
export async function assertCanWrite(vault: Address, network: Network): Promise<void> {
  const version = await runningVaultVersion(vault, network);
  if (await canRunVault(version, network)) return;
  throw new AppUpdateRequired(
    translate(useLanguage.getState().language, 'mobile.actions.app_update_required', {version: version ?? ''}),
  );
}

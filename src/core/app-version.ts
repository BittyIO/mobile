/**
 * This build of the app, as the server's vault ABI releases name it.
 *
 * `APP_BUILD` goes up by one with every App Store release; it is what a release's `minAppBuild` is
 * compared with (web: /api/ethereum/vaults/abi). A JS constant rather than the bundle's version
 * because nothing native reads that out to JS here, and a number compares without parsing.
 */
export const APP_BUILD = 1;

/**
 * The app's version as Settings shows it: "v0.0.1". package.json is where it is written: each
 * TestFlight build bumps it by one and the archive's MARKETING_VERSION is set to match, so this and
 * the version App Store Connect shows agree. Read from JS for the same reason as `APP_BUILD`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const APP_VERSION = `v${(require('../../package.json') as {version: string}).version}`;

/** "v1.2.3" or "1.2.3" → [1, 2]. */
const majorMinor = (v: string): [number, number] => {
  const [a, b] = v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  return [a ?? 0, b ?? 0];
};

/**
 * Whether a vault on release `vaultVersion` ("1.1.0") needs a newer app than this one.
 *
 * The app's version and the vault's are matched on their first two numbers: a vault release that
 * raises the major or the minor changes the ABI, and an app below it cannot drive it. So app 1.0.10
 * runs vault 1.0.x (any patch) but not 1.1.0 or 2.0.0; app 1.1.0 runs both 1.0.x and 1.1.x.
 * The web's /api/ethereum/vaults/upgrade-target holds upgrades to the same rule.
 */
export function vaultNeedsNewerApp(vaultVersion: string): boolean {
  const [am, an] = majorMinor(APP_VERSION);
  const [vm, vn] = majorMinor(vaultVersion);
  return vm > am || (vm === am && vn > an);
}

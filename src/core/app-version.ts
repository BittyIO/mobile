/**
 * This build of the app, as the server's vault ABI releases name it.
 *
 * `APP_BUILD` goes up by one with every App Store release; it is what a release's `minAppBuild` is
 * compared with (web: /api/ethereum/vaults/abi). A JS constant rather than the bundle's version
 * because nothing native reads that out to JS here, and a number compares without parsing.
 *
 * `SUPPORTED_VAULT_MAJOR` is the vault major version this build was written for — the rule used only
 * when the server cannot be asked: a vault on a newer major is one this build may not drive.
 */
export const APP_BUILD = 1;
export const SUPPORTED_VAULT_MAJOR = 1;

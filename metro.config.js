const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro config. Kept close to the RN default — the app is self-contained under `src/`, so there are
 * no cross-repo `watchFolders` into `web/` (that would drag Next.js / server-only modules like mysql2
 * into the bundle). Shared logic is vendored under `src/core` for now; a real shared package comes
 * later. See README "Reuse".
 */
const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);

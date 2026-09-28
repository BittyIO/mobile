# Bitty — iOS (React Native)

Native iOS app for the **vault product only** (no lending/auctions/explore). Bare React Native, modeled
on [Rabby mobile](https://github.com/RabbyHub/rabby-mobile)'s stack, with an **embedded keyring**: the
signing key lives on-device in the Secure Enclave (Face ID / passcode), so the vault's gasless
smart-account flow becomes "tap → sign in-app → done" with no external wallet and no gas.

## Status — feature-complete (JS/TS), pending native shell

The full vault surface is built and wired (21 screens, 28 vault modules). What's here:

- Project skeleton (RN 0.81 / React 19), Metro/Babel/TS config, Hermes polyfills for viem.
- **Embedded keyring** (`src/wallet/keyring.ts`): create / **import** / unlock / wipe a BIP-39 mnemonic
  via viem, stored in the iOS Keychain behind biometrics. Never in JS-readable storage. (Import an
  existing recovery phrase from Onboarding → "Import a recovery phrase" to open your real vault.)
- Wallet session store (`src/wallet/store.ts`, zustand) + cached address (MMKV) for locked display;
  every write re-reads the key from the Keychain, so each signature is Face-ID gated.
- Gasless smart-account plumbing: EIP-712 `ForwardRequest` signed on-device, relayed via the web
  backend's `/api/ethereum/vaults/relay`; fee paid in the vault's stablecoin.
- Screens: Onboarding, Lock, VaultHome, Activate, Receive, Send, Transactions, Deposit, EarnAction,
  Trade, LimitOrder (CoW), Twap, AddLiquidity, Scheduled, Whitelist, AutoYield, Gasless, Manage,
  Delegation, Security, Settings.
- Networks: mainnet / base / sepolia (`src/core/network-store.ts` + NetworkSwitcher).

**Parked:** sub-vaults (BittyV1SubVault create/close/list + sub-owner mode) — a self-contained feature
to add later. Everything else on the live vault contract is covered.

Not yet: the native iOS project (`ios/`) — generated locally (below), since it needs full Xcode +
CocoaPods.

## First-time setup (on a machine with the iOS toolchain)

This repo ships the **JS/TS app only** — the native `ios/` project is generated locally (it needs full
Xcode + CocoaPods, which the authoring sandbox didn't have).

Prereqs: Xcode (full, from the App Store), CocoaPods, Watchman, Node ≥ 20.

```bash
# 1. Generate the native shell in a temp dir, then copy ios/ (and android/) in.
npx @react-native-community/cli@15 init Bitty --version 0.81.0 --skip-install --directory /tmp/BittyNative
cp -R /tmp/BittyNative/ios ./ios

# 2. Install JS deps + pods.
npm install
cd ios && pod install && cd ..

# 3. Run on the simulator (smoke test).
npm run ios
```

### Required Info.plist / capabilities (do this before building to a device)

The generated `ios/Bitty/Info.plist` needs:

- **`NSFaceIDUsageDescription`** = `"Unlock your Bitty"` — **mandatory**. The keyring unlocks the
  Keychain behind biometrics; without this key the app **crashes** the first time it touches Face ID.

RN 0.81's minimum deployment target is iOS 15.1 (leave the Podfile default). `react-native-mmkv`,
`react-native-keychain`, `react-native-svg`, `react-native-screens`, and gesture-handler/reanimated are
all autolinked by `pod install` — no manual linking.

### Install on your iPhone (physical device)

```bash
# Plug in the iPhone, trust the Mac, then open the workspace:
open ios/Bitty.xcworkspace
```

In Xcode:

1. Select the **Bitty** target → **Signing & Capabilities**.
2. Set **Team** to your Apple ID (add it under Xcode → Settings → Accounts if needed — a free account
   works for personal-device installs).
3. Change the **Bundle Identifier** to something unique, e.g. `com.<you>.bittyvault`.
4. Pick your iPhone from the device dropdown (top bar) and press **▶ Run**.
5. First launch: on the iPhone, **Settings → General → VPN & Device Management → trust** your developer
   certificate. Then reopen the app.

Or from the CLI once signing is set:

```bash
npm run ios -- --device "Your iPhone Name"
```

Notes:
- A **free** Apple developer account expires the build after 7 days (reinstall to renew); a paid account
  lasts a year. Either works.
- The app talks to the production backend (`https://bitty.io`) over HTTPS for relaying/quotes — the phone
  just needs internet, no local server.
- Import your existing recovery phrase on first run to see your real vault; or create a new wallet to
  test with a counterfactual (pre-activation) vault.

## Reuse from `web/`

The mobile app is a **client of the same backend**: the existing Next.js API routes stay on the server
and are called over HTTP (`src/core/chain.ts` → `apiUrl(path, network)`), matching the web `?network=`
convention. Platform-agnostic logic (config addresses, ABIs, viem read/write) is vendored under
`src/core` for now; a shared `packages/core` gets extracted once the surface stabilizes, so web and
mobile stop drifting.

## Architecture

```
index.js            polyfills → gesture-handler → register App
src/App.tsx         status gate: no-wallet → Onboarding | locked → Lock | unlocked → nav stack
src/wallet/         embedded keyring (Keychain) + zustand session store
src/core/chain.ts   viem clients, guard/factory addresses, API base
src/core/           chain, assets, protocols, abi, prices, predict-vault, network-store, cow, …
src/vault/          read/write layer per feature (actions, trade, limit, twap, lp, payments,
                    autoyield, gasless, manage, delegate, risk, upgrade-adapter) + hooks
src/screens/        21 screens (Onboarding … Security)
src/components/      Button, AmountInput, NetworkSwitcher
```

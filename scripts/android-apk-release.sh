#!/usr/bin/env bash
#
# Build the signed Android APK that bitty.io offers as a direct download (beside Google Play), and,
# with --publish, put it up for that download.
#
#   scripts/android-apk-release.sh            # build and verify only
#   scripts/android-apk-release.sh --publish  # …then upload it
#
# Signed with the same upload key as the Play bundle (scripts/android-play-release.sh):
# android/keystore.properties plus the keystore it names, both gitignored, so they are copied by hand
# to the Mac that builds. Same key means a phone can move between the APK and Play without
# reinstalling.
#
# Built for arm64-v8a and armeabi-v7a only: every Android phone, about half the size of the
# four-ABI build (x86/x86_64 are emulators and a few Chromebooks).
#
# Where it is published: the GitHub release `android-latest` on BittyIO/mobile, asset `bitty.apk`,
# replaced on every publish so its URL never changes. bitty.io/download/android redirects there. A
# copy also goes to the release `android-v<version>`, so older builds stay downloadable.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "error: $*" >&2; exit 1; }

PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

# ── Source ────────────────────────────────────────────────────────────────────────────────────────
BRANCH=$(git branch --show-current)
echo "==> Branch: $BRANCH ($(git rev-parse --short HEAD))"
[ -z "$(git status --porcelain)" ] || fail "uncommitted changes: commit or stash them so the APK matches the branch."
git fetch -q origin "$BRANCH" 2>/dev/null && {
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] ||
    fail "this branch differs from origin/$BRANCH: pull (or push) first."
}

# ── Toolchain ─────────────────────────────────────────────────────────────────────────────────────
# JDK 17: the one on PATH, else Android Studio's bundled JBR.
if ! java -version 2>&1 | grep -qE 'version "(17|21)'; then
  JBR="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  if [ -x "$JBR/bin/java" ]; then
    export JAVA_HOME="$JBR"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
fi
java -version 2>&1 | grep -qE 'version "(17|21)' || fail "JDK 17 not found: install Android Studio (bundled JBR) or Zulu 17."
echo "==> Java: $(java -version 2>&1 | head -1)"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$ANDROID_HOME/platforms/android-36" ] || fail "Android SDK 36 not found under $ANDROID_HOME: install it in Android Studio → SDK Manager (or set ANDROID_HOME)."
BUILD_TOOLS="$ANDROID_HOME/build-tools/36.0.0"
[ -d "$BUILD_TOOLS" ] || fail "build-tools 36.0.0 missing: Android Studio → SDK Manager → SDK Tools."
[ -d "$ANDROID_HOME/ndk/27.1.12297006" ] || fail "NDK 27.1.12297006 missing: Android Studio → SDK Manager → SDK Tools → NDK (Side by side)."
command -v node >/dev/null || fail "node not found (>= 20): Gradle runs it to bundle the JS."
echo "==> Node: $(node -v), Android SDK: $ANDROID_HOME"
if [ $PUBLISH = 1 ]; then
  command -v gh >/dev/null || fail "gh not found: brew install gh, then gh auth login (needed for --publish)."
  gh auth status >/dev/null 2>&1 || fail "gh is not logged in: run gh auth login."
fi

# ── Upload key ────────────────────────────────────────────────────────────────────────────────────
PROPS=android/keystore.properties
[ -f "$PROPS" ] || fail "$PROPS missing: copy it and the keystore it names from the Mac that has them."
STORE_FILE=$(grep -E '^storeFile=' "$PROPS" | cut -d= -f2-)
[ -n "$STORE_FILE" ] && [ -f "android/$STORE_FILE" ] || fail "the keystore $PROPS names (android/$STORE_FILE) is not there."

# ── Build ─────────────────────────────────────────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version")
CODE=$(node -p "const [a,b,c]=require('./package.json').version.split('.').map(Number); a*10000+b*100+c")
echo "==> Installing JS dependencies"
npm ci
echo "==> Building assembleRelease $VERSION (versionCode $CODE), arm64-v8a + armeabi-v7a"
# No `clean`: it wipes the native libraries' prefab packages (react-native-vision-camera) before the
# app's CMake configure needs them, and the build fails with "prefab … is not readable".
(cd android && ./gradlew --no-daemon assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a)

APK=android/app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || fail "the build finished but $APK is not there."
OUT="android/app/build/outputs/apk/release/bitty-$VERSION-$CODE.apk"
cp "$APK" "$OUT"

# Signed with the upload key, not the debug one: a debug-signed APK installs, but every later
# release-signed one then refuses to install over it.
CERT=$("$BUILD_TOOLS/apksigner" verify --print-certs "$OUT") || fail "$OUT is not signed."
echo "$CERT" | grep -q "CN=Android Debug" && fail "$OUT is signed with the DEBUG key: check $PROPS."
SHA=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
SIZE=$(du -h "$OUT" | cut -f1)
echo "==> Signed by: $(echo "$CERT" | grep -m1 'certificate DN' | sed 's/^.*DN: //')"
echo "    Cert SHA-256: $(echo "$CERT" | grep -m1 'certificate SHA-256' | sed 's/^.*digest: //')"
echo "    APK SHA-256:  $SHA ($SIZE)"

if [ $PUBLISH = 0 ]; then
  echo
  echo "Done: $OUT"
  echo "Install it on a phone: adb install -r $OUT   — or run again with --publish to put it on bitty.io."
  exit 0
fi

# ── Publish ───────────────────────────────────────────────────────────────────────────────────────
REPO=BittyIO/mobile
COMMIT=$(git rev-parse HEAD)
NOTES="Bitty $VERSION (versionCode $CODE), built from $BRANCH @ ${COMMIT:0:7}.

APK SHA-256: \`$SHA\`"
STAGE=$(mktemp -d)
cp "$OUT" "$STAGE/bitty.apk"
cp "$OUT" "$STAGE/bitty-$VERSION.apk"

publish() { # tag title asset
  if gh release view "$1" -R "$REPO" >/dev/null 2>&1; then
    gh release edit "$1" -R "$REPO" --title "$2" --notes "$NOTES" --prerelease >/dev/null
    gh release upload "$1" -R "$REPO" "$3" --clobber
  else
    gh release create "$1" -R "$REPO" --target "$COMMIT" --title "$2" --notes "$NOTES" --prerelease --latest=false "$3"
  fi
}
echo "==> Publishing to $REPO"
publish "android-v$VERSION" "Android $VERSION" "$STAGE/bitty-$VERSION.apk"
publish "android-latest" "Android (latest download)" "$STAGE/bitty.apk"
rm -rf "$STAGE"

URL="https://github.com/$REPO/releases/download/android-latest/bitty.apk"
echo
echo "Done: $OUT"
echo "Published: $URL"
echo "bitty.io/download/android points there."
